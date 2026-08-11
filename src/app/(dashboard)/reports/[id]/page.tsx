import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import { isValidTimeZone } from '@/lib/utils/timezone'
import ReportFormClient from './ReportFormClient'
import type { Annotation } from '@/components/pdf/PdfViewer'

type Props = {
  params: Promise<{ id: string }>
}

type MaterialSheet = {
  id: string
  title: string
  attachments: { name: string; type: string }[]
}

// One marked-up PDF for the read-only recap. Mirrors ReportFormClient's own
// AnnotatedPdf: attachmentName is the FILENAME, which the client drops straight
// into the serving route's third path segment.
type AnnotatedPdf = {
  studySheetId: string
  attachmentName: string
  annotations: Annotation[]
}

// Minimal shape of a study_sheets.attachments entry — only the field the display
// filter below needs. attachments is jsonb, so nothing about it is guaranteed at
// runtime; the resolver re-checks the name exactly as the serving route does.
type SheetAttachment = { name: string }

// Mirrors the attachment-resolution block in
// /api/lesson-annotation-file/[lessonId]/[sheetId]/[name]/route.ts EXACTLY:
//   - attachment_name resolves by NAME against the sheet's current attachments;
//   - there is NO positional fallback on either side. attachment_name is NOT NULL
//     on lesson_annotations, and the route takes the name as its own path param,
//     so a row whose name does not match a current attachment is simply
//     unservable — resolving it by index here would mount a viewer whose every
//     byte request 404s;
//   - the resolved entry must exist and its filename must pass the route's
//     charset check, which the name is also screened against as a path param.
// Anything this returns false for is a guaranteed 404 from that route.
// Deliberately duplicated from the student past-class page rather than imported:
// that module is a route page, not a shared helper.
function attachmentResolves(
  attachments: SheetAttachment[],
  attachmentName: unknown
): boolean {
  const attachment =
    typeof attachmentName === 'string' && attachmentName.length > 0
      ? attachments.find(a => a && a.name === attachmentName)
      : undefined

  return (
    !!attachment &&
    typeof attachment.name === 'string' &&
    /^[a-zA-Z0-9._-]+$/.test(attachment.name)
  )
}

export default async function ReportPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, timezone, profile_completed')
    .eq('id', user.id)
    .single()

  // A null profile is NOT an unauthenticated user, so this never bounces to
  // /login. Same inline fallback the schedule page renders.
  if (!profile) return (
    <div className="p-8 text-gray-500">Unable to load your profile. Please refresh the page.</div>
  )

  // Confirmed-timezone gate, replicated from (dashboard)/schedule/page.tsx and
  // (dashboard)/upcoming-classes/page.tsx. The class time in the header is
  // rendered in this viewer's own zone — an admin reading a teacher's report is
  // bound by the gate identically, and sees the time in the ADMIN's zone. There
  // is deliberately no 'UTC' fallback: silently formatting in UTC prints the
  // wrong wall-clock time for every viewer outside it.
  if (profile.profile_completed !== true) {
    redirect('/account?confirm_tz=1')
  }

  // profile_completed is the confirmation FLAG, not the value it confirms: a row
  // flagged complete but carrying a null timezone still leaves nothing to format
  // in, so it goes back through the same flow rather than to a fallback zone.
  // isValidTimeZone screens the string itself as well, since nothing on the write
  // path checks it is a real IANA id — /api/profile stores the value verbatim.
  // Intl.DateTimeFormat THROWS RangeError on a bad zone, and this route group has
  // no error boundary, so an unscreened value would blank the page instead of
  // prompting for the one thing that fixes it.
  const viewerTimezone = profile.timezone
  if (!viewerTimezone || !isValidTimeZone(viewerTimezone)) {
    redirect('/account?confirm_tz=1')
  }

  const isAdmin = profile?.role === 'admin'

  const { data: report, error } = await supabase
    .from('reports')
    .select(`
      id,
      status,
      did_class_happen,
      no_show_type,
      feedback_text,
      additional_details,
      level_data,
      student_confirmed,
      impersonation_note,
      deadline_at,
      completed_at,
      flagged_at,
      lesson:lessons (
        id,
        scheduled_at,
        duration_minutes,
        student:students (
          id,
          full_name,
          photo_url
        ),
        teacher:profiles (
          id,
          full_name
        )
      )
    `)
    .eq('id', id)
    .single()

  if (error || !report) notFound()

  // Supabase returns joined relations as arrays — flatten to single objects
  const lesson = (Array.isArray(report.lesson) ? report.lesson[0] : report.lesson) as any
  const teacher = (Array.isArray(lesson?.teacher) ? lesson.teacher[0] : lesson?.teacher) as { id: string; full_name: string } | null
  const student = (Array.isArray(lesson?.student) ? lesson.student[0] : lesson?.student) as { id: string; full_name: string; photo_url: string | null } | null

  // Teachers can only view their own reports
  if (!isAdmin && teacher?.id !== user.id) {
    redirect('/reports')
  }

  // Fetch study sheets already assigned for this lesson
  const { data: assignments } = await supabase
    .from('assignments')
    .select('study_sheet_id')
    .eq('lesson_id', lesson?.id ?? '')

  const assignedSheetIds = (assignments ?? []).map(a => a.study_sheet_id)

  let assignedSheets: { id: string; title: string }[] = []
  if (assignedSheetIds.length > 0) {
    const { data: sheets } = await supabase
      .from('study_sheets')
      .select('id, title')
      .in('id', assignedSheetIds)
    assignedSheets = sheets ?? []
  }

  // Teaching material the teacher can hand out from this report. Deliberately
  // the user-scoped client, never createAdminClient(): RLS is what decides
  // which staff sheets this caller may see at all. is_active + audience='staff'
  // mirror the checks POST /api/teacher/material-assignments re-applies before
  // it will issue a grant, so the picker cannot offer something the route
  // would refuse. PDF filtering is left to the client, which needs the
  // non-PDF rows in order to disable them with a reason.
  const { data: materialRows, error: materialError } = await supabase
    .from('study_sheets')
    .select('id, title, attachments')
    .eq('is_active', true)
    .eq('audience', 'staff')
    .order('title')

  if (materialError) {
    console.error('Report page: teaching material load failed:', materialError.message)
  }

  // On a failed query materialRows is null, so the prop is an empty array and
  // the picker shows its "No teaching materials available." state rather than
  // an empty select that looks like a working control.
  const materialSheets: MaterialSheet[] = (materialRows ?? []).map((row: any) => ({
    id: row.id,
    title: row.title,
    attachments: Array.isArray(row.attachments)
      ? (row.attachments as { name: string; type: string }[])
      : [],
  }))

  // The PDFs marked up during this class, for the read-only recap at the foot of
  // the report. Deliberately the user-scoped client, never createAdminClient():
  // this single RLS-bound read IS the access gate, and no ownership or cutoff
  // logic is re-derived here. "Teachers read own lesson annotations" returns rows
  // only for a lesson this caller taught — with no cutoff, so a teacher may
  // review the marks from their own class at any time — and "Admins read all
  // lesson annotations" returns them for an admin. Nothing is written on this
  // path; the live-lesson autosave remains the only writer.
  // attachment_name is BOTH the resolution key mirrored from the serving route
  // and the value handed to the client, which builds that route's URL from it —
  // the annotation's identity is its filename end to end. attachment_index
  // survives only as the display ordering below; nothing keys off it.
  //
  // The WHOLE block is gated on the flattened lesson carrying a real id. The
  // lessons join is nullable and flattening can yield null, and '' is not a
  // uuid — the `?? ''` fallback used for the assignments query above would hand
  // PostgREST a malformed filter value here rather than matching nothing. With
  // no lesson there is nothing to recap, so NEITHER query is issued, the prop
  // stays empty, and the client (which independently requires report.lesson
  // before it will build a file URL) renders no card at all.
  const lessonId: string = typeof lesson?.id === 'string' ? lesson.id : ''
  let annotatedPdfs: AnnotatedPdf[] = []

  if (lessonId.length > 0) {
    const { data: annotatedRows } = await supabase
      .from('lesson_annotations')
      .select('study_sheet_id, attachment_index, attachment_name, annotations')
      .eq('lesson_id', lessonId)
      .order('study_sheet_id', { ascending: true })
      .order('attachment_index', { ascending: true })

    // Only rows that actually carry marks are candidates for a viewer.
    const markedRows = (annotatedRows ?? []).filter(
      r => Array.isArray(r.annotations) && r.annotations.length > 0
    )

    // Resolve which of those rows the file route can still serve.
    // /api/lesson-annotation-file returns 404 for every byte request in TWO cases:
    // the sheet's is_active !== true, and the annotated attachment no longer
    // resolving on that sheet (removed, renamed, or a filename that fails the
    // route's charset check). Without this filter the page mounts a viewer that can
    // only ever fail, so the sheets' attachments are carried here too — not just
    // their active state.
    //
    // WHY the service-role client: the route performs its is_active check on the
    // service-role client, and mirroring that check needs the same unfiltered view
    // of study_sheets. A user-scoped read would be narrowed by RLS, which decides
    // which sheets this caller may BROWSE — a different question from which
    // annotated file the route will serve — so it could wrongly hide a marked-up
    // PDF the route would hand over without complaint.
    //
    // This query is DISPLAY-FILTERING ONLY, never an access gate: authorisation
    // remains with the RLS-bound lesson_annotations read above and the route's own
    // user-scoped RLS gate.
    const activeSheetAttachments = new Map<string, SheetAttachment[]>()
    if (markedRows.length > 0) {
      const sheetIds = Array.from(
        new Set(markedRows.map(r => r.study_sheet_id as string))
      )
      const adminClient = createAdminClient()
      const { data: sheetRows, error: sheetsError } = await adminClient
        .from('study_sheets')
        .select('id, is_active, attachments')
        .in('id', sheetIds)

      if (sheetsError) {
        // Fail soft for the page, closed for the display: nothing is verified
        // servable, so the recap renders empty rather than mounting viewers whose
        // every file request would 404.
        console.error('Report page: study sheet active-state fetch failed:', sheetsError.message)
      } else {
        for (const s of sheetRows ?? []) {
          // Inactive sheets are never entered, so absence from this map means
          // "deactivated, or never fetched" — both non-servable.
          if (s.is_active === true) {
            activeSheetAttachments.set(
              s.id as string,
              (Array.isArray(s.attachments) ? s.attachments : []) as SheetAttachment[]
            )
          }
        }
      }
    }

    // Shape for the client, which renders one read-only viewer per entry — rows
    // whose sheet was deactivated and rows whose attachment no longer resolves on
    // that sheet are both dropped, since their bytes are no longer servable.
    annotatedPdfs = markedRows
      .filter(r => {
        const attachments = activeSheetAttachments.get(r.study_sheet_id as string)
        if (!attachments) return false
        return attachmentResolves(attachments, r.attachment_name)
      })
      .map(r => ({
        studySheetId: r.study_sheet_id as string,
        // The serving route's third path segment, and the React key. Every row
        // reaching here passed attachmentResolves, so this is a non-empty string
        // matching a current attachment and the route's charset rule.
        attachmentName: r.attachment_name as string,
        annotations: (Array.isArray(r.annotations) ? r.annotations : []) as Annotation[],
      }))
  }

  // Build a clean report object with correct types
  const cleanReport = {
    ...report,
    lesson: lesson ? { ...lesson, teacher, student } : null,
  }

  return (
    <ReportFormClient
      report={cleanReport as any}
      profile={profile ?? { id: '', full_name: '', role: '' }}
      isAdmin={isAdmin}
      assignedSheetIds={assignedSheetIds}
      assignedSheets={assignedSheets}
      materialSheets={materialSheets}
      annotatedPdfs={annotatedPdfs}
      viewerTimezone={viewerTimezone}
    />
  )
}
