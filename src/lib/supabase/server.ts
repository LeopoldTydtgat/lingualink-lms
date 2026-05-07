import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { SHARED_COOKIE_DOMAIN, isProductionHost } from '@/lib/host'

// Use this in Server Components, Server Actions, and Route Handlers
export async function createClient() {
  const cookieStore = await cookies()
  const host = (await headers()).get('host') ?? ''
  const cookieDomain = isProductionHost(host) ? SHARED_COOKIE_DOMAIN : undefined

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, cookieDomain ? { ...options, domain: cookieDomain } : options)
            )
          } catch {
            // Server Components can't set cookies — proxy handles session refresh
          }
        },
      },
    }
  )
}
