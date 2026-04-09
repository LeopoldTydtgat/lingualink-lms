import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function middleware(request: NextRequest) {
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

  // â”€â”€ Admin routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname.startsWith('/admin')) {
    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      // Authenticated but not admin â€” send to teacher dashboard
      return NextResponse.redirect(new URL('/upcoming-classes', request.url))
    }
  }

  // â”€â”€ Teacher / Admin routes (root-level dashboard pages) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Student public pages (no auth required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const studentPublicPaths = [
    '/student/login',
    '/student/forgot-password',
    '/student/reset-password',
  ]
  const isStudentPublicPage = studentPublicPaths.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  // â”€â”€ Student protected routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const isStudentRoute =
    pathname.startsWith('/student/') && !isStudentPublicPage

  if (isStudentRoute && !user) {
    return NextResponse.redirect(new URL('/student/login', request.url))
  }

  // â”€â”€ Redirect already-authenticated users away from login pages â”€â”€â”€â”€â”€â”€â”€
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