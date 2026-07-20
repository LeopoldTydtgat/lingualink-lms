/**
 * THE canonical teacher rule - the single source of truth for "which profile
 * rows does the admin Teachers section list and manage":
 *
 *   isTeacher = account_types overlaps ['teacher', 'teacher_exam']
 *               OR role === 'admin'
 *
 * Three call sites MUST stay in agreement with this rule, or a profile becomes
 * visible in one place and unmanageable in another:
 *   - list page   src/app/(admin)/admin/teachers/page.tsx
 *   - list API    src/app/api/admin/teachers/route.ts          (GET)
 *   - target guard src/app/api/admin/teachers/[id]/route.ts    (PATCH)
 *
 * Use isTeacherProfile() when the row is already in memory; use
 * TEACHER_PROFILE_FILTER inside .or() for the equivalent PostgREST filter.
 *
 * This is NOT the same rule as requireTeacher() (src/lib/auth/requireTeacher.ts),
 * which additionally demands status === 'current' and deliberately excludes
 * admins. That one gates the teacher PORTAL; this one gates the admin Teachers
 * SECTION, which must still list archived and admin-role staff accounts.
 */

/**
 * PostgREST equivalent of isTeacherProfile(), for `.or(TEACHER_PROFILE_FILTER)`
 * on a `profiles` query.
 *
 * The overlap is written as one single-element `ov` term per teacher account
 * type rather than one two-element term: inside an `or=(...)` group PostgREST
 * splits on commas, so a comma INSIDE a `{...}` array literal would be read as
 * a term separator. `a.ov.{x},a.ov.{y}` is logically identical to `a.ov.{x,y}`
 * and cannot be misparsed.
 */
export const TEACHER_PROFILE_FILTER =
  'account_types.ov.{teacher},account_types.ov.{teacher_exam},role.eq.admin'

/**
 * In-memory form of the rule above. Accepts loosely-typed rows (a
 * `Record<string, unknown>` from a wide select is fine) and is fail-closed:
 * a null/undefined profile, or one with a non-array account_types, is not a
 * teacher.
 */
export function isTeacherProfile(
  profile: { role?: unknown; account_types?: unknown } | null | undefined
): boolean {
  if (profile?.role === 'admin') return true
  const types = profile?.account_types
  return (
    Array.isArray(types) &&
    (types.includes('teacher') || types.includes('teacher_exam'))
  )
}
