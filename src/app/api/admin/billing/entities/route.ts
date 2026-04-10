import { createServerClient } from '@supabase/ssr'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/admin/billing/entities
 *
 * Accepts arrays of teacher and student IDs and returns enriched data
 * including hourly_rate (teachers) and cancellation_policy (students).
 *
 * These fields are restricted at the database level for the authenticated
 * role. This route verifies admin status via session cookie, then uses the
 * service role client to fetch the sensitive columns server-side.
 *
 * Request body:
 *   { teacherIds: string[], studentIds: string[] }
 *
 * Response:
 *   {
 *     teachers: { id, full_name, hourly_rate }[],
 *     students: { id, full_name, company_id, cancellation_policy }[]
 *   }
 */
export async function POST(req: NextRequest) {
  try {
    // ── 1. Verify the requesting user is an admin via session cookie ──────────
    const cookieStore = await cookies()
    const sessionClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      }
    )

    const { data: { user }, error: authError } = await sessionClient.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const { data: profile } = await sessionClient
      .from('profiles')
      .select('role, account_types')
      .eq('id', user.id)
      .single()

    const isAdmin =
      profile?.role === 'admin' ||
      (profile?.account_types ?? []).includes('school_admin')

    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── 2. Parse and validate request body ───────────────────────────────────
    const body = await req.json()
    const teacherIds: string[] = Array.isArray(body.teacherIds) ? body.teacherIds : []
    const studentIds: string[] = Array.isArray(body.studentIds) ? body.studentIds : []

    if (teacherIds.length === 0 && studentIds.length === 0) {
      return NextResponse.json({ teachers: [], students: [] })
    }

    // ── 3. Fetch sensitive data using service role client ────────────────────
    const adminClient = createAdminClient()

    const [teacherResult, studentResult] = await Promise.all([
      teacherIds.length > 0
        ? adminClient
            .from('profiles')
            .select('id, full_name, hourly_rate')
            .in('id', teacherIds)
        : Promise.resolve({ data: [], error: null }),

      studentIds.length > 0
        ? adminClient
            .from('students')
            .select('id, full_name, company_id, cancellation_policy')
            .in('id', studentIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (teacherResult.error) {
      console.error('Billing entities — teacher fetch error:', teacherResult.error)
    }
    if (studentResult.error) {
      console.error('Billing entities — student fetch error:', studentResult.error)
    }

    return NextResponse.json({
      teachers: teacherResult.data ?? [],
      students: studentResult.data ?? [],
    })
  } catch (err) {
    console.error('Billing entities route error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
