// Host / portal detection for the multi-subdomain setup.
//   teachers.lingualinkonline.com  → 'teacher'
//   students.lingualinkonline.com  → 'student'
// Anything else (localhost, *.vercel.app, apex) → 'any' — no portal enforcement.

export type Portal = 'teacher' | 'student' | 'any'

// SECURITY (M-14): Sharing cookies across all *.lingualinkonline.com subdomains
// exposes session tokens to any other subdomain (e.g., www, marketing). If a
// non-portal subdomain serves user content or runs third-party JS, those scripts
// could read the auth cookie. Confirm with admin which subdomains exist before
// go-live, and either narrow this to specific subdomains or move auth onto a
// path-isolated single host.
export const SHARED_COOKIE_DOMAIN = '.lingualinkonline.com'

function normalizeHost(host: string | null | undefined): string {
  if (!host) return ''
  return host.split(':')[0].toLowerCase()
}

export function getPortal(host: string | null | undefined): Portal {
  const hostname = normalizeHost(host)
  if (hostname === 'teachers.lingualinkonline.com') return 'teacher'
  if (hostname === 'students.lingualinkonline.com') return 'student'
  return 'any'
}

// True for the production apex + production subdomains. False for localhost,
// *.vercel.app preview deploys, and anything else — those must not get a
// shared-domain cookie or the browser would refuse it (or the cookie would
// leak to subdomains we don't control).
//
// SECURITY (M-23): Any unrecognised *.lingualinkonline.com subdomain currently
// gets production-scope cookies via `endsWith('.lingualinkonline.com')`. If a
// new subdomain is added (a marketing site, status page, internal tool, etc.),
// it will inherit auth cookies even though it has nothing to do with the LMS.
// Decide for each new subdomain whether it should serve a portal or 404 here,
// and tighten this check to an allowlist if untrusted subdomains are added.
export function isProductionHost(host: string | null | undefined): boolean {
  const hostname = normalizeHost(host)
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false
  if (hostname.endsWith('.vercel.app')) return false
  return hostname === 'lingualinkonline.com' || hostname.endsWith('.lingualinkonline.com')
}

export function expectedPortal(pathname: string): Portal {
  if (pathname === '/login') return 'any'
  if (pathname.startsWith('/api/')) return 'any'
  if (pathname === '/') return 'any'
  if (pathname.startsWith('/student/')) return 'student'
  return 'teacher'
}

export function portalUrl(portal: Portal): string {
  if (portal === 'student') return process.env.NEXT_PUBLIC_STUDENT_URL ?? ''
  return process.env.NEXT_PUBLIC_TEACHER_URL ?? ''
}

// Student paths use the student login; everything else uses the teacher login.
export function loginUrlForPath(pathname: string): string {
  if (pathname.startsWith('/student/')) {
    return `${process.env.NEXT_PUBLIC_STUDENT_URL ?? ''}/student/login`
  }
  return `${process.env.NEXT_PUBLIC_TEACHER_URL ?? ''}/login`
}
