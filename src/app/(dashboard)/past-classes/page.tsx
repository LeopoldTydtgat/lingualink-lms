import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import PastClassesClient from './PastClassesClient'

type RawStudentJoin = {
  full_name: string | null
  photo_url: string | null
} | null

type RawLessonRow = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  students: RawStudentJoin | RawStudentJoin[]
}

type RawReportRow = {
  lesson_id: string
  feedback_text: string | null
}

// Hard ceiling on the history read. Paired with the DESC order below: if the cap
// is ever reached it drops the OLDEST classes, never the newest.
const LESSON_FETCH_LIMIT = 1000

// A single .in() carrying up to LESSON_FETCH_LIMIT uuids builds a ~37KB query
// string, which trips header-size limits well before PostgREST sees it. Chunked.
const REPORT_ID_CHUNK_SIZE = 200

export default async function PastClassesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Viewer's own zone for instant labels in the client. Display-only fallback
  // convention already used at (dashboard)/students/[id]/page.tsx - a null
  // timezone degrades the labels, it is NOT an auth signal and must not gate.
  const { data: profile } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', user.id)
    .maybeSingle()

  const viewerTz = profile?.timezone ?? 'UTC'

  const adminClient = createAdminClient()

  // One request-time instant shared by the query bound and the end-based filter
  // below, so the two can never disagree about "now". new Date().getTime() rather
  // than Date.now(): the react-hooks/purity rule mis-fires on Date.now() in async
  // Server Components, and the repo's only other remedy is a file-wide rule disable.
  const nowMs = new Date().getTime()

  // teacher_id = user.id is the ONLY scoping boundary on this read. adminClient is
  // service-role and bypasses RLS entirely, so this filter is load-bearing: never
  // remove it, never widen it, never make it conditional.
  //
  // NO status filter, deliberately. Past Classes is the teacher's permanent record
  // and must show completed, missed, both no-shows AND all three cancelled statuses.
  // ACTIVE_AND_CANCELLED_STATUSES is the wrong set here - it excludes the first four.
  //
  // The .lt bound is a COARSE prefilter only: scheduled_at is a timestamptz and this
  // bound is an instant, so it is instant-vs-instant in UTC, NOT local calendar date
  // construction - the toISOString() ban covers construction, which this is not. The
  // exact "has it ended" test is isPast below.
  const { data: rawLessons, error: lessonsError } = await adminClient
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      cancelled_at,
      cancellation_reason,
      cancelled_by,
      rescheduled_by,
      students (
        full_name,
        photo_url
      )
    `)
    .eq('teacher_id', user.id)
    .lt('scheduled_at', new Date(nowMs).toISOString())
    .order('scheduled_at', { ascending: false })
    .limit(LESSON_FETCH_LIMIT)

  if (lessonsError) {
    console.error('[dashboard/past-classes] lessons query failed:', lessonsError)
  }

  const fetchedRows = (rawLessons ?? []) as RawLessonRow[]
  const capped = fetchedRows.length === LESSON_FETCH_LIMIT

  // Exact end-based cutoff, the COMPLEMENT of the upcoming-classes filter
  // ((dashboard)/upcoming-classes/page.tsx keeps a lesson while
  // now < start + duration, every status alike). The two rules must stay exact
  // mirrors: any drift opens a gap where a cancelled class sits on neither list
  // for the length of its slot, which is precisely what that file warns about.
  // Instant-vs-instant in UTC ms; no local calendar date is involved.
  const isPast = (l: { scheduled_at: string; duration_minutes: number }) =>
    nowMs >= new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000

  const pastRows = fetchedRows.filter(isPast)

  // Supabase nested joins arrive as object OR array depending on the inferred
  // cardinality - always flatten with an Array.isArray() check.
  const lessons = pastRows.map((l) => {
    const student = Array.isArray(l.students) ? l.students[0] : l.students
    return {
      id: l.id,
      scheduled_at: l.scheduled_at,
      duration_minutes: l.duration_minutes,
      status: l.status,
      cancelled_at: l.cancelled_at ?? null,
      cancellation_reason: l.cancellation_reason ?? null,
      cancelled_by: l.cancelled_by ?? null,
      rescheduled_by: l.rescheduled_by ?? null,
      student_name: student?.full_name ?? 'Unknown student',
      student_photo_url: student?.photo_url ?? null,
    }
  })

  // Completed reports supply the feedback text shown under a class. Display-only,
  // so this fails SAFE rather than closed: a failed lookup renders the classes with
  // no feedback and must never blank the page or read as "no past classes".
  const lessonIds = lessons.map((l) => l.id)
  const reportRows: RawReportRow[] = []
  let reportsFailed = false

  for (let i = 0; i < lessonIds.length; i += REPORT_ID_CHUNK_SIZE) {
    const chunk = lessonIds.slice(i, i + REPORT_ID_CHUNK_SIZE)
    const { data: chunkRows, error: chunkError } = await adminClient
      .from('reports')
      .select('lesson_id, feedback_text')
      .in('lesson_id', chunk)
      .eq('status', 'completed')

    if (chunkError) {
      console.error(
        `[dashboard/past-classes] reports lookup failed (chunk at offset ${i}):`,
        chunkError
      )
      reportsFailed = true
      break
    }

    reportRows.push(...((chunkRows ?? []) as RawReportRow[]))
  }

  const reports = reportsFailed ? [] : reportRows

  return (
    <PastClassesClient
      lessons={lessons}
      reports={reports}
      viewerTz={viewerTz}
      loadFailed={Boolean(lessonsError)}
      capped={capped}
    />
  )
}
