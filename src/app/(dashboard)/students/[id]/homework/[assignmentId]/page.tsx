import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Annotation } from '@/components/pdf/PdfViewer'
import MaterialHomeworkViewer from './MaterialHomeworkViewer'

// ---------------------------------------------------------------------------
// Teacher's READ-ONLY view of ONE student's teaching-material homework layer.
//
// [id] is a trainings.id (same as the parent /students/[id] page), [assignmentId]
// is a material_assignments.id.
//
// This build writes NOTHING. There is no save action, no mutation route and no
// client callback anywhere on this path, and the database agrees: the only UPDATE
// policy on material_assignments is the student's own ("Students update own
// homework layer"), so a teacher write would be refused even if one existed.
//
// FOUR GATES, all fail-closed, in order:
//   1. The parent page's Condition B access gate, re-run here verbatim - an
//      upcoming scheduled lesson, or an open report, on a lesson THIS teacher
//      holds for THIS training. A sub-route must never be a way around the gate
//      on the page that links to it.
//   2. The material_assignments SELECT policy, on the USER-SCOPED client. Never
//      the service-role client: that policy (teacher-of-student via trainings /
//      get_teacher_training_ids()) is the only relationship check this read has.
//   3. student_id === the gated training's student. The RLS policy admits every
//      student this teacher teaches, so without this an assignment id belonging
//      to a DIFFERENT student would open under a training the teacher does hold.
//   4. revoked_at is null. The list already filters revoked grants; this closes
//      the direct-URL path, so the teacher view shows live grants only.
// ---------------------------------------------------------------------------

const UuidSchema = z.string().uuid()

interface Props {
  params: Promise<{ id: string; assignmentId: string }>
}

// Date-only, in the VIEWING TEACHER's account timezone, via Intl with an explicit
// locale. Never toISOString().slice() (that reports the UTC calendar day and is a
// day off either side of midnight for anyone east or west of UTC) and never
// toLocaleTimeString. This is a Server Component, so the string is produced once
// on the server and never re-derived in the browser - no hydration surface.
function formatAssignedDate(iso: string, timeZone: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(parsed)
}

// Page-range label. page_start / page_end are 1-based and inclusive; both null
// means the whole document. A half-null range is forbidden by the table's CHECK
// constraint but is labelled defensively rather than rendering an empty badge.
function pageRangeLabel(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null && pageEnd === null) return 'Whole document'
  if (pageStart !== null && pageEnd !== null) {
    return pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`
  }
  return `Page ${pageStart ?? pageEnd}`
}

export default async function StudentHomeworkPage({ params }: Props) {
  const { id, assignmentId } = await params

  // Non-uuid path segments can never name a row and would otherwise reach
  // Postgres as 22P02 cast errors and surface as 500s.
  if (!UuidSchema.safeParse(id).success) notFound()
  if (!UuidSchema.safeParse(assignmentId).success) notFound()

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  const isAdmin = profile?.role === 'admin'

  // Viewer's own zone for the instant label below (da9067b convention: profiles
  // timezone with a display-only UTC fallback - this is a maybeSingle'd profile,
  // not the fail-closed student-portal path).
  const viewerTz = profile?.timezone ?? 'UTC'

  // The training names the student. Service role mirrors the parent page: the
  // access decision is the Condition B gate below, never this read.
  const adminClient = createAdminClient()
  const { data: training, error: trainingError } = await adminClient
    .from('trainings')
    .select('id, students ( id, full_name )')
    .eq('id', id)
    .maybeSingle()

  if (trainingError) {
    console.error(
      `[dashboard/students/[id]/homework] trainings lookup failed (training ${id}):`,
      trainingError
    )
    throw new Error('Failed to load this homework')
  }
  if (!training) notFound()

  // Supabase returns nested joins as arrays - always flatten with Array.isArray().
  const studentRecord = (Array.isArray(training.students)
    ? training.students[0]
    : training.students) as { id: string; full_name: string | null } | null
  const studentId = studentRecord?.id
  if (!studentId) notFound()

  // --- GATE 1: non-admin access (Condition B only) --------------------------
  // Copied verbatim from (dashboard)/students/[id]/page.tsx so the two can never
  // drift apart: access requires an active booked-class relationship with THIS
  // training - an upcoming scheduled lesson, or an open report (pending in-window,
  // or reopened until completed) on a lesson this teacher personally holds.
  // Formal training_teachers assignment alone does not grant access. Falls closed:
  // no claim -> notFound().
  if (!isAdmin) {
    const gateNow = new Date()
    const { data: gateLessonsRaw } = await adminClient
      .from('lessons')
      .select('id, scheduled_at, status')
      .eq('training_id', id)
      .eq('teacher_id', user.id)

    type GateLessonRow = { id: string; scheduled_at: string | null; status: string }
    const gateLessons = (gateLessonsRaw ?? []) as GateLessonRow[]

    // B1: an upcoming scheduled lesson on this training held by this teacher.
    let hasActiveClaim = gateLessons.some(
      l => l.status === 'scheduled' && l.scheduled_at && new Date(l.scheduled_at) > gateNow
    )

    // B2: an open (pending/reopened) report on one of this teacher's lessons for this training.
    if (!hasActiveClaim && gateLessons.length > 0) {
      const gateLessonIds = gateLessons.map(l => l.id)
      const { data: gateReportsRaw } = await adminClient
        .from('reports')
        .select('status, deadline_at')
        .in('lesson_id', gateLessonIds)
        .in('status', ['pending', 'reopened'])

      // 'pending' counts only inside its window; 'reopened' counts until completed (stale deadline).
      type GateReportRow = { status: string; deadline_at: string | null }
      hasActiveClaim = ((gateReportsRaw ?? []) as GateReportRow[]).some(
        r => r.status === 'reopened' || (r.deadline_at && new Date(r.deadline_at) > gateNow)
      )
    }

    if (!hasActiveClaim) notFound()
  }

  // --- GATE 2: the grant itself, USER-SCOPED (RLS decides) ------------------
  // Explicit column list, never select('*'): material_assignments carries a
  // column-level UPDATE grant (annotations, updated_at only). maybeSingle -
  // zero rows is the expected "no such grant / not your student" outcome.
  //
  // A query error is NOT a missing row: it must surface rather than render as a
  // 404 that reads like a revoked or non-existent grant.
  const { data: assignment, error: assignmentError } = await supabase
    .from('material_assignments')
    .select('id, student_id, attachment_name, study_sheet_id, page_start, page_end, annotations, assigned_at, revoked_at')
    .eq('id', assignmentId)
    .maybeSingle()

  if (assignmentError) {
    console.error(
      `[dashboard/students/[id]/homework] material_assignments lookup failed (assignment ${assignmentId}):`,
      assignmentError
    )
    throw new Error('Failed to load this homework')
  }
  if (!assignment) notFound()

  // --- GATE 3: pin the grant to the gated training's student ----------------
  if (assignment.student_id !== studentId) notFound()

  // --- GATE 4: live grants only --------------------------------------------
  if (assignment.revoked_at !== null) notFound()

  // Display title, USER-SCOPED on purpose: a service-role read would expose the
  // titles of sheets this teacher's own RLS tier denies them (another teacher's
  // private, owner_id-scoped material). Denied or missing sheet -> the granted
  // filename, which the teacher can see on the grant row regardless.
  const { data: sheet, error: sheetError } = await supabase
    .from('study_sheets')
    .select('title')
    .eq('id', assignment.study_sheet_id)
    .maybeSingle()

  if (sheetError) {
    console.error(
      `[dashboard/students/[id]/homework] study_sheets title lookup failed (assignment ${assignmentId}):`,
      sheetError
    )
  }

  const title =
    typeof sheet?.title === 'string' && sheet.title.length > 0
      ? sheet.title
      : (assignment.attachment_name as string)

  // annotations is jsonb, so nothing about it is guaranteed at runtime. Anything
  // that is not an array renders an empty layer rather than crashing the viewer.
  const annotations: Annotation[] = Array.isArray(assignment.annotations)
    ? (assignment.annotations as Annotation[])
    : []

  const pageStart = assignment.page_start as number | null
  const pageEnd = assignment.page_end as number | null
  const studentName = studentRecord?.full_name ?? 'this student'

  return (
    <div className="space-y-6">
      {/* Back link - prefetch={false} on every Link in this project */}
      <Link
        href={`/students/${id}`}
        prefetch={false}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors w-fit"
      >
        <ArrowLeft size={16} />
        Back to {studentName}
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span
            className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
            style={{ backgroundColor: '#FFF0E0', color: '#FF8303' }}
          >
            {pageRangeLabel(pageStart, pageEnd)}
          </span>
          <span className="text-xs" style={{ color: '#9ca3af' }}>
            Assigned {formatAssignedDate(assignment.assigned_at as string, viewerTz)}
          </span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        <p className="text-sm mt-1" style={{ color: '#6b7280' }}>
          Homework for {studentName}.
        </p>
      </div>

      {/* The student's own layer, over the rebuilt, watermarked, page-scoped
          document. The bytes are gated again, independently, by
          /api/material-assignment-file. */}
      <MaterialHomeworkViewer
        fileUrl={`/api/material-assignment-file/${assignment.id}`}
        annotations={annotations}
        pageStart={pageStart}
        pageEnd={pageEnd}
        title={assignment.attachment_name as string}
      />
    </div>
  )
}
