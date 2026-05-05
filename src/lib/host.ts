// Host / portal detection for the multi-subdomain setup.
//   teachers.lingualinkonline.com  → 'teacher'
//   students.lingualinkonline.com  → 'student'
//   admin.lingualinkonline.com     → 'admin'
// Anything else (localhost, *.vercel.app, apex) → 'any' — no portal enforcement.

export type Portal = 'teacher' | 'student' | 'admin' | 'any'

export const SHARED_COOKIE_DOMAIN = '.lingualinkonline.com'

function normalizeHost(host: string | null | undefined): string {
  if (!host) return ''
  return host.split(':')[0].toLowerCase()
}

export function getPortal(host: string | null | undefined): Portal {
  const hostname = normalizeHost(host)
  if (hostname === 'teachers.lingualinkonline.com') return 'teacher'
  if (hostname === 'students.lingualinkonline.com') return 'student'
  if (hostname === 'admin.lingualinkonline.com') return 'admin'
  return 'any'
}

// True for the production apex + production subdomains. False for localhost,
// *.vercel.app preview deploys, and anything else — those must not get a
// shared-domain cookie or the browser would refuse it (or the cookie would
// leak to subdomains we don't control).
export function isProductionHost(host: string | null | undefined): boolean {
  const hostname = normalizeHost(host)
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false
  if (hostname.endsWith('.vercel.app')) return false
  return hostname === 'lingualinkonline.com' || hostname.endsWith('.lingualinkonline.com')
}

export function expectedPortal(pathname: string): Portal {
  if (pathname.startsWith('/api/')) return 'any'
  if (pathname === '/') return 'any'
  if (pathname.startsWith('/student/')) return 'student'
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin'
  return 'teacher'
}

export function portalUrl(portal: Portal): string {
  if (portal === 'student') return process.env.NEXT_PUBLIC_STUDENT_URL ?? ''
  if (portal === 'admin')   return process.env.NEXT_PUBLIC_ADMIN_URL   ?? ''
  return process.env.NEXT_PUBLIC_TEACHER_URL ?? ''
}

// Sign-in for admin users lives on the teacher portal — there's no /login route
// under the (admin) group. So student paths go to the student login, everything
// else (teacher + admin) goes to the teacher login.
export function loginUrlForPath(pathname: string): string {
  if (pathname.startsWith('/student/')) {
    return `${process.env.NEXT_PUBLIC_STUDENT_URL ?? ''}/student/login`
  }
  return `${process.env.NEXT_PUBLIC_TEACHER_URL ?? ''}/login`
}
