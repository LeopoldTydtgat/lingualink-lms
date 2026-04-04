import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

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

  // getUser() validates the session on every request
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // ── Teacher / Admin routes (root-level dashboard pages) ────────────
  const teacherPaths = [
    '/dashboard',
    '/upcoming-classes',
    '/reports',
    '/schedule',
    '/students',
    '/messages',
    '/study-sheets',
    '/billing',
    '/account',
  ]
  const isTeacherRoute = teacherPaths.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  if (isTeacherRoute && !user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // ── Student public pages (no auth required) ─────────────────────────
  // Login, forgot password, and reset password must stay accessible
  // to unauthenticated users
  const studentPublicPaths = [
    '/student/login',
    '/student/forgot-password',
    '/student/reset-password',
  ]
  const isStudentPublicPage = studentPublicPaths.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  // ── Student protected routes ─────────────────────────────────────────
  const isStudentRoute =
    pathname.startsWith('/student/') && !isStudentPublicPage

  if (isStudentRoute && !user) {
    return NextResponse.redirect(new URL('/student/login', request.url))
  }

  // ── Redirect already-authenticated users away from login pages ───────
  if (user && pathname === '/login') {
    return NextResponse.redirect(new URL('/upcoming-classes', request.url))
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}