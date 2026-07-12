import { createBrowserClient } from '@supabase/ssr'
import { SHARED_COOKIE_DOMAIN, isProductionHost } from '@/lib/host'

// We pass a custom cookie adapter so browser-side writes (silent token
// refresh, signInWithPassword for re-auth on the account page) get
// `domain=.lingualinkonline.com` in production. Without this, the browser
// would write host-only cookies that conflict with the proxy's domain-scoped
// cookies — both get sent on subsequent requests and Supabase's "first one
// wins" cookie read can flap between stale and fresh tokens.
//
// Kept as a standalone builder so the singleton below can take its type from
// `ReturnType<typeof buildBrowserClient>`. That resolves to the concrete client
// type this call produces (SchemaName pinned to "public"). Typing the singleton
// as `ReturnType<typeof createBrowserClient>` instead would read that overloaded
// import's broad signature and widen SchemaName, degrading realtime/query
// callback payloads to `any` for every consumer of createClient().
function buildBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          if (typeof document === 'undefined') return []
          return parseCookieHeader(document.cookie)
        },
        setAll(cookiesToSet) {
          if (typeof document === 'undefined') return
          const useDomain = isProductionHost(window.location.hostname)
          for (const { name, value, options } of cookiesToSet) {
            document.cookie = serializeCookie(
              name,
              value,
              options,
              useDomain ? SHARED_COOKIE_DOMAIN : undefined
            )
          }
        },
      },
    }
  )
}

// Single shared browser client. One client means one authenticated realtime
// socket shared by all components; setAuth (wired below on first construction)
// keeps that socket's JWT in sync with the session so RLS-filtered
// postgres_changes events are actually delivered instead of silently dropped.
let browserClient: ReturnType<typeof buildBrowserClient> | undefined

// Use this in any Client Component ('use client')
export function createClient() {
  if (browserClient) return browserClient

  browserClient = buildBrowserClient()

  // Wire realtime auth once, on first construction: seed the socket's JWT from
  // the current session, then keep it current across sign-in/out/refresh.
  browserClient.auth.getSession().then(({ data }) => {
    browserClient!.realtime.setAuth(data.session?.access_token ?? null)
  }).catch(() => {
    // Non-fatal: onAuthStateChange will sync the realtime JWT when a session lands.
  })
  browserClient.auth.onAuthStateChange((_event, session) => {
    browserClient!.realtime.setAuth(session?.access_token ?? null)
  })

  return browserClient
}

function parseCookieHeader(raw: string): Array<{ name: string; value: string }> {
  if (!raw) return []
  return raw
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const eq = c.indexOf('=')
      const name = eq < 0 ? c : c.slice(0, eq)
      const rawValue = eq < 0 ? '' : c.slice(eq + 1)
      try {
        return { name, value: decodeURIComponent(rawValue) }
      } catch {
        return { name, value: rawValue }
      }
    })
}

interface CookieSerializeOptions {
  domain?: string
  expires?: Date | string | number
  maxAge?: number
  path?: string
  sameSite?: boolean | 'lax' | 'strict' | 'none'
  secure?: boolean
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieSerializeOptions | undefined,
  domain: string | undefined
): string {
  let s = `${name}=${encodeURIComponent(value)}`
  if (domain) s += `; Domain=${domain}`
  s += `; Path=${options?.path ?? '/'}`
  if (options?.maxAge != null) s += `; Max-Age=${options.maxAge}`
  if (options?.expires) {
    const exp =
      options.expires instanceof Date
        ? options.expires
        : new Date(options.expires as string | number)
    s += `; Expires=${exp.toUTCString()}`
  }
  if (options?.sameSite) {
    const ss =
      options.sameSite === true
        ? 'Strict'
        : typeof options.sameSite === 'string'
          ? options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1)
          : 'Lax'
    s += `; SameSite=${ss}`
  }
  const isSecure =
    options?.secure ??
    (typeof window !== 'undefined' && window.location.protocol === 'https:')
  if (isSecure) s += `; Secure`
  return s
}
