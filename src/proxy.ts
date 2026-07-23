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

  // Copy the auth cookies Supabase wrote onto the tracked `response` (via the
  // setAll callback below) onto a redirect/rewrite response, so short-circuit
  // returns don't drop refreshed session tokens. Reads `response` at call time
  // because setAll reassigns it.
  const withAuthCookies = <T extends NextResponse>(res: T): T => {
    response.cookies.getAll().forEach((cookie) => {
      res.cookies.set(cookie.name, cookie.value, cookie)
    })
    return res
  }

  // ── Legacy host-only sb-cookie cleanup ──────────────────────────────────────
  // Pre-7b7ffba code wrote sb-* auth cookies host-only on production subdomains.
  // Those legacy cookies coexist with the current domain-scoped writes and
  // shadow them per RFC 6265 §5.3 (cookies keyed by name, domain, path), which
  // breaks cross-subdomain auth — most visibly the cross-portal password reset
  // (recovery session on .lingualinkonline.com is masked by a stale host-only
  // refresh token, producing a 400 spam loop on getUser).
  //
  // We can't run this fix-up inline with the Supabase setAll callback because
  // setAll reassigns `response` on every refresh, wiping any cookies we wrote
  // before it. Instead: short-circuit with a redirect-to-self, write host-only
  // clearing cookies on the redirect (no Domain attribute → matches only the
  // (name, <request host>, /) tuple, leaves the domain-scoped legitimate
  // cookies alone), then mark the session as cleaned via a domain-scoped flag.
  //
  // GET-only so we never drop a POST body. Production-only because non-prod
  // hosts have no shared-domain cookie to shadow. Flag-gated so each browser
  // pays the redirect cost at most once.
  if (
    request.method === 'GET' &&
    cookieDomain &&
    !request.cookies.has('ll_legacy_cleared') &&
    request.cookies.getAll().some((c) => c.name.startsWith('sb-'))
  ) {
    const cleanResponse = NextResponse.redirect(request.nextUrl)
    for (const cookie of request.cookies.getAll()) {
      if (!cookie.name.startsWith('sb-')) continue
      cleanResponse.cookies.set({
        name: cookie.name,
        value: '',
        path: '/',
        maxAge: 0,
      })
    }
    cleanResponse.cookies.set('ll_legacy_cleared', '1', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 365,
      domain: cookieDomain,
    })
    return cleanResponse
  }

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
    return withAuthCookies(NextResponse.rewrite(new URL('/student/login', request.url)))
  }

  const expected = expectedPortal(pathname)
  if (portal !== 'any' && expected !== 'any' && portal !== expected) {
    const target = portalUrl(expected)
    if (target) {
      return withAuthCookies(
        NextResponse.redirect(`${target}${pathname}${request.nextUrl.search}`)
      )
    }
  }

  // Cron routes use bearer-token auth (CRON_SECRET) and have no Supabase
  // session — they must remain reachable here without a logged-in user.
  // /api/keep-alive likewise. The Resend webhook is called by Resend (no
  // Supabase session) and self-authenticates via its HMAC signature, so it
  // must stay public to this session gate too. Every other /api/* route now
  // flows through the session check below; each one already calls
  // supabase.auth.getUser() at the top and returns 401 itself if needed.
  const PUBLIC_API_PATHS = new Set([
    '/api/cron/class-reminders',
    '/api/cron/low-hours-warning',
    '/api/cron/invoice-reminder',
    '/api/cron/report-overdue',
    '/api/cron/training-ending-soon',
    '/api/keep-alive',
    '/api/webhooks/resend',
  ])

  const isPublicPath =
    pathname === '/login' ||
    pathname === '/student/login' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname === '/student/forgot-password' ||
    pathname === '/student/reset-password' ||
    PUBLIC_API_PATHS.has(pathname)

  if (!isPublicPath && !user) {
    const loginUrl = new URL(loginUrlForPath(pathname))
    loginUrl.searchParams.set('returnUrl', pathname)
    return withAuthCookies(NextResponse.redirect(loginUrl))
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

        // Build the redirect, but preserve the cookie state Supabase wrote onto
        // `response` (where Supabase wrote auth-cookie clears)
        const redirectResponse = withAuthCookies(NextResponse.redirect(loginUrl))
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
            : new URL('/upcoming-classes', request.url)
          return withAuthCookies(NextResponse.redirect(target))
        }
        if (hasStudent && !hasProfile && !pathname.startsWith('/student/')) {
          const studentBase = portalUrl('student')
          const target = isProductionHost(host) && studentBase
            ? `${studentBase}/student/my-classes`
            : new URL('/student/my-classes', request.url)
          return withAuthCookies(NextResponse.redirect(target))
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
