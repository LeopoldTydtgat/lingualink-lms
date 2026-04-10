import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client for server-only admin operations.
 *
 * This client bypasses Row Level Security entirely. It must only be used
 * in server components and API route handlers that have already verified
 * the requesting user has admin role via the session/layout check.
 *
 * NEVER import this file in client components ('use client').
 * The service role key must never be exposed to the browser.
 *
 * AWS migration note: replace with an IAM-scoped RDS connection or
 * an admin-privileged Postgres role when migrating off Supabase.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
