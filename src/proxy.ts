import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createAdminClient } from '@/lib/supabase/admin'

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh the session — writes updated auth cookies onto the response
  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  const isPublicPath =
    pathname === '/login' ||
    pathname === '/student/login' ||
    pathname.startsWith('/api/')

  if (!isPublicPath && !user) {
    const url = request.nextUrl.clone()
    url.pathname = pathname.startsWith('/student/') ? '/student/login' : '/login'
    url.search = ''
    url.searchParams.set('returnUrl', pathname)
    return NextResponse.redirect(url)
  }

  // ── Per-request status check with 60-second cookie cache ─────────────────────
  // Only runs for authenticated users on protected paths.
  if (!isPublicPath && user) {
    const checkedAt = request.cookies.get('ll_status_checked_at')?.value
    const now = Math.floor(Date.now() / 1000)
    const cacheValid = checkedAt && (now - parseInt(checkedAt, 10)) < 60

    if (!cacheValid) {
      const adminDb = createAdminClient()
      let status: string | null = null
      let hasRecord = false

      // Try profiles first — teachers and admins (profiles.id === auth user id)
      const { data: profile } = await adminDb
        .from('profiles')
        .select('status')
        .eq('id', user.id)
        .maybeSingle()

      if (profile) {
        hasRecord = true
        status = profile.status ?? null
      } else {
        // Fall back to students table (students.auth_user_id === auth user id)
        const { data: student } = await adminDb
          .from('students')
          .select('status')
          .eq('auth_user_id', user.id)
          .maybeSingle()

        if (student) {
          hasRecord = true
          status = student.status ?? null
        }
      }

      const blocked = !hasRecord || status === 'former' || status === 'on_hold'

      if (blocked) {
        await supabase.auth.signOut()
        const url = request.nextUrl.clone()
        url.pathname = pathname.startsWith('/student/') ? '/student/login' : '/login'
        url.search = ''
        url.searchParams.set('error', 'account_inactive')

        // Build the redirect, but preserve the cookie state Supabase wrote onto `response`
        const redirectResponse = NextResponse.redirect(url)
        // Copy all Set-Cookie headers from `response` (where Supabase wrote auth-cookie clears)
        response.cookies.getAll().forEach((cookie) => {
          redirectResponse.cookies.set(cookie.name, cookie.value, cookie)
        })
        // Delete our own cache cookie on top of whatever Supabase set
        redirectResponse.cookies.delete('ll_status_checked_at')
        return redirectResponse
      }

      // Status is current — stamp the cache cookie so we skip the DB hit for 60 s
      response.cookies.set('ll_status_checked_at', String(now), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      })
    }
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
