import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  SHARED_COOKIE_DOMAIN,
  expectedPortal,
  getPortal,
  isProductionHost,
  loginUrlForPath,
  portalUrl,
} from '@/lib/host'

export async function proxy(request: NextRequest) {
  const host = request.headers.get('host')
  const cookieDomain = isProductionHost(host) ? SHARED_COOKIE_DOMAIN : undefined

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
            response.cookies.set(
              name,
              value,
              cookieDomain ? { ...options, domain: cookieDomain } : options
            )
          )
        },
      },
    }
  )

  // Refresh the session — writes updated auth cookies onto the response
  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // ── Portal-mismatch redirect ────────────────────────────────────────────────
  // Wrong subdomain for this path? Bounce to the canonical host, preserving
  // path + query. Skipped on non-production hosts (localhost, vercel preview,
  // apex) — those serve every portal so dev/preview Just Works.
  const portal = getPortal(host)

  // Student subdomain serves the student login form at /login
  if (pathname === '/login' && portal === 'student') {
    return NextResponse.rewrite(new URL('/student/login', request.url))
  }

  // Admin subdomain: rewrite clean URLs to /admin/* so the (admin)/admin/*
  // route group is served transparently. Excludes /api/* (API routes are
  // path-based, not subdomain-prefixed) and /login (admin uses teacher
  // portal login — the unauth redirect below will route correctly).
  if (
    portal === 'admin' &&
    !pathname.startsWith('/admin') &&
    !pathname.startsWith('/api') &&
    pathname !== '/login'
  ) {
    const newPath = pathname === '/' ? '/admin' : `/admin${pathname}`
    return NextResponse.rewrite(new URL(newPath, request.url))
  }

  const expected = expectedPortal(pathname)
  if (portal !== 'any' && expected !== 'any' && portal !== expected) {
    const target = portalUrl(expected)
    if (target) {
      return NextResponse.redirect(`${target}${pathname}${request.nextUrl.search}`)
    }
  }

  // Cron routes use bearer-token auth (CRON_SECRET) and have no Supabase
  // session — they must remain reachable here without a logged-in user.
  // /api/keep-alive likewise. Every other /api/* route now flows through the
  // session check below; each one already calls supabase.auth.getUser() at
  // the top and returns 401 itself if needed.
  const PUBLIC_API_PATHS = new Set([
    '/api/cron/class-reminders',
    '/api/cron/low-hours-warning',
    '/api/cron/invoice-reminder',
    '/api/cron/report-overdue',
    '/api/cron/training-ending-soon',
    '/api/keep-alive',
  ])

  const isPublicPath =
    pathname === '/login' ||
    pathname === '/student/login' ||
    pathname === '/student/forgot-password' ||
    pathname === '/student/reset-password' ||
    PUBLIC_API_PATHS.has(pathname)

  if (!isPublicPath && !user) {
    const loginUrl = new URL(loginUrlForPath(pathname))
    loginUrl.searchParams.set('returnUrl', pathname)
    return NextResponse.redirect(loginUrl)
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
      let hasProfile = false
      let hasStudent = false

      // Try profiles first — teachers and admins (profiles.id === auth user id)
      const { data: profile } = await adminDb
        .from('profiles')
        .select('status')
        .eq('id', user.id)
        .maybeSingle()

      if (profile) {
        hasRecord = true
        hasProfile = true
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
          hasStudent = true
          status = student.status ?? null
        }
      }

      const blocked = !hasRecord || status === 'former' || status === 'on_hold'

      if (blocked) {
        await supabase.auth.signOut()
        const loginUrl = new URL(loginUrlForPath(pathname))
        loginUrl.searchParams.set('error', 'account_inactive')

        // Build the redirect, but preserve the cookie state Supabase wrote onto `response`
        const redirectResponse = NextResponse.redirect(loginUrl)
        // Copy all Set-Cookie headers from `response` (where Supabase wrote auth-cookie clears)
        response.cookies.getAll().forEach((cookie) => {
          redirectResponse.cookies.set(cookie.name, cookie.value, cookie)
        })
        // Delete our own cache cookie on top of whatever Supabase set — must
        // include `domain` so the browser clears the domain-scoped cookie, not
        // a phantom host-only one.
        redirectResponse.cookies.set({
          name: 'll_status_checked_at',
          value: '',
          path: '/',
          maxAge: 0,
          ...(cookieDomain ? { domain: cookieDomain } : {}),
        })
        return redirectResponse
      }

      // ── Role-based portal gate ────────────────────────────────────────────
      // A user with a profiles row (teacher/admin) must not browse student-
      // portal pages; a student-only user (students row, no profiles row)
      // must not browse teacher/admin pages. We don't gate '/' (root landing)
      // or any /api/* route — those are intentionally cross-portal. Public
      // paths are already excluded by the !isPublicPath branch we're in.
      if (pathname !== '/' && !pathname.startsWith('/api/')) {
        if (hasProfile && pathname.startsWith('/student/')) {
          const teacherBase = portalUrl('teacher')
          const target = isProductionHost(host) && teacherBase
            ? `${teacherBase}/upcoming-classes`
            : '/upcoming-classes'
          return NextResponse.redirect(target)
        }
        if (hasStudent && !hasProfile && !pathname.startsWith('/student/')) {
          const studentBase = portalUrl('student')
          const target = isProductionHost(host) && studentBase
            ? `${studentBase}/student/my-classes`
            : '/student/my-classes'
          return NextResponse.redirect(target)
        }
      }

      // Status is current — stamp the cache cookie so we skip the DB hit for 60 s
      response.cookies.set('ll_status_checked_at', String(now), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        ...(cookieDomain ? { domain: cookieDomain } : {}),
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
