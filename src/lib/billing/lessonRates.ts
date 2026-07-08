import type { createAdminClient } from '@/lib/supabase/admin'

// A service-role Supabase client. `lesson_rate_snapshots` is deny-all RLS, so it
// can ONLY be read via the admin client — never a browser/RLS-bound client. This
// module imports the admin client's TYPE only (`import type`), so it has no
// runtime dependency on the service key and is safe to bundle anywhere.
type AdminClient = ReturnType<typeof createAdminClient>

/**
 * NEW268 D1 — per-lesson teacher pay rate.
 *
 * Fetch the teacher hourly rate captured for each lesson at booking / teacher-swap
 * time from `lesson_rate_snapshots` (one row per lesson, maintained by DB trigger).
 *
 * Returns Map<lesson_id, rate>. A lesson is OMITTED from the map when it has no
 * snapshot row OR its snapshot `hourly_rate` is null — Decision A: both are treated
 * identically, so the caller falls back to profiles.hourly_rate via resolveLessonRate.
 *
 * MUST be called with a service-role admin client. Never returns 0, never throws:
 * on a query error it logs and returns an empty map so every lesson falls back.
 */
export async function fetchLessonRateMap(
  admin: AdminClient,
  lessonIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (lessonIds.length === 0) return map

  const { data, error } = await admin
    .from('lesson_rate_snapshots')
    .select('lesson_id, hourly_rate')
    .in('lesson_id', lessonIds)

  if (error) {
    console.error('[billing] lesson_rate_snapshots fetch failed; all lessons fall back to profiles.hourly_rate', error)
    return map
  }

  for (const row of data ?? []) {
    // Decision A: a null snapshot rate is treated as "no usable snapshot".
    if (row.hourly_rate != null) {
      map.set(row.lesson_id as string, Number(row.hourly_rate))
    }
  }
  return map
}

/**
 * Resolve one lesson's teacher pay rate: the snapshot rate when present, otherwise
 * `fallbackRate` (the teacher's live profiles.hourly_rate) with a console.error
 * naming the lesson. Never returns 0 on the fallback path unless `fallbackRate`
 * itself is 0 (pre-existing behaviour when a teacher has no live rate). Never throws.
 */
export function resolveLessonRate(
  rateMap: Map<string, number>,
  lessonId: string,
  fallbackRate: number
): number {
  const snap = rateMap.get(lessonId)
  if (snap != null) return snap
  console.error('[billing] no rate snapshot for lesson; falling back to live profiles.hourly_rate', { lesson_id: lessonId })
  return fallbackRate
}
