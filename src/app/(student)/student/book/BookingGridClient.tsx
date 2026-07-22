'use client'

// BOOK-1 Stages B+C: single-page booking grid client. Not wired up yet —
// page.tsx still renders BookingClient; Stage D swaps the import. Reschedule
// locks teacher and duration to the original lesson and shows an
// original-lesson context strip; error display (`data.message ?? data.error`),
// confirm label, success redirect and the 24hr footnote are byte-identical to
// the old wizard's, which special-cases none of them for reschedule.
//
// UX pass: fixed 7-day Mon–Sun grid (empty days render as grey columns, not
// hidden), text-less slot cells (time lives in the aria-label), and a sticky
// summary column beside the grid replacing the old bottom confirm panel.

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { User, ChevronLeft, ChevronRight, X, Star, Clock, Calendar, Wallet, ChartNoAxesColumn, Info, type LucideIcon } from 'lucide-react'
import { addDaysToDateKey, getLocalDateKey, localToUtc, utcInstantToTzParts } from '@/lib/utils/timezone'
import { isBookableStart } from '@/lib/bookingGrid'
import {
  getWeekColumnKeys,
  buildInstantSet,
  getValidStartsByColumn,
  collapseEmptyBands,
  getVisibleColumns,
  SLOT_MINUTES,
  type SlotsResponse,
  type GridStartSlot,
} from '@/lib/bookingWeekGrid'

// ─── Grid cell colours ────────────────────────────────────────────────────────
// PLACEHOLDERS pending a design decision (BOOK-1 Stage B) — swap these for the
// approved palette when design lands. All state-dependent colours go through
// inline style props (Tailwind v4 cannot apply dynamically constructed classes).
const CELL_BOOKABLE_BG = '#E8F5E9'
const CELL_GREY_BG = '#F7F6F4'
const CELL_SELECTED_BG = '#FFC58A'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecentReview {
  rating: number
  text: string
  submitted_at: string
}

interface Teacher {
  id: string
  full_name: string
  photo_url: string | null
  bio: string | null
  timezone: string | null
  nationality: string | null
  qualifications: string | null
  specialties: string | null
  quote: string | null
  native_languages: string[] | null
  speaking_languages: string[] | null
  teaching_languages: string[] | null
  video_url: string | null
  // Additive review stats merged in by the server page — never block booking on them.
  avgRating: number | null
  reviewCount: number
  recentReviews: RecentReview[]
}

interface RescheduleLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teacher_id: string
}

// Identical to the Props BookingClient receives from page.tsx, so Stage D is a
// one-line import swap.
interface Props {
  studentId: string
  studentTimezone: string
  trainingId: string
  hoursRemaining: number
  teachers: Teacher[]
  rescheduleLesson: RescheduleLesson | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatHours(hours: number): string {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

// Monday of the week containing "now", as a YYYY-MM-DD key in the given
// timezone. Anchored on the tz-local today key, never browser-local Date math:
// a browser-local Monday midnight can format to a Sunday or Tuesday key in a
// distant profile timezone, desyncing the columns from the server's window.
function getWeekStartKey(timezone: string): string {
  const now = new Date()
  const todayKey = getLocalDateKey(now, timezone)
  const weekday = utcInstantToTzParts(now, timezone).weekday // 0=Sun
  return addDaysToDateKey(todayKey, weekday === 0 ? -6 : 1 - weekday)
}

// Format time as "09:00" in a given timezone
function formatSlotTime(isoString: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(isoString))
}

// A grid row's sticky-column label: pure wall-clock arithmetic on minutes since
// student-local midnight — no Date, no timezone maths, nothing to get wrong.
function formatRowLabel(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

// Up to two initials for the no-photo avatar fallback.
function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

// Read-only star row. Colours copied verbatim from the account page's StarRating
// (src/app/(dashboard)/account/AccountClient.tsx) so ratings read identically
// across portals.
function StarRow({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <div style={{ display: 'flex', gap: '2px' }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={size}
          style={{
            fill: star <= rating ? '#FF8303' : 'none',
            color: star <= rating ? '#FF8303' : '#d1d5db',
          }}
        />
      ))}
    </div>
  )
}

// "4.8 (12 reviews)" with stars — rendered only when there is at least one review.
function RatingLine({
  avgRating,
  reviewCount,
  starSize,
}: {
  avgRating: number | null
  reviewCount: number
  starSize?: number
}) {
  if (reviewCount <= 0 || avgRating === null) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <StarRow rating={Math.round(avgRating)} size={starSize} />
      <span style={{ fontSize: '13px', color: '#6b7280' }}>
        {avgRating.toFixed(1)} ({reviewCount} {reviewCount === 1 ? 'review' : 'reviews'})
      </span>
    </div>
  )
}

// Trim and drop blank entries from a nullable text[] column.
function cleanList(arr: string[] | null): string[] {
  return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim().length > 0) : []
}

// ─── Teacher profile modal ────────────────────────────────────────────────────
// Copied from BookingClient.tsx (which dies in Stage E — do not import from it).
// Mirrors the student-portal ClassReminderModal overlay/card/close pattern
// (src/components/student/ClassReminderModal.tsx): fixed backdrop + centred card,
// backdrop click closes, plus Esc. Body scrolls; footer stays put.
function TeacherProfileModal({
  teacher,
  studentTimezone,
  onClose,
  onSelect,
}: {
  teacher: Teacher
  studentTimezone: string
  onClose: () => void
  onSelect: (id: string) => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const languageRows = [
    { label: 'Teaches', values: cleanList(teacher.teaching_languages) },
    { label: 'Speaks', values: cleanList(teacher.speaking_languages) },
    { label: 'Native', values: cleanList(teacher.native_languages) },
  ].filter((row) => row.values.length > 0)

  const reviewDateFormatter = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: studentTimezone,
  })

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.45)',
          zIndex: 999,
        }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${teacher.full_name} profile`}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1000,
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          width: 'calc(100% - 32px)',
          maxWidth: '480px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close profile"
          style={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#9ca3af',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
          }}
        >
          <X size={20} />
        </button>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', padding: '28px' }}>
          {/* Header: photo + name + rating */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px', paddingRight: '20px' }}>
            {teacher.photo_url ? (
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                <Image
                  src={teacher.photo_url}
                  alt={teacher.full_name}
                  width={80}
                  height={80}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            ) : (
              <div
                style={{
                  width: '80px',
                  height: '80px',
                  borderRadius: '50%',
                  backgroundColor: '#f3f4f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <User size={30} color="#9ca3af" />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '6px' }}>
                {teacher.full_name}
              </h2>
              <RatingLine avgRating={teacher.avgRating} reviewCount={teacher.reviewCount} />
              {teacher.nationality && teacher.nationality.trim().length > 0 && (
                <p style={{ fontSize: '13px', color: '#6b7280', marginTop: '4px' }}>
                  {teacher.nationality}
                </p>
              )}
            </div>
          </div>

          {/* Languages */}
          {languageRows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '18px' }}>
              {languageRows.map((row) => (
                <div key={row.label} style={{ display: 'flex', gap: '8px', fontSize: '13px' }}>
                  <span style={{ fontWeight: '600', color: '#374151', minWidth: '64px', flexShrink: 0 }}>
                    {row.label}
                  </span>
                  <span style={{ color: '#6b7280' }}>{row.values.join(', ')}</span>
                </div>
              ))}
            </div>
          )}

          {/* Quote — italic per spec */}
          {teacher.quote && teacher.quote.trim().length > 0 && (
            <p style={{ fontSize: '14px', fontStyle: 'italic', color: '#4b5563', lineHeight: '1.6', marginBottom: '18px' }}>
              {teacher.quote}
            </p>
          )}

          {/* Full bio */}
          {teacher.bio && teacher.bio.trim().length > 0 && (
            <p style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', marginBottom: '18px', whiteSpace: 'pre-wrap' }}>
              {teacher.bio}
            </p>
          )}

          {/* Qualifications */}
          {teacher.qualifications && teacher.qualifications.trim().length > 0 && (
            <div style={{ marginBottom: '18px' }}>
              <h3 style={{ fontSize: '12px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                Qualifications
              </h3>
              <p style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                {teacher.qualifications}
              </p>
            </div>
          )}

          {/* Specialties */}
          {teacher.specialties && teacher.specialties.trim().length > 0 && (
            <div style={{ marginBottom: '18px' }}>
              <h3 style={{ fontSize: '12px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                Specialties
              </h3>
              <p style={{ fontSize: '14px', color: '#374151', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                {teacher.specialties}
              </p>
            </div>
          )}

          {/* Intro video */}
          {teacher.video_url && teacher.video_url.trim().length > 0 && (
            <a
              href={teacher.video_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '14px',
                fontWeight: '600',
                color: '#FF8303',
                textDecoration: 'none',
                marginBottom: '18px',
              }}
            >
              Watch intro video
            </a>
          )}

          {/* Recent reviews — up to 5, no student identity */}
          {teacher.recentReviews.length > 0 && (
            <div style={{ marginTop: '4px' }}>
              <h3 style={{ fontSize: '12px', fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '12px' }}>
                Recent reviews
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {teacher.recentReviews.slice(0, 5).map((review, i) => (
                  <div
                    key={i}
                    style={{
                      borderTop: i === 0 ? 'none' : '1px solid #f3f4f6',
                      paddingTop: i === 0 ? '0' : '14px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', gap: '8px' }}>
                      <StarRow rating={review.rating} />
                      <span style={{ fontSize: '12px', color: '#9ca3af', flexShrink: 0 }}>
                        {reviewDateFormatter.format(new Date(review.submitted_at))}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', color: '#4b5563', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                      {review.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            flexShrink: 0,
            borderTop: '1px solid #E0DFDC',
            padding: '16px 28px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '10px 18px',
              backgroundColor: '#ffffff',
              border: '1px solid #E0DFDC',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '500',
              color: '#4b5563',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
          <button
            onClick={() => {
              onSelect(teacher.id)
              onClose()
            }}
            style={{
              padding: '10px 18px',
              backgroundColor: '#FF8303',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              color: '#ffffff',
              cursor: 'pointer',
            }}
          >
            Select this teacher
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BookingGridClient({
  studentId,
  studentTimezone,
  trainingId,
  hoursRemaining,
  teachers,
  rescheduleLesson,
}: Props) {
  const router = useRouter()

  const isReschedule = rescheduleLesson !== null

  // On a reschedule, teacher and duration are locked to the original lesson
  // (degraded Stage B behaviour — Stage C polishes the messaging). The locked
  // teacher should always be in the assigned list; fall back to the first
  // assigned teacher rather than rendering a dead grid if it is not.
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>(
    rescheduleLesson !== null && teachers.some((t) => t.id === rescheduleLesson.teacher_id)
      ? rescheduleLesson.teacher_id
      : teachers[0].id
  )
  const [selectedDuration, setSelectedDuration] = useState<number>(
    rescheduleLesson?.duration_minutes ?? (hoursRemaining >= 1 ? 60 : 30)
  )

  // Monday of the visible week as a YYYY-MM-DD key in the STUDENT timezone —
  // the exact frame the server windows and buckets by (NEW317).
  const [weekStartKey, setWeekStartKey] = useState<string>(() => getWeekStartKey(studentTimezone))
  const [slots, setSlots] = useState<SlotsResponse>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped to force a re-fetch of the current teacher/week (slot-conflict recovery).
  const [refetchNonce, setRefetchNonce] = useState(0)

  const [selectedStartIso, setSelectedStartIso] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [profileTeacher, setProfileTeacher] = useState<Teacher | null>(null)
  const [confirmHover, setConfirmHover] = useState(false)

  const selectedTeacher = teachers.find((t) => t.id === selectedTeacherId) ?? teachers[0]

  // Fetch availability slots from the API whenever week or teacher changes
  // (or a slot conflict bumps refetchNonce).
  //
  // The first fetch on page entry can lose the Supabase refresh-token race in
  // proxy.ts and resolve as a non-2xx (typically a 401): the body is JSON with
  // no `.slots`, so reading it without an `r.ok` check would silently render an
  // empty week with no error. A plain re-fetch once the rotated cookies settle
  // is what recovers it (proven: week-nav and remount both heal the grid), so
  // we self-heal with a short bounded retry. We deliberately do NOT call
  // refreshSession() here — forcing a refresh could consume the single-use
  // token and worsen the race.
  useEffect(() => {
    setLoading(true)
    setError(null)

    const controller = new AbortController()
    // weekStartKey is already a student-tz Monday key — the exact frame the
    // server windows and buckets by (NEW317), so it goes on the wire as is.
    const url = `/api/student/availability?teacherId=${selectedTeacherId}&weekStart=${weekStartKey}&timezone=${encodeURIComponent(studentTimezone)}`

    // Immediate first attempt, then up to two retries with short back-off.
    const RETRY_DELAYS = [400, 800]

    // Abortable delay so a back-off in flight is cancelled on cleanup.
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const timer = setTimeout(resolve, ms)
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true }
        )
      })

    async function load() {
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const r = await fetch(url, { signal: controller.signal })
          if (r.ok) {
            const data = await r.json()
            if (controller.signal.aborted) return // superseded — don't clobber newer state
            setSlots(data.slots ?? {})
            setLoading(false)
            return
          }
          // Non-2xx (e.g. a transient 401 from the refresh-token race): do NOT
          // treat the body as slots — fall through to the retry/fail logic.
        } catch {
          if (controller.signal.aborted) return // our own abort — drop silently
          // Network error — fall through to the retry/fail logic.
        }

        const delay = RETRY_DELAYS[attempt]
        if (delay === undefined) {
          // No await sits between the non-ok fetch and here, so abort cannot
          // flip mid-path today; guard anyway so a superseded run never paints
          // a stale error over the newer run's data.
          if (controller.signal.aborted) return
          // Retries exhausted — surface a real, retryable message, never a silent blank.
          setError('Could not load availability. Please try again.')
          setLoading(false)
          return
        }
        try {
          await wait(delay)
        } catch {
          return // aborted during back-off
        }
      }
    }

    void load()

    return () => controller.abort()
  }, [selectedTeacherId, weekStartKey, studentTimezone, refetchNonce])

  // ── Grid data (all pure Stage A helpers — local recompute, no fetch) ──
  const columnKeys = getWeekColumnKeys(weekStartKey)
  const instantSet = buildInstantSet(slots)
  const validStartsByColumn = getValidStartsByColumn(columnKeys, slots, instantSet, selectedDuration)
  // Only used for the whole-week-empty check: the grid always renders all 7
  // columns (a day with nothing bookable is a normal all-grey column).
  const visibleColumns = getVisibleColumns(validStartsByColumn)
  const bands = collapseEmptyBands(validStartsByColumn, studentTimezone)

  // Per-column lookup: student-local wall minutes → the slot on that row.
  // Built for all 7 columns — a day with no bookable starts just yields no
  // cell hits, so every row renders grey there. On a DST fall-back day two
  // instants can share a wall-clock row; the later write wins the cell — a
  // known Stage B limitation, the earlier instant is simply not offered in
  // the grid.
  const cellMaps = new Map<string, Map<number, GridStartSlot>>()
  for (const key of columnKeys) {
    const m = new Map<number, GridStartSlot>()
    for (const slot of validStartsByColumn[key]) {
      const parts = utcInstantToTzParts(slot.startIso, studentTimezone)
      m.set(parts.hour * 60 + parts.minute, slot)
    }
    cellMaps.set(key, m)
  }

  // Backstop invalidation: whenever fresh availability lands or the duration
  // changes, drop a selection that is no longer a valid start for the current
  // duration. isBookableStart fails closed on missing instants, so a selection
  // from a superseded week or teacher — whose instants are absent from the new
  // response — always clears here too.
  useEffect(() => {
    if (selectedStartIso === null) return
    if (!isBookableStart(selectedStartIso, selectedDuration / SLOT_MINUTES, buildInstantSet(slots))) {
      setSelectedStartIso(null)
    }
  }, [slots, selectedDuration, selectedStartIso])

  // Selected-run bounds in epoch ms, computed once per render: a bookable cell
  // renders selected when its instant falls inside [runStartMs, runEndMs).
  // Instants compare via getTime() — never string-compare ISO values. Selection
  // STATE stays selectedStartIso only; this is render-only.
  const runStartMs = selectedStartIso !== null ? new Date(selectedStartIso).getTime() : null
  const runEndMs = runStartMs !== null ? runStartMs + selectedDuration * 60000 : null

  // The column header / week label Dates are anchored at NOON student-local
  // time purely for the Intl labels (all pinned to studentTimezone): noon
  // sidesteps DST-shifted midnights, and getLocalDateKey(date, studentTimezone)
  // round-trips to the column's key.
  const columnDate = (key: string) => new Date(localToUtc(key + 'T12:00', studentTimezone))

  const weekdayFormatter = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: studentTimezone })
  const dayMonthFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: studentTimezone })
  const longDateFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: studentTimezone,
  })
  const timeFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: studentTimezone,
  })

  // Week label e.g. "31 Mar – 6 Apr 2026" — formatted off the noon-anchored
  // column Dates, pinned to the student tz like every other label on the page.
  const weekLabel = `${dayMonthFormatter.format(columnDate(columnKeys[0]))} – ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: studentTimezone }).format(columnDate(columnKeys[6]))}`

  const currentWeekKey = getWeekStartKey(studentTimezone)
  const isPrevDisabled = weekStartKey <= currentWeekKey
  const isCurrentWeek = weekStartKey === currentWeekKey

  // ── Handlers ──

  function changeWeek(nextKey: string) {
    if (nextKey === weekStartKey) return
    setWeekStartKey(nextKey)
    // The selection belongs to the old week's frame — clear eagerly rather
    // than letting a stale pick sit in the confirm panel while the new week
    // loads (the backstop effect would only clear it after the fetch lands).
    setSelectedStartIso(null)
  }

  const goBack = () => {
    const prev = addDaysToDateKey(weekStartKey, -7)
    // Don't allow going before the current week (YYYY-MM-DD compares as a string)
    changeWeek(prev >= currentWeekKey ? prev : currentWeekKey)
  }
  const goForward = () => changeWeek(addDaysToDateKey(weekStartKey, 7))
  const goThisWeek = () => changeWeek(currentWeekKey)

  function handleTeacherSelect(id: string) {
    if (isReschedule) return // teacher locked on the reschedule path
    if (id === selectedTeacherId) return
    setSelectedTeacherId(id)
    // New teacher → new availability; validity of the old pick is unknowable
    // until the refetch lands, so fail safe and clear immediately.
    setSelectedStartIso(null)
  }

  function handleDurationSelect(minutes: number) {
    if (isReschedule) return // duration locked on the reschedule path
    if (minutes === selectedDuration) return
    setSelectedDuration(minutes)
    // Local-only recompute: keep the selection if it is still a valid start
    // for the new duration, otherwise clear it.
    if (
      selectedStartIso !== null &&
      !isBookableStart(selectedStartIso, minutes / SLOT_MINUTES, instantSet)
    ) {
      setSelectedStartIso(null)
    }
  }

  async function handleConfirm() {
    if (!selectedTeacherId || !selectedDuration || !selectedStartIso) return
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const res = await fetch('/api/student/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trainingId,
          teacherId: selectedTeacherId,
          studentId,
          durationMinutes: selectedDuration,
          scheduledAt: selectedStartIso,
          rescheduleId: rescheduleLesson?.id ?? null,
        }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        setSubmitError(data.message ?? data.error ?? 'Something went wrong. Please try again.')
        setIsSubmitting(false)
        if (res.status === 409) {
          // Slot conflict — the grid is stale: clear the selection and
          // refetch availability so the taken slot greys out.
          setSelectedStartIso(null)
          setRefetchNonce((n) => n + 1)
        }
        return
      }

      // Success — go back to my classes
      router.push('/student/my-classes')
      router.refresh()
    } catch {
      setSubmitError('Something went wrong. Please try again.')
      setIsSubmitting(false)
    }
  }

  // ── Confirm-panel derived values (mirrors the wizard's StepConfirm maths:
  // hoursRemaining is the page's effective balance, which already added a
  // reschedule's own hours back in) ──
  const hoursUsed = selectedDuration / 60
  const hoursAfter = hoursRemaining - hoursUsed
  const selectedStart = selectedStartIso !== null ? new Date(selectedStartIso) : null
  const selectedEnd =
    selectedStart !== null ? new Date(selectedStart.getTime() + selectedDuration * 60000) : null

  // Original lesson being moved (reschedule mode): instants for the context
  // strip. The teacher is resolved against the assigned list independently of
  // the locked selection, so the strip always names the ORIGINAL teacher even
  // if the selection lock fell back to teachers[0]; an unresolvable teacher
  // just drops the name from the strip.
  const originalStart = rescheduleLesson !== null ? new Date(rescheduleLesson.scheduled_at) : null
  const originalEnd =
    originalStart !== null && rescheduleLesson !== null
      ? new Date(originalStart.getTime() + rescheduleLesson.duration_minutes * 60000)
      : null
  const originalTeacher =
    rescheduleLesson !== null
      ? teachers.find((t) => t.id === rescheduleLesson.teacher_id) ?? null
      : null

  const durationOptions = [
    { minutes: 30, label: '30 min', hours: 0.5 },
    { minutes: 60, label: '60 min', hours: 1 },
    { minutes: 90, label: '90 min', hours: 1.5 },
  ]

  // Shared icon+label+value cell used by every confirm-panel row.
  const renderCell = (Icon: LucideIcon, label: string, value: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '8px',
          backgroundColor: '#FFF0DC',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={18} color="#FF8303" />
      </div>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: '12px', color: '#6b7280' }}>{label}</p>
        <p style={{ fontSize: '15px', fontWeight: '700', color: '#111827' }}>{value}</p>
      </div>
    </div>
  )

  return (
    // Two top-level columns: everything except the summary aside lives in the
    // left column; the aside is the root's second child. Static Tailwind
    // classes are LAYOUT ONLY — state-dependent colours all stay inline.
    <div className="flex flex-col lg:flex-row lg:items-start gap-4">
      {/* ── Left column: header, strips, toolbar, grid ── */}
      <div className="flex-1 min-w-0">
      {/* ── Header row: title + timezone line ── */}
      <div style={{ marginBottom: '10px' }}>
        <h1 style={{ fontSize: '16px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
          {isReschedule ? 'Reschedule Class' : 'Book a Class'}
        </h1>
        <p style={{ fontSize: '12px', color: '#9ca3af' }}>
          Times shown in your timezone: {studentTimezone}
        </p>
      </div>

      {/* ── Original-lesson context strip (reschedule mode only) ── */}
      {rescheduleLesson !== null && originalStart !== null && originalEnd !== null && (
        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #E0DFDC',
            borderRadius: '10px',
            padding: '10px 16px',
            marginBottom: '12px',
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: '700',
              color: '#9ca3af',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: '8px',
            }}
          >
            Rescheduling this class:
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            {originalTeacher !== null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <User size={14} color="#FF8303" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>
                  {originalTeacher.full_name}
                </span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Calendar size={14} color="#FF8303" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: '13px', color: '#374151' }}>
                {longDateFormatter.format(originalStart)} · {timeFormatter.format(originalStart)} – {timeFormatter.format(originalEnd)}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Clock size={14} color="#FF8303" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: '13px', color: '#374151' }}>
                {formatHours(rescheduleLesson.duration_minutes / 60)}
              </span>
            </div>
          </div>
        </div>
      )}

      {hoursRemaining < 0.5 && (
        <div
          style={{
            marginBottom: '14px',
            padding: '14px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
          }}
        >
          <p style={{ fontSize: '13px', color: '#FD5602' }}>
            You do not have enough hours remaining to book a class. Please contact admin to purchase more hours.
          </p>
        </div>
      )}

      {/* ── Toolbar card: labelled teacher · duration · week groups, one
          wrapping row ── */}
      <div
        className="shadow-sm"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          rowGap: '8px',
          columnGap: '20px',
          marginBottom: '10px',
          backgroundColor: '#ffffff',
          border: '1px solid #f3f4f6',
          borderRadius: '12px',
          padding: '10px 14px',
        }}
      >
        {/* ── Teacher group — hidden entirely (label included) for
            single-teacher trainings ── */}
        {teachers.length > 1 && (
          <div>
            <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', marginBottom: '6px' }}>
              Teacher
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {teachers.map((teacher) => {
            const isSelected = teacher.id === selectedTeacherId
            // On a reschedule the teacher is locked: non-selected pills render
            // dimmed and inert, but "View profile" stays available on all.
            const interactive = !isReschedule
            return (
              <div
                key={teacher.id}
                role="button"
                tabIndex={interactive ? 0 : -1}
                aria-pressed={isSelected}
                aria-disabled={!interactive}
                onClick={() => handleTeacherSelect(teacher.id)}
                onKeyDown={(e) => {
                  // Ignore keydowns bubbling up from the nested "View profile" button.
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleTeacherSelect(teacher.id)
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 12px 6px 6px',
                  borderRadius: '999px',
                  border: '2px solid',
                  borderColor: isSelected ? '#FF8303' : '#E0DFDC',
                  backgroundColor: isSelected ? '#FFF0DC' : '#ffffff',
                  cursor: interactive ? 'pointer' : 'default',
                  opacity: interactive || isSelected ? 1 : 0.5,
                }}
              >
                {teacher.photo_url ? (
                  <div style={{ width: '30px', height: '30px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                    <Image
                      src={teacher.photo_url}
                      alt={teacher.full_name}
                      width={30}
                      height={30}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                ) : (
                  <div
                    style={{
                      width: '30px',
                      height: '30px',
                      borderRadius: '50%',
                      backgroundColor: '#f3f4f6',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      fontSize: '11px',
                      fontWeight: '700',
                      color: '#6b7280',
                    }}
                  >
                    {getInitials(teacher.full_name)}
                  </div>
                )}
                <span style={{ fontSize: '14px', fontWeight: '600', color: '#111827', whiteSpace: 'nowrap' }}>
                  {teacher.full_name}
                </span>
                <button
                  type="button"
                  aria-label={`View ${teacher.full_name}'s profile`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setProfileTeacher(teacher)
                  }}
                  style={{
                    padding: '2px',
                    background: 'none',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    color: '#FF8303',
                  }}
                >
                  <Info size={15} />
                </button>
              </div>
            )
          })}
            </div>
          </div>
        )}

        {/* ── Duration group — local-only recompute, no refetch ── */}
        <div>
          <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', marginBottom: '6px' }}>
            Duration
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {durationOptions.map((option) => {
          const canBook = hoursRemaining >= option.hours
          const isSelected = selectedDuration === option.minutes
          // Reschedule locks the original duration: the other pills are inert.
          const disabled = !canBook || (isReschedule && !isSelected)
          return (
            <button
              key={option.minutes}
              onClick={() => handleDurationSelect(option.minutes)}
              disabled={disabled}
              title={!canBook ? 'Not enough hours remaining' : undefined}
              style={{
                padding: '8px 14px',
                borderRadius: '999px',
                border: '2px solid',
                borderColor: isSelected ? '#FF8303' : '#E0DFDC',
                backgroundColor: isSelected ? '#FFF0DC' : '#ffffff',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled && !isSelected ? 0.5 : 1,
                fontSize: '14px',
                fontWeight: '600',
                color: '#111827',
              }}
            >
              {option.label}
            </button>
          )
        })}
          </div>
        </div>

        {/* ── Week group — prev · label · This week · next ── */}
        <div>
          <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', marginBottom: '6px' }}>
            Week
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={goBack}
          disabled={isPrevDisabled}
          aria-label="Previous week"
          style={{
            padding: '6px 10px',
            border: '1px solid #E0DFDC',
            borderRadius: '6px',
            backgroundColor: '#ffffff',
            cursor: isPrevDisabled ? 'not-allowed' : 'pointer',
            opacity: isPrevDisabled ? 0.4 : 1,
          }}
        >
          <ChevronLeft size={16} color="#4b5563" />
        </button>
          <span style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>{weekLabel}</span>
          {!isCurrentWeek && (
            <button
              onClick={goThisWeek}
              style={{
                padding: '4px 10px',
                border: '1px solid #E0DFDC',
                borderRadius: '999px',
                backgroundColor: '#ffffff',
                fontSize: '12px',
                fontWeight: '500',
                color: '#4b5563',
                cursor: 'pointer',
              }}
            >
              This week
            </button>
          )}
        <button
          onClick={goForward}
          aria-label="Next week"
          style={{
            padding: '6px 10px',
            border: '1px solid #E0DFDC',
            borderRadius: '6px',
            backgroundColor: '#ffffff',
            cursor: 'pointer',
          }}
        >
          <ChevronRight size={16} color="#4b5563" />
        </button>
          </div>
        </div>
      </div>

      {/* ── Grid area: loading / error / empty / grid ── */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '14px' }}>
              Loading availability...
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '14px 16px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                fontSize: '13px',
                color: '#FD5602',
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && visibleColumns.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 16px' }}>
              <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '6px' }}>
                No openings this week.
              </p>
              <p style={{ fontSize: '13px', color: '#9ca3af' }}>
                Use the arrow above to check the next week.
              </p>
            </div>
          )}

          {!loading && !error && visibleColumns.length > 0 && (
            // Horizontally scrollable on mobile; the time column stays sticky.
            <div
              style={{
                overflowX: 'auto',
                border: '1px solid #E0DFDC',
                borderRadius: '12px',
                backgroundColor: '#ffffff',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  // Fixed 7-day Mon–Sun frame: every column renders every week,
                  // all at identical widths — empty days are all-grey columns.
                  gridTemplateColumns: '56px repeat(7, minmax(88px, 1fr))',
                  gap: '2px',
                  padding: '8px',
                }}
              >
                {/* Header row: sticky corner + one label per day column */}
                <div
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 2,
                    backgroundColor: '#ffffff',
                  }}
                />
                {columnKeys.map((key) => {
                  const day = columnDate(key)
                  return (
                    <div key={key} style={{ textAlign: 'center', padding: '2px' }}>
                      <p
                        style={{
                          fontSize: '10px',
                          fontWeight: '500',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: '#6b7280',
                        }}
                      >
                        {weekdayFormatter.format(day)}
                      </p>
                      <p style={{ fontSize: '13px', fontWeight: '600', color: '#111827' }}>
                        {dayMonthFormatter.format(day)}
                      </p>
                    </div>
                  )
                })}

                {/* Time rows, band by band, with a gap marker between bands */}
                {bands.map((band, bandIdx) => (
                  <div key={band[0]} style={{ display: 'contents' }}>
                    {bandIdx > 0 && (
                      <div
                        style={{
                          gridColumn: '1 / -1',
                          textAlign: 'center',
                          padding: '2px 0',
                          fontSize: '10px',
                          letterSpacing: '3px',
                          color: '#d1d5db',
                          backgroundColor: '#fbfaf9',
                          borderRadius: '6px',
                        }}
                      >
                        · · ·
                      </div>
                    )}
                    {band.map((minutes) => (
                      <div key={minutes} style={{ display: 'contents' }}>
                        {/* Sticky time column */}
                        <div
                          style={{
                            position: 'sticky',
                            left: 0,
                            zIndex: 2,
                            backgroundColor: '#ffffff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            paddingRight: '8px',
                            fontSize: '11px',
                            fontWeight: '500',
                            color: '#6b7280',
                          }}
                        >
                          {formatRowLabel(minutes)}
                        </div>
                        {columnKeys.map((key) => {
                          const slot = cellMaps.get(key)?.get(minutes)
                          // bookable:false deliberately merges "blocked/booked" with
                          // "free but the remaining run is too short for the chosen
                          // duration" — the raw available flag was discarded in
                          // Stage A, so both render as the same grey cell. A cell
                          // with no slot at all on this row renders grey too.
                          if (slot === undefined || !slot.bookable) {
                            return (
                              <div
                                key={key}
                                aria-hidden="true"
                                style={{
                                  minHeight: '22px',
                                  borderRadius: '6px',
                                  backgroundColor: CELL_GREY_BG,
                                }}
                              />
                            )
                          }
                          // Exact start cell only — the run's other cells keep
                          // aria-pressed false while still painting selected.
                          const isSelected = slot.startIso === selectedStartIso
                          const t = new Date(slot.startIso).getTime()
                          const inSelectedRun =
                            runStartMs !== null && runEndMs !== null && t >= runStartMs && t < runEndMs
                          // Text-less cell: the slot time lives in the aria-label
                          // (and in the summary column once selected).
                          return (
                            <button
                              key={key}
                              onClick={() => setSelectedStartIso(slot.startIso)}
                              aria-pressed={isSelected}
                              aria-label={`Book ${formatSlotTime(slot.startIso, studentTimezone)}`}
                              style={{
                                minHeight: '22px',
                                borderRadius: '6px',
                                border: inSelectedRun ? '1px solid #FF8303' : 'none',
                                cursor: 'pointer',
                                backgroundColor: inSelectedRun ? CELL_SELECTED_BG : CELL_BOOKABLE_BG,
                              }}
                            />
                          )
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
      {/* ── end left column ── */}
      </div>

        {/* ── Sticky summary column — the confirm panel, styled to read as the
            page's right panel (shell-panel visual language, StudentRightPanel);
            second child of the root two-column flex ── */}
        <aside className="w-full lg:w-[288px] lg:shrink-0 lg:sticky lg:top-0">
          {/* Panel header — matches the shell panel's section-header style */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px' }}>
            <Calendar size={14} color="#FF8303" style={{ flexShrink: 0 }} />
            <p style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Booking Summary</p>
          </div>
          {selectedStart !== null && selectedEnd !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Teacher context strip */}
              <div
                className="shadow-sm"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  flexWrap: 'wrap',
                  padding: '14px 16px',
                  backgroundColor: '#ffffff',
                  border: '1px solid #f3f4f6',
                  borderRadius: '12px',
                }}
              >
                {selectedTeacher.photo_url ? (
                  <div style={{ width: '36px', height: '36px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                    <Image
                      src={selectedTeacher.photo_url}
                      alt={selectedTeacher.full_name}
                      width={36}
                      height={36}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                ) : (
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      backgroundColor: '#f3f4f6',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <User size={18} color="#9ca3af" />
                  </div>
                )}
                <div style={{ flex: 1, minWidth: '120px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <p style={{ fontSize: '14px', fontWeight: '700', color: '#111827' }}>
                    {selectedTeacher.full_name}
                  </p>
                  {selectedTeacher.reviewCount > 0 && (
                    <RatingLine avgRating={selectedTeacher.avgRating} reviewCount={selectedTeacher.reviewCount} starSize={12} />
                  )}
                </div>
              </div>

              {/* Details card — rows stacked vertically for the narrow column */}
              <div
                className="shadow-sm"
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #f3f4f6',
                  borderRadius: '12px',
                  padding: '14px 16px',
                }}
              >
                {/* Date & time */}
                <div style={{ paddingBottom: '9px' }}>
                  {renderCell(
                    Calendar,
                    'Date & time',
                    `${longDateFormatter.format(selectedStart)} · ${timeFormatter.format(selectedStart)} – ${timeFormatter.format(selectedEnd)}`
                  )}
                </div>

                {/* Duration */}
                <div style={{ padding: '9px 0', borderTop: '1px solid #f3f4f6' }}>
                  {renderCell(Clock, 'Duration', formatHours(selectedDuration / 60))}
                </div>

                {/* Hours deducted */}
                <div style={{ padding: '9px 0', borderTop: '1px solid #f3f4f6' }}>
                  {renderCell(Wallet, 'Hours deducted', formatHours(isReschedule ? 0 : hoursUsed))}
                </div>

                {/* Remaining after booking + the balance pill, stacked */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '8px',
                    padding: '9px 0',
                    borderTop: '1px solid #f3f4f6',
                  }}
                >
                  {renderCell(ChartNoAxesColumn, 'Remaining after booking', formatHours(hoursAfter))}
                  <span
                    style={{
                      flexShrink: 0,
                      backgroundColor: '#FFF0DC',
                      borderRadius: '999px',
                      padding: '4px 12px',
                      fontSize: '13px',
                      fontWeight: '600',
                      color: '#FF8303',
                    }}
                  >
                    {isReschedule ? 'Reschedule — no hours deducted' : `${formatHours(hoursRemaining)} → ${formatHours(hoursAfter)}`}
                  </span>
                </div>

                {/* Cancellation footnote */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    paddingTop: '9px',
                    borderTop: '1px solid #f3f4f6',
                  }}
                >
                  <Info size={16} color="#6b7280" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '13px', color: '#6b7280' }}>
                    You can change or cancel up to 24 hours before your lesson.
                  </span>
                </div>
              </div>

              {hoursAfter < 2 && hoursAfter >= 0 && (
                <div
                  style={{
                    padding: '12px 16px',
                    backgroundColor: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: '8px',
                    fontSize: '13px',
                    color: '#92400e',
                  }}
                >
                  After this booking you will have less than 2 hours remaining. Contact admin to purchase more hours.
                </div>
              )}

              {submitError && (
                <div
                  style={{
                    padding: '12px 16px',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '8px',
                    fontSize: '13px',
                    color: '#FD5602',
                  }}
                >
                  {submitError}
                </div>
              )}

              <button
                onClick={handleConfirm}
                disabled={isSubmitting}
                onMouseEnter={() => setConfirmHover(true)}
                onMouseLeave={() => setConfirmHover(false)}
                style={{
                  width: '100%',
                  padding: '12px 32px',
                  backgroundColor: confirmHover && !isSubmitting ? '#FD7000' : '#FF8303',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '10px',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  opacity: isSubmitting ? 0.7 : 1,
                }}
              >
                {isSubmitting ? 'Booking...' : 'Confirm Booking'}
              </button>
            </div>
          ) : (
            <div
              className="shadow-sm"
              style={{
                minHeight: '260px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#ffffff',
                border: '1px solid #f3f4f6',
                borderRadius: '12px',
                padding: '14px 16px',
              }}
            >
              <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center', padding: '0 16px' }}>
                {submitError ?? 'Select a time slot to review and confirm your booking.'}
              </p>
            </div>
          )}
        </aside>

      {profileTeacher && (
        <TeacherProfileModal
          teacher={profileTeacher}
          studentTimezone={studentTimezone}
          onClose={() => setProfileTeacher(null)}
          onSelect={handleTeacherSelect}
        />
      )}
    </div>
  )
}
