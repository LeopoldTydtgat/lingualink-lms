import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { fetchLessonRateMap } from '@/lib/billing/lessonRates'
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
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── 2. Parse and validate request body ───────────────────────────────────
    const body = await req.json()
    const teacherIds: string[] = Array.isArray(body.teacherIds) ? body.teacherIds : []
    const studentIds: string[] = Array.isArray(body.studentIds) ? body.studentIds : []
    const lessonIds: string[] = Array.isArray(body.lessonIds) ? body.lessonIds : []

    if (teacherIds.length === 0 && studentIds.length === 0 && lessonIds.length === 0) {
      return NextResponse.json({ teachers: [], students: [], lessonRates: [] })
    }

    // ── 3. Fetch sensitive data using service role client ────────────────────
    const adminClient = createAdminClient()

    const [teacherResult, studentResult, rateMap] = await Promise.all([
      teacherIds.length > 0
        ? adminClient
            .from('profiles')
            .select('id, full_name, hourly_rate, currency')
            .in('id', teacherIds)
        : Promise.resolve({ data: [], error: null }),

      studentIds.length > 0
        ? adminClient
            .from('students')
            .select('id, full_name, company_id, cancellation_policy')
            .in('id', studentIds)
        : Promise.resolve({ data: [], error: null }),

      // Per-lesson pay rate snapshots (deny-all RLS → service role only). Returns raw
      // snapshot rates keyed by lesson; the caller composes the profiles.hourly_rate
      // fallback for lessons absent from the map (NEW268 D1).
      fetchLessonRateMap(adminClient, lessonIds),
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
      lessonRates: Array.from(rateMap, ([lesson_id, hourly_rate]) => ({ lesson_id, hourly_rate })),
    })
  } catch (err) {
    console.error('Billing entities route error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
