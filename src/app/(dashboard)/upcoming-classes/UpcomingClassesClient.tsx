'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CalendarDays, Plus, History, Loader2 } from 'lucide-react'
import { teacherCancelLesson } from './actions'
import { describeLessonCountdown, type LessonCountdown } from '@/lib/lessons/countdown'
import { getLocalDateKey as getTzDateKey, addDaysToDateKey, wallTimeToUtcMs } from '@/lib/utils/timezone'
import { isCancelledStatus, getBillability } from '@/lib/billing/billability'
import { getCancellationLabel } from '@/lib/lessons/statusLabel'
import { Button } from '@/components/ui/button'
import { EmptyStateCalendar } from '@/components/EmptyStateCalendar'

type Student = {
  id: string
  full_name: string
  photo_url: string | null
}

type PrevReportSheet = {
  id: string
  title: string
  category: string
  level: string
}

type PrevReport = {
  scheduledAt: string
  feedbackText: string
  sheets: PrevReportSheet[]
}

type Class = {
  id: string
  training_id: string
  starts_at: string
  ends_at: string
  status: string
  teams_link: string | null
  prevReport: PrevReport | null
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: string | null
  rescheduled_by: string | null
  student: Student
}

type Profile = {
  id: string
  full_name: string
  role: string
  photo_url: string | null
}

type Props = {
  classes: Class[]
  profile: Profile
  profileCompleted: boolean
  bannerDismissed: boolean
  teacherTimezone: string
}

function formatTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    hour12: false,
  }).format(new Date(isoString))
}

function formatDate(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(new Date(isoString))
}

// Full month and year for the month separator, read off the day's own first class in the
// teacher's timezone - the same source and the same zone formatDate uses, so a separator
// can never name a different month from the divider directly beneath it.
function formatMonth(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(isoString)).toUpperCase()
}

// ISO weekday (Monday = 1 ... Sunday = 7) of a YYYY-MM-DD key, by Sakamoto's closed-form
// day-of-week. Pure arithmetic on the triple: no Date, no local formatting, so nothing
// between the key and its weekday can shift with the browser's zone.
function isoWeekday(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  const monthOffsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const yy = m < 3 ? y - 1 : y
  const sundayZero =
    (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + monthOffsets[m - 1] + d) % 7
  return sundayZero === 0 ? 7 : sundayZero
}

// The coming Sunday's key - the end of the week the teacher is actually in, not a rolling
// six days. On a Sunday the week already ends today, so the bound is dateKey itself.
function endOfWeekKey(dateKey: string): string {
  return addDaysToDateKey(dateKey, 7 - isoWeekday(dateKey))
}

// The last day of dateKey's OWN calendar month, so "This Month" cannot reach into the next
// one. The year-month prefix is sliced off the key rather than reformatted, and February's
// leap day is decided by the Gregorian rule instead of by Date rollover.
function endOfMonthKey(dateKey: string): string {
  const [y, m] = dateKey.split('-').map(Number)
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const lastDay = m === 2 && isLeap ? 29 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return `${dateKey.slice(0, 8)}${String(lastDay).padStart(2, '0')}`
}

function groupByDay(classes: Class[], timezone: string): Record<string, Class[]> {
  return classes.reduce((groups, cls) => {
    const day = getTzDateKey(new Date(cls.starts_at), timezone)
    if (!groups[day]) groups[day] = []
    groups[day].push(cls)
    return groups
  }, {} as Record<string, Class[]>)
}

// Today/Tomorrow must be decided on the SAME day boundary that built the group this
// heading labels - the teacher's account timezone, not the browser's. date-fns
// isToday/isTomorrow compare Date objects on the browser's boundary, so a teacher
// whose device zone differs from their account zone read a heading one day off near
// midnight while the group beneath it was correct.
//
// dateKey is the group's own key, already produced by getLocalDateKey in the teacher's
// timezone; todayKey is supplied by the caller from a clock read in an effect, never
// during render (react-hooks/purity is ON in this file).
function formatDayHeading(isoString: string, timezone: string, dateKey: string, todayKey: string | null): string {
  if (todayKey !== null) {
    if (dateKey === todayKey) return 'Today'
    if (dateKey === addDaysToDateKey(todayKey, 1)) return 'Tomorrow'
  }
  return formatDate(isoString, timezone)
}

// The agenda divider carries the whole date: the rows beneath it print time only, so this
// is the only place a reader learns which day they are looking at. formatDayHeading
// returns the absolute date itself when no relative label applies, so comparing the two is
// what decides whether Today/Tomorrow gets prefixed rather than duplicated.
//
// Pure, like everything it calls: the relative label comes from the caller's todayKey,
// which was read from the clock in an effect, never here.
function formatDayDivider(isoString: string, timezone: string, dateKey: string, todayKey: string | null): string {
  const absolute = formatDate(isoString, timezone)
  const relative = formatDayHeading(isoString, timezone, dateKey, todayKey)
  return relative === absolute ? absolute : `${relative} - ${absolute}`
}

// One 1s ticker feeding the countdown value, its label and the NEXT / IN CLASS pill from
// a single describeLessonCountdown result, so the three can never disagree on screen.
// Liveness is recomputed on every tick, not once at mount: a card that is already open
// when its class starts flips to the in-class state by itself, with no reload.
//
// Returns null until the first effect run. The value must not be computed during render:
// Date.now() in a render body is impure (react-hooks/purity) and would make the SSR pass
// disagree with hydration.
//
// Call this once per rendered card and pass the result down. Two calls with the same
// arguments are not free: each one owns its own setInterval.
function useLessonCountdown(startsAt: string, endsAt: string): LessonCountdown | null {
  const [countdown, setCountdown] = useState<LessonCountdown | null>(null)

  useEffect(() => {
    const startMs = new Date(startsAt).getTime()
    const endMs = new Date(endsAt).getTime()
    function update() {
      setCountdown(describeLessonCountdown(startMs, endMs, Date.now()))
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [startsAt, endsAt])

  return countdown
}

// Presentational only: the tick arrives as a prop from the card's single
// useLessonCountdown call, so a card runs one interval rather than one per consumer.
// withLabel is the hero variant: the label sits above the value and comes off that same
// tick, so it reads "In class" the instant the value becomes a remaining-time timer. The
// list variant renders the value alone, unchanged in shape.
function Countdown({ countdown, withLabel = false }: { countdown: LessonCountdown | null; withLabel?: boolean }) {
  const value = <span className="font-mono text-sm" style={{ color: '#FF8303' }}>{countdown?.value ?? ''}</span>

  if (!withLabel) return value

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#9ca3af' }}>
        {countdown?.label ?? 'Starts in'}
      </span>
      {value}
    </div>
  )
}

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: rotated ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s',
        color: '#9ca3af',
        flexShrink: 0
      }}
    >
      <path d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function ActionButton({ label, onClick }: { label: string; onClick?: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
      style={{
        border: hovered ? '2px solid #FF8303' : '2px solid #d1d5db',
        backgroundColor: 'white',
        color: hovered ? '#FF8303' : '#374151',
      }}
    >
      {label}
    </button>
  )
}

function PrevReportSection({ prevReport, teacherTimezone, mounted }: { prevReport: PrevReport; teacherTimezone: string; mounted: boolean }) {
  const [showFull, setShowFull] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const textRef = useRef<HTMLParagraphElement | null>(null)

  useEffect(() => {
    const el = textRef.current
    if (!el) return
    // Only offer a toggle when the clamped text actually overflows 3 lines.
    setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [prevReport.feedbackText, showFull, mounted])

  return (
    <div className="rounded-md p-3" style={{ backgroundColor: '#f9fafb', borderLeft: '3px solid #E0DFDC' }}>
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          <History size={14} className="inline-block mr-1.5 text-gray-400" style={{ verticalAlign: 'text-bottom' }} />
          Last time&apos;s recap
          {mounted && (
            <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
              {formatDate(prevReport.scheduledAt, teacherTimezone)}
            </span>
          )}
        </p>
        {/* line-clamp via Tailwind's line-clamp-3 utility, NOT inline -webkit-box:
            React does not reliably apply the -webkit-box-orient inline style, so the
            previous inline clamp never took effect and the toggle never appeared. */}
        <p
          ref={textRef}
          className={`text-sm text-gray-700 whitespace-pre-line${showFull ? '' : ' line-clamp-3'}`}
        >
          {prevReport.feedbackText}
        </p>
        {(overflows || showFull) && (
          <button
            onClick={() => setShowFull(!showFull)}
            className="text-xs font-medium"
            style={{ color: '#FF8303', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            {showFull ? 'Show less' : 'Show more'}
          </button>
        )}

        {prevReport.sheets.length > 0 && (
          <div className="pt-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Assigned last time
            </p>
            <div className="flex flex-wrap gap-2">
              {prevReport.sheets.map(sheet => (
                <span
                  key={sheet.id}
                  className="text-xs rounded-full px-3 py-1"
                  style={{ backgroundColor: '#FFE8C2', color: '#9a4a00' }}
                >
                  <span className="font-medium">{sheet.title}</span>
                  <span style={{ opacity: 0.75 }}> &middot; {sheet.category} &middot; {sheet.level}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ClassCard({ cls, onReschedule, teacherTimezone, mounted, nextId, isFirst = false }: { cls: Class; onReschedule: (cls: Class) => void; teacherTimezone: string; mounted: boolean; nextId: string | null; isFirst?: boolean }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const countdown = useLessonCountdown(cls.starts_at, cls.ends_at)
  const isCancelled = isCancelledStatus(cls.status)
  const cancelLabel = getCancellationLabel(cls, 'teacher')
  const durationMin = Math.round((new Date(cls.ends_at).getTime() - new Date(cls.starts_at).getTime()) / 60000)
  const isNext = mounted && cls.id === nextId && !isCancelled
  // A cancelled class has nothing left running, so it is never live whatever the clock
  // says. isNext already excludes cancelled rows; this keeps that true at the pill too.
  const isLive = !isCancelled && countdown?.live === true
  // Gated off the card's existing countdown tick rather than a fresh Date.now() in the
  // render body: that read was impure (react-hooks/purity) and only re-evaluated when the
  // card happened to re-render, so an open card kept offering Cancel Class after crossing
  // the 24h boundary. Null until the countdown's first effect run, which fails safe - the
  // button is withheld, never wrongly offered. This is only ever evaluated inside the
  // expanded block, which cannot be open before hydration, so nothing changes on screen.
  const showReschedule = countdown !== null && countdown.msUntilStart > 24 * 60 * 60_000 && !isCancelled

  const hoursBeforeStart = cls.cancelled_at
    ? Math.floor((new Date(cls.starts_at).getTime() - new Date(cls.cancelled_at).getTime()) / 3600000)
    : null

  // Student-side cancellations only: excludes teacher cancellations and reschedule
  // legs (rescheduled_by set). Payment turns on the 24hr notice window; the 48hr
  // B2B policy must never surface in teacher UI, so cancellationPolicy is hardcoded.
  const isStudentCancellation =
    isCancelled &&
    !cls.rescheduled_by &&
    (cls.status === 'cancelled_by_student' || cls.cancelled_by === 'student')

  const cancellationBillability =
    isStudentCancellation && cls.cancelled_at
      ? getBillability({
          status: cls.status,
          scheduledAt: cls.starts_at,
          cancelledAt: cls.cancelled_at,
          cancellationPolicy: '24hr',
          hourlyRate: 0,
          durationMinutes: durationMin,
          cancelledBy: cls.cancelled_by ?? null,
          rescheduledBy: cls.rescheduled_by ?? null,
        })
      : null

  return (
    <div
      className="bg-white overflow-hidden"
      style={{
        borderTop: isFirst ? 'none' : '1px solid #F3F4F6',
        // The next class is marked where it sits rather than lifted into a hero above the
        // list. isNext already carries the mounted gate the pill uses, so the server
        // renders no rail and the first client pass agrees with it.
        borderLeft: isNext ? '3px solid #FF8303' : undefined,
        opacity: isCancelled ? 0.75 : undefined,
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition-colors cursor-pointer"
      >
        <Link
          href={`/students/${cls.training_id}`}
          prefetch={false}
          onClick={e => e.stopPropagation()}
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
          style={{ backgroundColor: '#FFE8C2' }}
        >
          {cls.student.photo_url ? (
            <img
              src={cls.student.photo_url}
              alt={cls.student.full_name}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <span className="font-semibold text-sm" style={{ color: '#FF8303' }}>
              {cls.student.full_name.charAt(0)}
            </span>
          )}
        </Link>

        <div className="flex-1 min-w-0">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <p className="font-semibold">{cls.student.full_name}</p>
            {isNext && (
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', padding: '2px 8px', backgroundColor: '#FF8303', color: '#ffffff', borderRadius: '4px' }}>
                {isLive ? 'IN CLASS' : 'NEXT'}
              </span>
            )}
          </div>
          {/* Time only: the divider above the group carries the date for every row beneath
              it. A cancelled row keeps its own date, since it is not guaranteed to be read
              under a divider. */}
          <p className="text-sm text-gray-500" style={{ display: 'flex', alignItems: 'center' }}>
            {mounted
              ? isCancelled
                ? `${formatDate(cls.starts_at, teacherTimezone)} · ${formatTime(cls.starts_at, teacherTimezone)} - ${formatTime(cls.ends_at, teacherTimezone)} · ${durationMin} min`
                : `${formatTime(cls.starts_at, teacherTimezone)} - ${formatTime(cls.ends_at, teacherTimezone)} · ${durationMin} min`
              : ''}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {isCancelled
            ? <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', backgroundColor: '#f3f4f6', color: '#4b5563', borderRadius: '4px' }}>{cancelLabel ?? 'Cancelled'}</span>
            : <Countdown countdown={countdown} />}
          <ChevronIcon rotated={expanded} />
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-4 bg-gray-50" style={{ borderTop: '1px solid #f3f4f6' }}>
          {isCancelled && cls.cancelled_at && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500">
                {`Cancelled ${formatDate(cls.cancelled_at, teacherTimezone)}, ${hoursBeforeStart}h before class`}
                {cls.cancellation_reason ? ` · ${cls.cancellation_reason}` : ''}
              </p>
              {cancellationBillability && (
                cancellationBillability.billableToTeacher
                  ? <p className="text-xs" style={{ color: '#15803D' }}>You are paid for this class</p>
                  : <p className="text-xs" style={{ color: '#6b7280' }}>Cancelled with more than 24h notice</p>
              )}
            </div>
          )}

          {cls.prevReport && (
            <PrevReportSection prevReport={cls.prevReport} teacherTimezone={teacherTimezone} mounted={mounted} />
          )}

          <div className="flex flex-wrap gap-2">
            {showReschedule && (
              <ActionButton label="Cancel Class" onClick={() => onReschedule(cls)} />
            )}
            <ActionButton
              label={'Message ' + cls.student.full_name.split(' ')[0]}
              onClick={() => router.push(`/messages?studentId=${cls.student.id}`)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default function UpcomingClassesClient({ classes, profile, profileCompleted, bannerDismissed, teacherTimezone }: Props) {
  const router = useRouter()

  const [showProfileBanner, setShowProfileBanner] = useState(!profileCompleted && !bannerDismissed)
  const [isDismissing, setIsDismissing] = useState(false)
  const [mounted, setMounted] = useState(false)
  // Today's date key in the TEACHER's timezone. Set in the effect, never during render:
  // react-hooks/purity is ON in this file and a clock read in a render body would also
  // make the SSR pass disagree with hydration. Null until mounted, which formatDayHeading
  // treats as "no relative label" and falls back to the absolute date.
  //
  // Refreshed at each local midnight by the self-rescheduling timer below, so a tab left
  // open across the boundary does not keep labelling yesterday's group "Today".
  const [todayKey, setTodayKey] = useState<string | null>(null)
  const [rangeFilter, setRangeFilter] = useState<'week' | 'month' | 'all'>('month')

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    // Reads the key from the clock on every hop rather than incrementing the previous
    // key. That is what makes an imprecise fire harmless: early (clock skew) leaves the
    // old key and reschedules a second later; late (throttled background tab, or a zone
    // whose DST transition lands ON midnight so 00:00 does not exist that day and
    // wallTimeToUtcMs resolves past the gap) still reads the correct current day.
    function schedule() {
      const key = getTzDateKey(new Date(), teacherTimezone)
      setTodayKey(key)

      const [y, m, d] = addDaysToDateKey(key, 1).split('-').map(Number)
      const nextMidnightMs = wallTimeToUtcMs(y, m, d, 0, 0, teacherTimezone)
      // Floor the delay: an early fire must never schedule a zero-delay loop. One extra
      // hop a second later lands past the boundary and settles.
      const delay = Math.max(nextMidnightMs - Date.now(), 1000)
      timer = setTimeout(schedule, delay)
    }

    setMounted(true)
    schedule()

    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [teacherTimezone])

  const scheduledCount = classes.filter(c => c.status === 'scheduled').length
  const upcomingClasses = classes.filter(c => !isCancelledStatus(c.status))
  const cancelledClasses = classes
    .filter(c => isCancelledStatus(c.status))
    .sort((a, b) => {
      const ta = a.cancelled_at ?? a.starts_at
      const tb = b.cancelled_at ?? b.starts_at
      return new Date(tb).getTime() - new Date(ta).getTime()
    })
  // nextId is deliberately computed from the UNFILTERED upcomingClasses: the earliest
  // upcoming class's date key is always <= the date key bound of any window that shows
  // anything at all, so the next-class rail and pill can never be filtered out from under
  // themselves.
  const nextId = upcomingClasses.length > 0 ? upcomingClasses[0].id : null

  // Calendar window from today, in the teacher's own timezone, so both labels are literally
  // true: "This Week" ends on the coming Sunday and "This Month" on the last day of today's
  // own month. The old rolling +6 / +29 was not - on 18 Aug "This Month" reached 16 Sept.
  // The bound is derived once per render here, not rebuilt for every class in the callback.
  //
  // While todayKey is null (pre-mount), no filter is applied - the list must match the
  // server-rendered HTML exactly on first client pass, narrowing only after hydration
  // supplies today's key, the same pattern the Today/Tomorrow divider labels follow.
  const rangeMaxKey =
    todayKey === null || rangeFilter === 'all'
      ? null
      : rangeFilter === 'week'
        ? endOfWeekKey(todayKey)
        : endOfMonthKey(todayKey)

  const filteredUpcomingClasses = rangeMaxKey === null
    ? upcomingClasses
    : upcomingClasses.filter(cls => getTzDateKey(new Date(cls.starts_at), teacherTimezone) <= rangeMaxKey)

  // Flat agenda: every upcoming class is a row, the next one included. It is marked in
  // place by its left rail and NEXT / IN CLASS pill rather than pulled out into a hero, so
  // no day can lose its only lesson to a card above the list.
  const grouped = groupByDay(filteredUpcomingClasses, teacherTimezone)
  const days = Object.keys(grouped).sort()

  const [rescheduleTarget, setRescheduleTarget] = useState<Class | null>(null)
  const [rescheduleMessage, setRescheduleMessage] = useState('')
  const [rescheduleLoading, setRescheduleLoading] = useState(false)
  const [rescheduleError, setRescheduleError] = useState<string | null>(null)
  const [rescheduleSuccess, setRescheduleSuccess] = useState(false)

  function handleOpenReschedule(cls: Class) {
    setRescheduleTarget(cls)
    setRescheduleMessage('')
    setRescheduleError(null)
    setRescheduleSuccess(false)
  }

  function handleCloseReschedule() {
    if (rescheduleLoading) return
    router.refresh()
    setRescheduleTarget(null)
    setRescheduleMessage('')
    setRescheduleError(null)
    setRescheduleSuccess(false)
  }

  async function handleConfirmReschedule() {
    if (!rescheduleTarget) return
    if (!rescheduleMessage.trim()) {
      setRescheduleError('You must write a message to your student before rescheduling.')
      return
    }
    setRescheduleLoading(true)
    setRescheduleError(null)
    try {
      const result = await teacherCancelLesson(rescheduleTarget.id, rescheduleMessage.trim())
      if (!result.success) {
        setRescheduleError(result.error)
      } else {
        setRescheduleSuccess(true)
      }
    } catch {
      setRescheduleError('Something went wrong. Please try again.')
    } finally {
      setRescheduleLoading(false)
    }
  }

  // Hide only after the dismissal is persisted - hiding on failure silently resurrects the
  // banner next load, and the banner remaining visible is itself the failure feedback.
  async function handleDismissBanner() {
    setIsDismissing(true)
    try {
      const res = await fetch('/api/profile/dismiss-banner', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error('Failed to persist banner dismiss:', data.error ?? res.status)
        return
      }
      setShowProfileBanner(false)
    } catch (err) {
      console.error('Failed to persist banner dismiss:', err)
    } finally {
      setIsDismissing(false)
    }
  }

  return (
    <div className="space-y-6">

      {showProfileBanner && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#FFF7ED',
          borderLeft: '4px solid #FF8303',
          borderRadius: '8px',
          padding: '12px 16px',
          gap: '12px',
        }}>
          <p style={{ margin: 0, fontSize: '14px', color: '#111827', lineHeight: 1.5 }}>
            Complete your profile to get the most out of your portal.{' '}
            <Link
              href="/account"
              prefetch={false}
              style={{ color: '#FF8303', fontWeight: 600, textDecoration: 'none' }}
            >
              Complete now →
            </Link>
          </p>
          <button
            onClick={handleDismissBanner}
            disabled={isDismissing}
            style={{ background: 'none', border: 'none', cursor: isDismissing ? 'wait' : 'pointer', color: '#9ca3af', padding: '0 4px', fontSize: '18px', lineHeight: 1, flexShrink: 0, opacity: isDismissing ? 0.5 : 1 }}
            aria-label="Dismiss"
          >
            {isDismissing ? <Loader2 size={16} className="animate-spin" /> : '×'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Upcoming Classes</h1>
          <p className="text-sm text-gray-500 mt-1">
            {scheduledCount} {scheduledCount === 1 ? 'class' : 'classes'} scheduled
            {cancelledClasses.length > 0 && (
              <>
                {' '}&middot;{' '}
                <span
                  className="font-medium"
                  style={{ color: '#FF8303' }}
                >
                  {cancelledClasses.length} cancelled
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {upcomingClasses.length > 0 && (
        <div style={{ display: 'inline-flex' }}>
          {([
            ['week', 'This Week'],
            ['month', 'This Month'],
            ['all', 'All'],
          ] as const).map(([value, label], i, arr) => {
            const selected = rangeFilter === value
            return (
              <button
                key={value}
                onClick={() => setRangeFilter(value)}
                style={{
                  fontSize: '13px',
                  padding: '6px 14px',
                  backgroundColor: selected ? '#FF8303' : 'white',
                  color: selected ? 'white' : '#374151',
                  border: '1px solid #d1d5db',
                  borderLeft: i === 0 ? '1px solid #d1d5db' : 'none',
                  borderTopLeftRadius: i === 0 ? '6px' : 0,
                  borderBottomLeftRadius: i === 0 ? '6px' : 0,
                  borderTopRightRadius: i === arr.length - 1 ? '6px' : 0,
                  borderBottomRightRadius: i === arr.length - 1 ? '6px' : 0,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {upcomingClasses.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col items-center text-center py-12 px-6">
          <EmptyStateCalendar />
          <h2 className="mt-4 text-lg font-semibold text-gray-900">No upcoming classes yet</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-[380px]">
            Your booked classes will appear here. Keep your availability up to date so students can book you.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}>
              <Link href="/schedule" prefetch={false}>
                <CalendarDays />
                Update your availability
              </Link>
            </Button>
            {profile.role === 'admin' && (
              <Button asChild variant="outline">
                <Link href="/admin/classes/new" prefetch={false}>
                  <Plus />
                  Add a class
                </Link>
              </Button>
            )}
          </div>
        </div>
      ) : days.length === 0 ? (
        <p className="text-sm text-gray-500 text-center">No classes in this period.</p>
      ) : (
        <div className="space-y-5">
          {days.map((day, dayIndex) => {
            // Every calendar month in the list carries its header, the first one included:
            // two structurally identical months must not look different, and in a flat
            // agenda 31 Aug and 1 Sept are otherwise indistinguishable neighbours. The
            // first day has no previous day to compare against, so it counts as a month
            // change by definition. Months are compared on the day keys, which
            // getLocalDateKey already built in the teacher's timezone, so the comparison
            // and the text below it agree by construction.
            //
            // Gated on todayKey, like the filter: pre-mount the list is unfiltered and no
            // separator renders, so the server and the first client pass emit the same
            // markup.
            const showMonthSeparator =
              todayKey !== null &&
              (dayIndex === 0 || day.slice(0, 7) !== days[dayIndex - 1].slice(0, 7))

            return (
              <div key={day}>
                {showMonthSeparator && (
                  <p
                    style={{
                      // The first header already has the segmented control's gap above it;
                      // only a mid-list month break has to open a break of its own.
                      margin: dayIndex === 0 ? '0 0 10px' : '28px 0 10px',
                      paddingBottom: '6px',
                      paddingLeft: '2px',
                      borderBottom: '1px solid #E0DFDC',
                      fontSize: '13px',
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      color: '#111827',
                    }}
                  >
                    {formatMonth(grouped[day][0].starts_at, teacherTimezone)}
                  </p>
                )}
                {/* Slim text divider, not a card and not a control: nothing collapses here,
                    so it carries no chevron and no lesson count. The mounted gate is the one
                    the old accordion heading used - the raw dateKey renders until the effect
                    supplies todayKey, so the server and the first client pass emit the same
                    string. */}
                <p
                  style={{
                    margin: '0 0 6px 2px',
                    fontSize: '11px',
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#9ca3af',
                  }}
                >
                  {mounted ? formatDayDivider(grouped[day][0].starts_at, teacherTimezone, day, todayKey) : day}
                </p>
                <div className="card-elevated overflow-hidden">
                  {grouped[day].map((cls, i) => (
                    <ClassCard
                      key={cls.id}
                      cls={cls}
                      onReschedule={handleOpenReschedule}
                      teacherTimezone={teacherTimezone}
                      mounted={mounted}
                      nextId={nextId}
                      isFirst={i === 0}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rescheduleTarget && (
        <div
          style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
          }}
          onClick={(e) => { if (e.target === e.currentTarget) handleCloseReschedule() }}
        >
          <div style={{
            backgroundColor: 'white', borderRadius: '12px', padding: '28px',
            width: '100%', maxWidth: '480px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)'
          }}>
            {rescheduleSuccess ? (
              <>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#111827', marginBottom: '12px' }}>
                  Message sent
                </h2>
                <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px', lineHeight: 1.6 }}>
                  Your message has been sent to {rescheduleTarget.student.full_name} and the class has been cancelled.
                  They will need to book a new slot.
                </p>
                <button
                  onClick={handleCloseReschedule}
                  style={{
                    width: '100%', padding: '10px', borderRadius: '8px',
                    backgroundColor: '#FF8303', color: 'white',
                    fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer'
                  }}
                >
                  Close
                </button>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#111827', marginBottom: '4px' }}>
                  Cancel this class?
                </h2>
                <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
                  Class with {rescheduleTarget.student.full_name} - {mounted ? `${formatDate(rescheduleTarget.starts_at, teacherTimezone)}, ${formatTime(rescheduleTarget.starts_at, teacherTimezone)}` : ''}
                </p>
                <p style={{ fontSize: '14px', color: '#111827', marginBottom: '8px', fontWeight: 500 }}>
                  Message to student <span style={{ color: '#ef4444' }}>*</span>
                </p>
                <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '10px', lineHeight: 1.5 }}>
                  Write a message to your student explaining the cancellation. Their hours will be refunded and they can book a new time. This message is required.
                </p>
                <textarea
                  value={rescheduleMessage}
                  onChange={e => setRescheduleMessage(e.target.value)}
                  placeholder="Hi, I'm sorry but I can't make our class on..."
                  rows={4}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
                    border: rescheduleError ? '2px solid #ef4444' : '2px solid #d1d5db',
                    outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box'
                  }}
                />
                {rescheduleError && (
                  <p style={{ color: '#ef4444', fontSize: '13px', marginTop: '6px' }}>{rescheduleError}</p>
                )}
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button
                    onClick={handleCloseReschedule}
                    disabled={rescheduleLoading}
                    onMouseEnter={e => {
                      e.currentTarget.style.backgroundColor = '#f9fafb'
                      e.currentTarget.style.borderColor = '#9ca3af'
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.backgroundColor = 'white'
                      e.currentTarget.style.borderColor = '#d1d5db'
                    }}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
                      border: '2px solid #d1d5db', backgroundColor: 'white', cursor: 'pointer', color: '#374151'
                    }}
                  >
                    Keep class
                  </button>
                  <button
                    onClick={handleConfirmReschedule}
                    disabled={rescheduleLoading}
                    onMouseEnter={e => {
                      if (!rescheduleLoading) e.currentTarget.style.backgroundColor = '#E67502'
                    }}
                    onMouseLeave={e => {
                      if (!rescheduleLoading) e.currentTarget.style.backgroundColor = '#FF8303'
                    }}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '8px', fontSize: '14px', fontWeight: 600,
                      backgroundColor: rescheduleLoading ? '#fbbf24' : '#FF8303',
                      color: 'white', border: 'none', cursor: rescheduleLoading ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {rescheduleLoading ? 'Sending...' : 'Cancel class & notify student'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
