import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import EditStudentClient from './EditStudentClient'

type TeacherOption = { id: string; full_name: string; statusLabel?: string }

// Backfilled profiles sit outside the strict teacher/admin + status='current'
// filter by definition, so every one of them carries a label. profiles.role is
// CHECK-constrained to teacher/admin (live DB, verified this session), so
// status is the only thing that can exclude a profile. 'former' and 'on_hold'
// are the known statuses; anything else — a status value added later — still
// falls back to '(inactive)' rather than passing as current.
function statusLabelFor(status: string | null): string {
  if (status === 'former') return '(former)'
  if (status === 'on_hold') return '(on hold)'
  return '(inactive)'
}

export default async function EditStudentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  const { id } = await params

  // The param feeds every query below and is handed to the client as the PATCH
  // target, so it must be proven to be a uuid before ANY query runs — same gate
  // as students/[id]/page.tsx. A non-uuid id can never match a row, so
  // notFound() is the correct outcome as well as the safe one.
  if (!z.string().uuid().safeParse(id).success) notFound()

  const supabase = createAdminClient()

  // Fetch the student row — includes sensitive admin-only fields. Explicit
  // column list, never select('*'): students carries column-level REVOKEs.
  // These are exactly the columns EditStudentClient reads; extend the list only
  // when the form starts using another one.
  const { data: student, error } = await supabase
    .from('students')
    .select(
      'id, full_name, email, date_of_birth, phone, timezone, language_preference, status, customer_number, is_private, company_id, academic_advisor_id, native_language, learning_language, current_fluency_level, self_assessed_level, learning_goals, interests, cancellation_policy, admin_notes, teacher_notes'
    )
    .eq('id', id)
    .single()

  if (error || !student) notFound()

  // Fetch active training + assigned teachers for this student.
  //
  // A failed read must NOT fall through to the "no active training" state: that
  // notice tells the admin this student has none, and the form then hides every
  // training field and omits them from the PATCH. Empty-because-none and
  // empty-because-the-query-broke are different outcomes, so the failure is
  // surfaced to the client instead of being silently rendered as "none".
  const { data: trainings, error: trainingsError } = await supabase
    .from('trainings')
    .select(`
      id,
      package_name,
      package_type,
      total_hours,
      hours_consumed,
      end_date,
      status,
      training_teachers (
        teacher_id
      )
    `)
    .eq('student_id', id)
    .order('created_at', { ascending: false })

  if (trainingsError) {
    console.error('[student edit] trainings query failed:', trainingsError)
  }
  const trainingsLoadFailed = Boolean(trainingsError)

  const trainingsArr = Array.isArray(trainings) ? trainings : []
  const activeTrain = trainingsArr.find((t) => t.status === 'active') ?? trainingsArr[0] ?? null

  // Extract assigned teacher IDs from the active training
  const assignedTeacherIds: string[] = []
  if (activeTrain) {
    const ttArr = Array.isArray(activeTrain.training_teachers)
      ? activeTrain.training_teachers
      : []
    for (const tt of ttArr) {
      if (tt.teacher_id && !assignedTeacherIds.includes(tt.teacher_id)) {
        assignedTeacherIds.push(tt.teacher_id)
      }
    }
  }

  // Fetch all active companies for the dropdown
  const { data: companies, error: companiesError } = await supabase
    .from('companies')
    .select('id, name')
    .eq('status', 'active')
    .order('name')

  // Fetch current teachers and admins for the academic-advisor dropdown and the
  // assigned-teachers toggle — same role/status filter as students/new/page.tsx,
  // so an archived profile is never offered as a NEW pick. Profiles this student
  // already references are added back below; nothing else gets in.
  const { data: teachers, error: teachersError } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('role', ['teacher', 'admin'])
    .eq('status', 'current')
    .order('full_name')

  const teacherOptions: TeacherOption[] = (teachers ?? []).map(
    (t: { id: string; full_name: string }) => ({ id: t.id, full_name: t.full_name })
  )

  // The strict filter above can exclude a profile this student still points at:
  // an academic advisor who has since been archived, or an assigned teacher on
  // the training. Their ids stay in the form state and are re-sent on every
  // save, so an option the select cannot match renders as a blank field that
  // silently rewrites the old value. Backfill them by id so they are visible
  // and can be cleared — the strict filter still governs everyone else.
  //
  // The two controls get SEPARATE lists. A profile backfilled because it is the
  // advisor must not become a newly assignable teacher (training_teachers is the
  // messaging/access junction — assigning a departed teacher would hand back a
  // live access edge), and vice versa. Each backfilled row is distributed only
  // to the control that already references it; an id that is both advisor and
  // assigned teacher legitimately lands in both.
  const advisorOptions: TeacherOption[] = [...teacherOptions]
  const assignmentOptions: TeacherOption[] = [...teacherOptions]

  const presentIds = new Set(teacherOptions.map((t) => t.id))
  const advisorId = (student.academic_advisor_id as string | null) ?? null
  const excludedAdvisorId = advisorId && !presentIds.has(advisorId) ? advisorId : null
  const excludedAssignedIds = assignedTeacherIds.filter((tid) => !presentIds.has(tid))
  const referencedIds = [
    ...new Set([...(excludedAdvisorId ? [excludedAdvisorId] : []), ...excludedAssignedIds]),
  ]

  let backfillFailed = false
  // Skip the backfill entirely when the base teachers read itself failed: with
  // an empty base list every referenced id looks excluded, and the backfill
  // would mislabel even current profiles. The form is already Save-blocked on
  // this path (lookupsLoadFailed trips on teachersError below), so running it
  // anyway is a wasted query producing wrong labels.
  if (!teachersError && teachers && referencedIds.length > 0) {
    const { data: referenced, error: referencedError } = await supabase
      .from('profiles')
      .select('id, full_name, status')
      .in('id', referencedIds)

    if (referencedError || !referenced) {
      console.error(
        '[student edit] referenced profiles backfill failed:',
        referencedError ?? 'query returned null data'
      )
      backfillFailed = true
    } else {
      const referencedRows = referenced as {
        id: string
        full_name: string
        status: string | null
      }[]

      // A referenced id with no profiles row cannot be rendered at all, so the
      // control falls back to the blank field that silently re-saves the stale
      // uuid — the exact failure this backfill exists to prevent. An incomplete
      // result is therefore treated like a failed query, not a partial success.
      if (referencedRows.length < referencedIds.length) {
        const foundIds = new Set(referencedRows.map((p) => p.id))
        console.error(
          '[student edit] referenced profile(s) not found:',
          referencedIds.filter((rid) => !foundIds.has(rid))
        )
        backfillFailed = true
      }

      for (const p of referencedRows) {
        const option: TeacherOption = {
          id: p.id,
          full_name: p.full_name,
          statusLabel: statusLabelFor(p.status),
        }
        if (p.id === excludedAdvisorId) advisorOptions.push(option)
        if (excludedAssignedIds.includes(p.id)) assignmentOptions.push(option)
      }
    }
  }

  // Either lookup failing renders as an empty dropdown, which reads as "there
  // are none" and invites a save that blanks the field. A null data payload is
  // the same unusable state as an error, so both fail the form closed; so does
  // a failed backfill, since the lists would then be missing a referenced row.
  if (companiesError) {
    console.error('[student edit] companies query failed:', companiesError)
  }
  if (teachersError) {
    console.error('[student edit] teachers query failed:', teachersError)
  }
  const lookupsLoadFailed = Boolean(
    companiesError || teachersError || !companies || !teachers || backfillFailed
  )

  return (
    <EditStudentClient
      student={student}
      activeTrain={activeTrain}
      assignedTeacherIds={assignedTeacherIds}
      companies={companies ?? []}
      advisorOptions={advisorOptions}
      assignmentOptions={assignmentOptions}
      trainingsLoadFailed={trainingsLoadFailed}
      lookupsLoadFailed={lookupsLoadFailed}
    />
  )
}
