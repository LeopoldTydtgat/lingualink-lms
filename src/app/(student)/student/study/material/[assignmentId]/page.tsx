import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireTz } from '@/lib/time/requireTz'
import type { Annotation } from '@/components/pdf/PdfViewer'
import MaterialHomeworkPdf from './MaterialHomeworkPdf'

// ---------------------------------------------------------------------------
// Student view of ONE teaching-material homework grant.
//
// The bytes come from /api/material-assignment-file/[assignmentId], which
// rebuilds the PDF from the granted pages and watermarks every page. This page
// never touches storage and never re-derives who may see what: the user-scoped
// material_assignments read below IS the gate, and it is the same gate the file
// route uses.
// ---------------------------------------------------------------------------

const AssignmentIdSchema = z.string().uuid()

interface Props {
  params: Promise<{ assignmentId: string }>
}

// The columns this page reads. Explicit list, never select('*'):
// material_assignments carries a column-level UPDATE grant (annotations,
// updated_at only), and the project rule is explicit columns on any table with
// column-level grants.
const ASSIGNMENT_COLUMNS =
  'id, student_id, study_sheet_id, attachment_name, page_start, page_end, annotations, assigned_at'

// Date-only, in the STUDENT'S account timezone, via Intl with an explicit
// locale. Never toISOString().slice() (that reports the UTC calendar day and is
// a day off either side of midnight for anyone east or west of UTC) and never
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

export default async function MaterialHomeworkPage({ params }: Props) {
  const { assignmentId } = await params

  // A non-uuid path segment can never name a row and would otherwise reach
  // Postgres as a 22P02 cast error and surface as a 500.
  if (!AssignmentIdSchema.safeParse(assignmentId).success) notFound()

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Resolve the student. auth_user_id is the only indirection from auth.users to
  // students - the auth uid is never a students PK. Explicit column list:
  // students carries column-level REVOKEs (admin_notes, cancellation_policy).
  // A query error and a genuinely missing row are different failures: the first
  // is transient and must surface, the second is a real "no student" state.
  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id, timezone')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (studentError) {
    console.error('[student/study/material] students lookup failed:', studentError)
    throw new Error('Failed to load your homework')
  }
  if (!student) redirect('/student/login')

  // --- THE GATE (sole authorization) ---------------------------------------
  // User-scoped read: RLS decides. The policy "Students read own live material
  // assignments" returns a row ONLY when the grant belongs to this caller AND
  // revoked_at is null, so revocation is NOT re-checked here - re-deriving it in
  // code could only ever disagree with the live policy. A missing row means "no
  // such grant / not yours / revoked", all indistinguishable and all notFound().
  //
  // An actual query error is NOT a missing row: it must surface as a 500-style
  // error rather than render an empty page that looks like a revoked grant.
  const { data: assignment, error: assignmentError } = await supabase
    .from('material_assignments')
    .select(ASSIGNMENT_COLUMNS)
    .eq('id', assignmentId)
    .maybeSingle()

  if (assignmentError) {
    console.error(
      `[student/study/material] material_assignments lookup failed (assignment ${assignmentId}):`,
      assignmentError
    )
    throw new Error('Failed to load your homework')
  }
  if (!assignment) notFound()

  // Not a re-derivation of the gate above, and not a narrowing of it: the
  // material_assignments SELECT policies are OR'd (student / teacher / admin), so
  // a dual-identity account - one holding BOTH a students row and a teacher
  // profile - reaches another student's grant through the TEACHER policy. This is
  // the student portal, where a caller may only ever see their own row, so the
  // identity that matters here is pinned explicitly. Same reasoning as the
  // audience check in /api/student/assignments/[id]/mark-done.
  if (assignment.student_id !== student.id) notFound()

  // --- Display metadata only (service role) --------------------------------
  // Material grants are always issued against audience='staff' sheets
  // (api/teacher/material-assignments/route.ts:225), and the student SELECT
  // policy on study_sheets requires audience='student' - so a user-scoped read
  // here returns NOTHING and the page would have no title to show. Read it on the
  // service-role client instead, exactly as student/past-classes/[id] reads the
  // sheet metadata behind an annotated PDF.
  //
  // This is DISPLAY-ONLY, never an access gate: authorisation was already settled
  // by the RLS-bound read above, and the bytes are gated again, independently, by
  // /api/material-assignment-file. Nothing selected here widens what the student
  // can reach - it only names what they were already granted.
  //
  // Fail soft: a missing sheet or a failed lookup falls back to the granted
  // filename, so the homework still opens rather than 500-ing over a heading.
  const adminClient = createAdminClient()
  const { data: sheet, error: sheetError } = await adminClient
    .from('study_sheets')
    .select('title')
    .eq('id', assignment.study_sheet_id)
    .maybeSingle()

  if (sheetError) {
    console.error(
      `[student/study/material] study_sheets title lookup failed (assignment ${assignmentId}):`,
      sheetError
    )
  }

  const title =
    typeof sheet?.title === 'string' && sheet.title.length > 0
      ? sheet.title
      : assignment.attachment_name

  // annotations is jsonb, so nothing about it is guaranteed at runtime. Anything
  // that is not an array seeds an empty layer rather than crashing the viewer.
  const annotations: Annotation[] = Array.isArray(assignment.annotations)
    ? (assignment.annotations as Annotation[])
    : []

  const pageStart = assignment.page_start as number | null
  const pageEnd = assignment.page_end as number | null
  const hasRange = pageStart !== null && pageEnd !== null

  // Fail-closed timezone, same helper every other student page uses.
  const timezone = requireTz(student.timezone, 'student-material-homework')

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back link — prefetch={false} on every Link in this project */}
      <Link
        href="/student/study"
        prefetch={false}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors w-fit"
      >
        <ArrowLeft size={16} />
        Back to Study
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span
            className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
            style={{ backgroundColor: '#FFF0E0', color: '#FF8303' }}
          >
            {hasRange ? `Pages ${pageStart}-${pageEnd}` : 'Whole document'}
          </span>
          <span className="text-xs" style={{ color: '#9ca3af' }}>
            Assigned {formatAssignedDate(assignment.assigned_at as string, timezone)}
          </span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        <p className="text-sm mt-1" style={{ color: '#6b7280' }}>
          Write on the pages your teacher assigned. Your notes are saved automatically.
        </p>
      </div>

      {/* The homework layer. Bytes come from the rebuilt, watermarked, page-scoped
          document; the marks are translated between served and real page indices
          inside the wrapper. */}
      <div
        className="rounded-xl overflow-hidden bg-white shadow-sm"
        style={{ border: '1px solid #f3f4f6' }}
      >
        <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
          <span className="text-xs font-semibold text-gray-500 truncate">
            {assignment.attachment_name}
          </span>
        </div>
        <MaterialHomeworkPdf
          assignmentId={assignment.id as string}
          fileUrl={`/api/material-assignment-file/${assignment.id}`}
          initialAnnotations={annotations}
          pageStart={pageStart}
          pageEnd={pageEnd}
        />
      </div>
    </div>
  )
}
