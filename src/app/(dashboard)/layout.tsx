// src/app/(dashboard)/layout.tsx
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { getMonthRangeInTz } from '@/lib/billing/monthRange'
import { getBillability, projectedContribution } from '@/lib/billing/billability'
import { fetchLessonRateMap, resolveLessonRate } from '@/lib/billing/lessonRates'
import LeftNav from '@/components/layout/LeftNav'
import TopHeader from '@/components/layout/TopHeader'
import RightPanel from '@/components/layout/RightPanel'
import AnnouncementBanner from '@/components/AnnouncementBanner'
import type { AnnouncementItem } from '@/components/AnnouncementBanner'
import ChatWidget from '@/components/ChatWidget'
import IdleTimeoutWatcher from '@/components/IdleTimeoutWatcher'
import BillingRealtimeRefresher from '@/components/layout/BillingRealtimeRefresher'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('id, full_name, email, photo_url, role, timezone')
    .eq('id', user.id)
    .single()

  // Defense-in-depth — proxy already gates by role, but if a teacher/admin
  // user somehow has no profiles row, fail safe.
  if (!profile) redirect('/login')

  // An ended-but-unreported class keeps status='scheduled' for up to 2h under the
  // pay-withholding model, so a single-row fetch would let it shadow the real next
  // class. Fetch a few candidates and pick the first that hasn't ended; an
  // in-progress class (start <= now < end) must still be picked — the panel's
  // "In class" state depends on it.
  const { data: candidateLessons } = await supabase
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, teams_join_url, student_id, status')
    .eq('teacher_id', profile?.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(5)

  const nextLessonNowMs = Date.now()
  const lessonRow = (candidateLessons ?? []).find(
    (l) => nextLessonNowMs < new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000
  ) ?? null

  let nextLesson = null

  if (lessonRow) {
    const { data: studentRow } = await supabase
      .from('students')
      .select('full_name')
      .eq('id', lessonRow.student_id)
      .maybeSingle()

    nextLesson = {
      id: lessonRow.id,
      scheduled_at: lessonRow.scheduled_at,
      duration_minutes: lessonRow.duration_minutes,
      teams_join_url: lessonRow.teams_join_url,
      student_name: studentRow?.full_name ?? 'Student',
      status: lessonRow.status,
    }
  }

  // Separate query for idle timeout class protection — 90-min lookback catches in-progress classes
  const { data: protectedLesson } = await supabase
    .from('lessons')
    .select('scheduled_at, duration_minutes')
    .eq('teacher_id', profile?.id)
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // ── Billing summary for the current calendar month ────────────────────────
  const now = new Date()
  // Fail-SAFE (not fail-closed): this is the shell layout. A null timezone must
  // degrade only the right-panel billing widget — never throw, which would bubble
  // past the (dashboard) group to app/error.tsx and lock the teacher out of the
  // ENTIRE portal (no error.tsx exists at this level). The canonical invoice amount
  // is computed and guarded on the billing page, not here. Surface the null via log.
  const tz = profile.timezone

  const { data: rateRow } = await admin
    .from('profiles')
    .select('hourly_rate, currency')
    .eq('id', user.id)
    .single()
  const hourlyRate = rateRow?.hourly_rate ?? 0
  const currency = rateRow?.currency ?? null

  let currentAmount = 0
  let projectedAmount = 0

  if (tz) {
    const { startUtc, endUtc } = getMonthRangeInTz(now, tz)

    const { data: monthLessons } = await supabase
      .from('lessons')
      .select('id, duration_minutes, status, cancelled_at, scheduled_at')
      .eq('teacher_id', profile.id)
      .gte('scheduled_at', startUtc)
      .lt('scheduled_at', endUtc)
      // Bespoke membership: active+cancelled PLUS completed and student_no_show, minus teacher_no_show. Intentionally inline, not ACTIVE_AND_CANCELLED_STATUSES — see billability.ts.
      .in('status', ['completed', 'student_no_show', 'cancelled', 'cancelled_by_student', 'cancelled_by_teacher', 'scheduled'])

    // Per-lesson pay rate from lesson_rate_snapshots (admin client — deny-all RLS).
    // `hourlyRate` is the teacher's live rate, used only as the fallback. Applies to
    // both settled amounts and projected amounts (scheduled lessons have snapshots too).
    const rateMap = await fetchLessonRateMap(admin, (monthLessons ?? []).map(l => l.id))

    const nowMs = now.getTime()

    for (const lesson of monthLessons ?? []) {
      const settled = lesson.status !== 'scheduled'

      // Realised earnings so far this month: only settled lessons that are
      // actually billable to the teacher.
      if (settled) {
        const bill = getBillability({
          status: lesson.status,
          scheduledAt: lesson.scheduled_at,
          cancelledAt: lesson.cancelled_at,
          cancellationPolicy: null,
          hourlyRate: resolveLessonRate(rateMap, lesson.id, hourlyRate),
          durationMinutes: lesson.duration_minutes,
        })
        if (bill.billableToTeacher) currentAmount += bill.amount
      }

      // Projected month total. projectedContribution encodes the rule:
      // a scheduled lesson — past OR future — counts at full projected pay,
      // because a booked class is potential income from booking through the
      // report window (filing the report does not change it). A settled lesson
      // counts its realised billable amount, so settled non-billable outcomes
      // (cancellations, teacher no-show, missed) count zero. (NEW219 model.)
      projectedAmount += projectedContribution(
        {
          status: lesson.status,
          scheduledAt: lesson.scheduled_at,
          cancelledAt: lesson.cancelled_at,
          cancellationPolicy: null,
          hourlyRate: resolveLessonRate(rateMap, lesson.id, hourlyRate),
          durationMinutes: lesson.duration_minutes,
        },
        nowMs
      )
    }
  } else {
    console.error('CRITICAL: teacher timezone is null - billing widget degraded to zero, portal preserved', { teacher_id: profile.id })
  }

  const billingData = { currentAmount, projectedAmount }

  const { count: unreadCount } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('receiver_id', user.id)
    .is('read_at', null)

  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('id, full_name, photo_url')
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle()

  const { data: dismissals } = await supabase
    .from('announcement_dismissals')
    .select('announcement_id')
    .eq('user_id', user.id)
    .eq('user_type', 'teacher')

  const dismissedIds = (dismissals ?? []).map(
    (d: { announcement_id: string }) => d.announcement_id
  )

  const { data: allAnnouncements } = await supabase
    .from('announcements')
    .select('id, title, message, is_dismissable, target_audience, target_id')
    .eq('is_active', true)

  const announcements: AnnouncementItem[] = (allAnnouncements ?? []).filter((a) => {
    if (dismissedIds.includes(a.id)) return false
    if (a.target_audience === 'everyone') return true
    if (a.target_audience === 'all_teachers') return true
    if (a.target_audience === 'specific_teacher' && a.target_id === user.id) return true
    return false
  })

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      {/* Sidebar runs full height - logo lives here */}
      <LeftNav
        userRole={profile?.role ?? 'teacher'}
        unreadMessageCount={unreadCount ?? 0}
        userId={user.id}
      />

      {/* Right side: header on top, then content row below */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopHeader
          teacherName={profile?.full_name ?? 'Teacher'}
          teacherPhotoUrl={profile?.photo_url ?? null}
        />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto bg-gray-50 thin-scroll">
            <AnnouncementBanner
              announcements={announcements}
              userType="teacher"
              userId={user.id}
            />
            <div className="p-6">
              {children}
            </div>
          </main>
          <RightPanel
            teacherId={profile?.id ?? null}
            teacherTimezone={profile.timezone}
            announcements={announcements}
            nextLesson={nextLesson}
            billingData={billingData}
            currency={currency}
          />
        </div>
      </div>

      {profile?.role !== 'admin' && (
        <ChatWidget
          participantId={profile?.id ?? ''}
          participantType="teacher"
          participantAuthId={user.id}
          adminName={adminProfile?.full_name ?? 'Shannon'}
          adminPhotoUrl={adminProfile?.photo_url ?? null}
        />
      )}

      <IdleTimeoutWatcher
        nextLessonStartIso={protectedLesson?.scheduled_at ?? null}
        nextLessonDurationMinutes={protectedLesson?.duration_minutes ?? null}
        loginPath="/login"
      />

      <BillingRealtimeRefresher teacherId={profile.id} />
    </div>
  )
}
