import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import BookingClient from './BookingClient'
import { requireTz } from '@/lib/time/requireTz'

// One row from the get_teacher_reviews_summary RPC. Postgres numeric can arrive as
// a string over the wire, so avg_rating/review_count are coerced with Number() at
// the point of use rather than trusted as numbers here.
interface TeacherReviewSummary {
  teacher_id: string
  avg_rating: number | string | null
  review_count: number | string | null
  recent_reviews: Array<{ rating: number; text: string; submitted_at: string }> | null
}

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ reschedule?: string }>
}) {
  const supabase = await createClient()
  const params = await searchParams

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/student/login')

  // Get student record
  const { data: student } = await supabase
    .from('students')
    .select('id, timezone, profile_completed')
    .eq('auth_user_id', user.id)
    .single()
  if (!student) redirect('/student/login')

  if (student.profile_completed !== true) {
    redirect('/student/account?confirm_tz=1')
  }

  // Get active training
  const { data: training } = await supabase
    .from('trainings')
    .select('id, total_hours, hours_consumed, end_date')
    .eq('student_id', student.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!training) {
    // No active training — student cannot book
    redirect('/student/my-classes')
  }

  // Hours remaining
  const hoursRemaining = training.total_hours - training.hours_consumed

  // Get teachers assigned to this training via training_teachers
  const { data: rawAssignments } = await supabase
    .from('training_teachers')
    .select(`
      teacher_id,
      teacher:profiles!teacher_id (
        id,
        full_name,
        photo_url,
        bio,
        timezone,
        nationality,
        qualifications,
        specialties,
        quote,
        native_languages,
        speaking_languages,
        teaching_languages,
        video_url
      )
    `)
    .eq('training_id', training.id)

  const flatTeachers = (rawAssignments ?? [])
    .map((row) => {
      const t = Array.isArray(row.teacher) ? row.teacher[0] : row.teacher
      return t ?? null
    })
    .filter(Boolean)

  if (flatTeachers.length === 0) {
    // No teachers assigned yet — redirect back
    redirect('/student/my-classes')
  }

  // Public review stats for the assigned teachers, via a SECURITY DEFINER RPC that
  // returns anonymised aggregates (no student names). Stats are STRICTLY ADDITIVE:
  // any failure here must still render the full booking flow with zero stats —
  // never throw, never block the booking.
  const teacherIds = flatTeachers.map((t) => t.id)
  const reviewsById = new Map<string, TeacherReviewSummary>()
  const { data: reviewSummaries, error: reviewError } = await supabase.rpc(
    'get_teacher_reviews_summary',
    { p_teacher_ids: teacherIds }
  )
  if (reviewError) {
    console.error('book: get_teacher_reviews_summary failed', reviewError)
  } else if (Array.isArray(reviewSummaries)) {
    for (const row of reviewSummaries as TeacherReviewSummary[]) {
      reviewsById.set(row.teacher_id, row)
    }
  }

  const teachers = flatTeachers.map((t) => {
    const summary = reviewsById.get(t.id)
    if (!summary) {
      // The RPC left-joins every id passed in, so a missing row is anomalous —
      // log it and fall back to zero stats for this teacher.
      console.error(`book: no review summary for teacher ${t.id}; defaulting to zero stats`)
      return { ...t, avgRating: null, reviewCount: 0, recentReviews: [] }
    }
    const reviewCount = Number(summary.review_count) || 0
    const avgRaw = Number(summary.avg_rating)
    const avgRating = reviewCount > 0 && !Number.isNaN(avgRaw) ? avgRaw : null
    const recentReviews = Array.isArray(summary.recent_reviews) ? summary.recent_reviews : []
    return { ...t, avgRating, reviewCount, recentReviews }
  })

  // If rescheduling, fetch the original lesson
  let rescheduleLesson: {
    id: string
    scheduled_at: string
    duration_minutes: number
    teacher_id: string
  } | null = null

  if (params.reschedule) {
    const { data: lesson } = await supabase
      .from('lessons')
      .select('id, scheduled_at, duration_minutes, teacher_id')
      .eq('id', params.reschedule)
      .eq('student_id', student.id)
      .eq('status', 'scheduled')
      .maybeSingle()
    rescheduleLesson = lesson ?? null
  }

  return (
    <BookingClient
      studentId={student.id}
      studentTimezone={requireTz(student.timezone, 'book:student')}
      trainingId={training.id}
      hoursRemaining={hoursRemaining}
      teachers={teachers}
      rescheduleLesson={rescheduleLesson}
    />
  )
}