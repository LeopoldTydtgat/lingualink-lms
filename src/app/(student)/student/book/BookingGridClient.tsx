'use client'

// BOOK-1: single-page booking grid client, rendered by page.tsx. Reschedule
// locks teacher and duration to the original lesson and shows an
// original-lesson context strip; error display (`data.message ?? data.error`),
// confirm label, success redirect and the 24hr footnote are byte-identical to
// the old wizard's, which special-cases none of them for reschedule.
//
// UX pass: fixed 7-day Mon–Sun grid (empty days render as grey columns, not
// hidden), text-less slot cells (time lives in the aria-label), and a sticky
// summary column beside the grid replacing the old bottom confirm panel.

import { useState, useEffect, type CSSProperties } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { User, ChevronLeft, ChevronRight, X, Star, Clock, Calendar, Wallet, ChartNoAxesColumn, Info, Lock, Check, Plus, Lightbulb, type LucideIcon } from 'lucide-react'
import { addDaysToDateKey, getLocalDateKey, localToUtc, utcInstantToTzParts } from '@/lib/utils/timezone'
import { isBookableStart } from '@/lib/bookingGrid'
import {
  getWeekColumnKeys,
  buildInstantSet,
  getValidStartsByColumn,
  buildRowAxis,
  getVisibleColumns,
  buildCellMaps,
  snapToValidStart,
  SLOT_MINUTES,
  type SlotsResponse,
} from '@/lib/bookingWeekGrid'

// ─── Grid cell colours ────────────────────────────────────────────────────────
// PLACEHOLDERS pending a design decision (BOOK-1 Stage B) — swap these for the
// approved palette when design lands. All state-dependent colours go through
// inline style props (Tailwind v4 cannot apply dynamically constructed classes).
const CELL_BOOKABLE_BG = '#D8EEDC'
// Hover shade for an available cell, one step deeper than the resting green.
// Painted on the cells of the run the pointer is previewing: hoverStartIso is
// the only hover state this page tracks, and inline styles cannot carry a
// per-cell :hover, so "the cell under the pointer" and "the run that cell
// would place" are one and the same highlight here.
const CELL_BOOKABLE_HOVER_BG = '#C4E4CA'
const CELL_GREY_BG = '#EEEDEA'
// Blocked cells in a column the week returned NO slots for at all: a day the
// teacher never offers (a weekend, a day off) rather than one whose openings
// are taken. A shade quieter than CELL_GREY_BG so an untouched column recedes
// instead of reading as seven hours of individually-refused times.
const CELL_EMPTY_COLUMN_BG = '#F7F6F4'
// Hairline drawn across the top edge of every whole-hour row, so the axis has
// a visible beat at :00 without a full gridline every 30 minutes.
const HOUR_LINE = '1px solid #E2E0DC'
// Hover ghost: the run a tap WOULD place, previewed in situ. Dashed brand
// orange over a deepened green fill (CELL_BOOKABLE_HOVER_BG) plus a darker
// orange glyph and time range on the run's first cell -- the fill only ever
// deepens within the green family, so a ghost can never be mistaken for the
// cream, left-accented selection.
const GHOST_BORDER = '2px dashed #FF8303'
const GHOST_GLYPH_COLOR = '#9A5203'
// Selected-run chrome — mirrors the teacher Day-to-Day lesson block
// (src/app/(dashboard)/schedule/tabs/DayToDay.tsx): a pale cream fill instead
// of a solid block, a thin border on the run's outer edges only, and a 3px
// brand-orange left accent carried by every cell so the run still reads as
// one continuous event. The run's label and duration line are painted in the
// same dark neutrals as the teacher block, not white.
const CELL_SELECTED_BG = '#FFF3E0'
const CELL_SELECTED_BORDER = '1px solid #FFD9A8'
const CELL_SELECTED_ACCENT = '3px solid #FF8303'
// Selected-teacher pill ring — green family derived from CELL_BOOKABLE_BG
// (border a stronger green of the same hue, bg a slightly lighter tint).
// PLACEHOLDER pending the client's portal-wide green-vs-orange decision,
// same as the cell colours above.
const TEACHER_SELECTED_BORDER = '#4CAF50'
const TEACHER_SELECTED_BG = '#F1F8F2'
// Today's column marker — the brand orange, now carried by the header cell's
// weekday and date text on a TODAY_PILL_BG ground. Grid cells are never tinted
// by it: "today" is a calendar landmark, not an availability state, and
// colouring cells would collide with the three states the legend names.
const TODAY_ACCENT = '#FF8303'
const TODAY_PILL_BG = '#FFF0DC'
// Reschedule only: the run the class CURRENTLY occupies, so the grid says
// where it already is instead of leaving the student to remember. Verbatim the
// teacher Day-to-Day past-lesson chrome
// (src/app/(dashboard)/schedule/tabs/DayToDay.tsx:1368,1370) — a near-white
// fill under a muted grey left accent, the portal's existing "this already
// exists, it is not an offer" language. Deliberately neither the green of an
// opening nor the cream of the selection: the original run is neither.
const CELL_ORIGINAL_BG = '#F9FAFB'
const CELL_ORIGINAL_ACCENT = '3px solid #D6D3CE'
// Raised by a tap that resolves to the class's OWN current start — the single
// instant a reschedule cannot move to. Shared by both tap paths (direct and
// snapped) so the two can never drift apart. A UX guard only: /api/student/book
// rejects the identical booking regardless, and stays the actual safety net.
const CURRENT_TIME_NOTICE = 'This is the current time for this class. Pick a different time.'

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
  // The server page found no live lesson behind the ?reschedule=<id> still on
  // the URL. A flag, not a redirect: router.refresh() re-runs that server
  // component mid-submit, and only client state — which survives the refresh —
  // can tell "this id was always dead" from "we just cancelled it ourselves,
  // successfully". /api/student/book stays the authority either way.
  rescheduleUnavailable: boolean
  // The class lengths this student may book (NEW-A1), already sanitised by the
  // server page to a subset of 30/60/90. A UX input only — /api/student/book
  // re-reads students.allowed_durations and is the actual gate. Never widened
  // here: an empty array means the account cannot book, not "all allowed".
  allowedDurations: number[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatHours(hours: number): string {
  const sign = hours < 0 ? '-' : ''
  const abs = Math.abs(hours)
  const h = Math.floor(abs)
  const m = Math.round((abs - h) * 60)
  if (h === 0) return `${sign}${m}min`
  if (m === 0) return `${sign}${h}h`
  return `${sign}${h}h ${m}min`
}

// Initial duration for a FRESH booking. The reschedule path locks to the
// original lesson's duration and never calls this. Order of preference:
//   1. 60 when it is both enabled and affordable — the previous default, kept
//      for every student whose account still allows it.
//   2. the LONGEST enabled duration the student can afford.
//   3. the SHORTEST enabled duration, when none is affordable — the pill still
//      names a real allowed length and the hours banner explains the block.
//   4. 30 only for the empty-list edge, where the grid is suppressed anyway.
function pickDefaultDuration(allowedDurations: number[], hoursRemaining: number): number {
  const enabled = [...allowedDurations].sort((a, b) => a - b)
  if (enabled.length === 0) return 30
  if (enabled.includes(60) && hoursRemaining >= 1) return 60
  const affordable = enabled.filter((minutes) => hoursRemaining >= minutes / 60)
  if (affordable.length > 0) return affordable[affordable.length - 1]
  return enabled[0]
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
// Originally copied from the retired BookingClient.tsx wizard (now deleted).
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
  rescheduleUnavailable,
  allowedDurations,
}: Props) {
  const router = useRouter()

  const isReschedule = rescheduleLesson !== null

  // Fresh-book only: an account with no enabled class lengths cannot book at
  // all. The server page passes an empty array straight through rather than
  // widening it to "all durations", so this is where that state surfaces.
  // Reschedule is exempt by design — the original lesson's length is kept
  // regardless of what the account currently allows.
  const noDurationsEnabled = !isReschedule && allowedDurations.length === 0

  // The shortest class this page can actually book, in hours. This was a
  // hard-coded 0.5 in the out-of-hours banner below, which stopped being the
  // floor once NEW-A1 made 30-minute classes disableable per student: a
  // {60}-only account (the column default for every new student) holding 0.75h
  // can book nothing at all, yet 0.75 < 0.5 is false, so the banner stayed
  // hidden while the grid kept offering 60-minute runs the API always rejects.
  // Reschedule keeps its own floor — the locked duration, which the page's
  // effective balance covers by construction — so that path is unchanged.
  const minBookableHours = isReschedule
    ? rescheduleLesson.duration_minutes / 60
    : allowedDurations.length > 0
    ? Math.min(...allowedDurations) / 60
    : 0.5

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
    rescheduleLesson?.duration_minutes ?? pickDefaultDuration(allowedDurations, hoursRemaining)
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
  // Amber notice raised when a tap on a FREE cell cannot resolve to any valid
  // start for the chosen length (snapToValidStart returned null — the free run
  // around that cell is shorter than the class). Cleared on a successful
  // selection and on the three user actions that invalidate it: duration, week
  // and teacher changes. NOT cleared by a background refetch (visibility/focus,
  // or the 409/400 recovery), so a notice can outlive the availability it
  // described until the student acts again — the text names a length and a
  // week, never a specific slot, so a stale one is misleading at worst.
  const [snapNotice, setSnapNotice] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // The ?reschedule=<id> on the URL has no live lesson behind it AND we are not
  // the reason it went away. isSubmitting is the entire discriminator: it is set
  // for the whole POST and reset to false ONLY on failure — a SUCCESSFUL
  // reschedule deliberately leaves it true through the redirect — so a realtime
  // router.refresh() landing mid-submit or after success re-runs the server
  // component, re-derives rescheduleUnavailable as true, and still finds this
  // false. That works because client state survives router.refresh(). No other
  // condition belongs here.
  const rescheduleDead = rescheduleUnavailable && !isSubmitting
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [profileTeacher, setProfileTeacher] = useState<Teacher | null>(null)
  const [confirmHover, setConfirmHover] = useState(false)
  // Hover preview ONLY. The start instant the run would get if the cell under
  // the pointer were tapped, resolved by exactly the same rule the click
  // handler uses. Nothing on the hover path ever writes selectedStartIso, so a
  // pointer sweeping the grid can never change what is selected or booked.
  const [hoverStartIso, setHoverStartIso] = useState<string | null>(null)
  // Evaluated once, outside render. On a touch device (hover: none) a tap fires
  // mouseenter, so the ghost would paint a preview of the selection that same
  // tap is about to make and then sit there with no mouseleave to clear it —
  // pure cost. SSR has no matchMedia, so this starts false and the first client
  // render decides; hoverStartIso is null either way, so no ghost is in the
  // markup on either side of hydration and nothing can mismatch.
  const [canHover] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover)').matches
  )

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
    // On a reschedule, tell the server which lesson is being moved so its own
    // slots are not blocked against itself (server verifies ownership).
    const excludeParam = rescheduleLesson !== null ? `&excludeLessonId=${rescheduleLesson.id}` : ''
    const url = `/api/student/availability?teacherId=${selectedTeacherId}&weekStart=${weekStartKey}&timezone=${encodeURIComponent(studentTimezone)}${excludeParam}`

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
  }, [selectedTeacherId, weekStartKey, studentTimezone, refetchNonce, rescheduleLesson])

  // Refetch when the tab is refocused or becomes visible again. The 24h cutoff is
  // computed on the server at fetch time, so a grid left open can keep showing a
  // slot green after it crosses inside 24h. A fresh fetch re-greys it, and the
  // selection backstop below drops a pick that is no longer bookable. No interval:
  // the user must return to the tab to act, and this catches exactly that moment.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setRefetchNonce((n) => n + 1)
    }
    const onFocus = () => setRefetchNonce((n) => n + 1)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // ── Grid data (all pure Stage A helpers — local recompute, no fetch) ──
  const columnKeys = getWeekColumnKeys(weekStartKey)
  const instantSet = buildInstantSet(slots)
  const validStartsByColumn = getValidStartsByColumn(columnKeys, slots, instantSet, selectedDuration)
  // Only used for the whole-week-empty check: the grid always renders all 7
  // columns (a day with nothing bookable is a normal all-grey column).
  const visibleColumns = getVisibleColumns(validStartsByColumn)
  // The grid's time axis: one row per 30-min wall-clock line from the week's
  // earliest slot to its latest, gaps included. Every slot contributes its row
  // regardless of availability or bookability, so the axis is a property of the
  // WEEK, not of the chosen length — flipping 30/60/90 repaints the cells but
  // never resizes or reflows the grid. This replaces the old collapsed bands,
  // whose rows appeared and disappeared with the duration and needed a "· · ·"
  // separator to explain the jumps.
  const rowAxis = buildRowAxis(validStartsByColumn, studentTimezone)
  // Empty-state copy only: suggest a shorter class only when one actually
  // has openings this week, not merely when it's enabled on the account.
  // Reschedule locks the duration, so that path never offers it.
  const shorterLengthAllowed =
    !isReschedule &&
    allowedDurations
      .filter((m) => m < selectedDuration)
      .some((m) => getVisibleColumns(getValidStartsByColumn(columnKeys, slots, instantSet, m)).length > 0)

  // Per-column lookup: student-local wall minutes → the slot on that row.
  // Built for all 7 columns — a day with no slots just yields no cell hits, so
  // every row renders grey there. On a DST fall-back day the duplicated wall
  // hour is claimed by two instants and only one gets the cell: the AVAILABLE
  // one, falling back to the earlier instant when both are equally available
  // (see the buildCellMaps docstring).
  const cellMaps = buildCellMaps(columnKeys, validStartsByColumn, studentTimezone)
  // Columns the week returned no slots for AT ALL — resolved once per render,
  // never per cell. Their blocked cells take the quieter CELL_EMPTY_COLUMN_BG:
  // an all-grey column with a populated map is "fully booked", one with an
  // empty map is "not offered", and the two should not look identical.
  const emptyColumns = new Set(columnKeys.filter((key) => cellMaps.get(key)?.size === 0))

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

  // Dead reschedule id: leave for My Classes carrying the notice the server page
  // used to redirect with. replace (not push) so the dead ?reschedule= URL does
  // not stay live in the history stack underneath the destination — the same
  // reasoning handleConfirm's success navigation already uses.
  useEffect(() => {
    if (!rescheduleDead) return
    router.replace('/student/my-classes?notice=reschedule_unavailable')
  }, [rescheduleDead, router])

  // Selected-run bounds in epoch ms, computed once per render: an AVAILABLE
  // cell renders selected when its instant falls inside [runStartMs, runEndMs).
  // Instants compare via getTime() — never string-compare ISO values. Selection
  // STATE stays selectedStartIso only; this is render-only.
  const runStartMs = selectedStartIso !== null ? new Date(selectedStartIso).getTime() : null
  const runEndMs = runStartMs !== null ? runStartMs + selectedDuration * 60000 : null

  // Ghost-run bounds — the same epoch-ms shape as the selected run above, for
  // the run the pointer is hovering. Gated on canHover so a touch device never
  // computes them at all, and always yielded to by the real selection: a cell
  // inside the selected run is never drawn as a ghost.
  const ghostStartMs = canHover && hoverStartIso !== null ? new Date(hoverStartIso).getTime() : null
  const ghostEndMs = ghostStartMs !== null ? ghostStartMs + selectedDuration * 60000 : null

  // Chrome for a cell inside the selected run, so the run reads as ONE
  // continuous event block. Applied on the AVAILABLE-cell branch only: every
  // 30-min step of a valid run is available by construction, so a grey cell can
  // never fall inside one. A single 1px #FFD9A8 outline around the block (top
  // edge only on the first cell, bottom edge only on the last, right edge on
  // all), a 3px solid
  // #FF8303 left accent on every run cell (teacher Day-to-Day event style),
  // and corner rounding only at the block's ends. Non-first cells take a -2px
  // top margin — equal to the grid's 2px row gap — chosen over taller cells
  // because a negative margin overlaps the gap without changing the grid's
  // row-track sizing. First/last derive PURELY from the cell instant vs
  // runStartMs/runEndMs (epoch-ms only). Known caveat: a cross-midnight run
  // (NEW324) splits across two day columns and its second-day segment renders
  // without a top cap — accepted, mirrors the NEW324 last-day-of-week limit.
  const runCellChrome = (isFirst: boolean, isLast: boolean): CSSProperties => ({
    backgroundColor: CELL_SELECTED_BG,
    borderLeft: CELL_SELECTED_ACCENT,
    borderRight: CELL_SELECTED_BORDER,
    borderTop: isFirst ? CELL_SELECTED_BORDER : 'none',
    borderBottom: isLast ? CELL_SELECTED_BORDER : 'none',
    borderRadius:
      isFirst && isLast ? '8px' : isFirst ? '8px 8px 0 0' : isLast ? '0 0 8px 8px' : '0',
    marginTop: isFirst ? '0' : '-2px',
  })

  // Time-range text painted on the run's FIRST cell only. Dark neutral for
  // contrast on the cream CELL_SELECTED_BG, matching the teacher Day-to-Day
  // lesson block's title text; aria-hidden where rendered — the start cell's
  // aria-label already announces the slot.
  const runLabelStyle: CSSProperties = {
    fontSize: '11px',
    fontWeight: '600',
    lineHeight: 1,
    color: '#111827',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  }
  // Same treatment one step down, for the duration line on the run's LAST cell
  // — matches the teacher block's secondary text colour.
  const runSubLabelStyle: CSSProperties = {
    fontSize: '10px',
    fontWeight: '600',
    lineHeight: 1,
    color: '#4B5563',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  }
  // Ghost equivalents of the two styles above, painted on the hover-preview
  // run instead of the selected one — same shape, darker glyph orange
  // (GHOST_GLYPH_COLOR) so a ghost can never be mistaken for the solid-orange
  // selection label.
  const ghostLabelStyle: CSSProperties = {
    fontSize: '10px',
    fontWeight: '600',
    lineHeight: 1,
    color: GHOST_GLYPH_COLOR,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  }
  const ghostSubLabelStyle: CSSProperties = {
    fontSize: '9px',
    lineHeight: 1,
    color: GHOST_GLYPH_COLOR,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textAlign: 'center',
  }
  // Original-run label — the class's current time range, on that run's FIRST
  // cell. Same single-clipped-line shape as every other run label (lineHeight
  // 1, nowrap, overflow hidden) so it can never grow the 30px row, in the muted
  // grey of the chrome it sits on.
  //
  // The 'Current time · ' prefix is deliberately dropped. runFirstCellLayout
  // centres its content and clips BOTH edges, and at the grid's own minimum
  // column width (minmax(88px, 1fr) → ~79px of content box) a 28-character 10px
  // string overflows by roughly half its length — centred, that eats the range
  // from both ends and leaves a mangled middle rather than a shorter true
  // label. The range alone (~65px) always renders whole at every width the grid
  // can reach. The context strip above the grid still carries the words, and
  // the start cell's aria-label carries them for screen readers.
  const originalLabelStyle: CSSProperties = {
    fontSize: '10px',
    fontWeight: '600',
    lineHeight: 1,
    color: '#9CA3AF',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  }
  // Layout added to the first run cell so the tick and label sit centred on a
  // single clipped line.
  const runFirstCellLayout: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '3px',
    padding: '0 4px 0 5px',
    overflow: 'hidden',
  }
  // Layout for the run's last cell, which carries the duration line.
  const runLastCellLayout: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
    overflow: 'hidden',
  }
  // Layout for an unselected available cell. It carries no content any more
  // (the centre dot went with the cell border — a bare fill reads as available
  // on its own), but the centring is kept so the branch stays symmetric with
  // the two run layouts above and any future glyph lands centred.
  const bookableCellLayout: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
  // Toolbar group caption. One shared treatment across the card's groups so
  // Duration and Week (and Teacher, when a multi-teacher training renders it)
  // read as one centred unit under a single rule rather than three captions
  // that merely happen to sit on the same line.
  const toolbarGroupLabel: CSSProperties = {
    fontSize: '11px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: '6px',
  }
  // Sticky time-column label chrome. Whole hours are the axis's beat — darker,
  // heavier, and carrying the hour hairline — while the half-hours between them
  // recede to a light grey, so a column of times reads as hours first and
  // subdivisions second. A helper rather than four inline ternaries because the
  // label cell is not inside a block-bodied map.
  const rowLabelChrome = (minutes: number): CSSProperties => {
    const isHourRow = minutes % 60 === 0
    return {
      borderTop: isHourRow ? HOUR_LINE : 'none',
      fontSize: isHourRow ? '11px' : '10px',
      fontWeight: isHourRow ? '600' : '400',
      color: isHourRow ? '#111827' : '#c4c2bc',
    }
  }

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

  // Week label off the noon-anchored column Dates, pinned to the student tz
  // like every other label on the page — Intl formatters only, never
  // toLocaleDateString / Date getters. Compact same-month form "20 – 26 Jul
  // 2026" (month named once); cross-month keeps "27 Jul – 2 Aug 2026".
  const weekEndFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: studentTimezone })
  const dayOnlyFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: studentTimezone })
  const monthYearKeyFormatter = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: studentTimezone })
  const weekStartDay = columnDate(columnKeys[0])
  const weekEndDay = columnDate(columnKeys[6])
  const weekLabel =
    monthYearKeyFormatter.format(weekStartDay) === monthYearKeyFormatter.format(weekEndDay)
      ? `${dayOnlyFormatter.format(weekStartDay)} – ${weekEndFormatter.format(weekEndDay)}`
      : `${dayMonthFormatter.format(weekStartDay)} – ${weekEndFormatter.format(weekEndDay)}`

  const currentWeekKey = getWeekStartKey(studentTimezone)
  const isPrevDisabled = weekStartKey <= currentWeekKey
  const isCurrentWeek = weekStartKey === currentWeekKey
  // Today's column key in the STUDENT timezone — the same frame the column
  // keys live in, so the comparison below is a plain string match. Never
  // browser-local Date math: a student in Tokyo reading the page from a UTC
  // browser must see THEIR today highlighted, not the browser's. Recomputed
  // per render like currentWeekKey; a page left open across midnight moves the
  // marker on the next render, which the visibility refetch already triggers.
  const todayKey = getLocalDateKey(new Date(), studentTimezone)

  // Loading has two shapes. The FIRST load has nothing on screen to preserve,
  // so it gets the bare centred line. Every LATER load — week nav, a teacher
  // swap, the visibility/focus refetch, the 409/400 recovery — already has a
  // week rendered, and unmounting it to that same bare line flashes the whole
  // panel. Those keep the current view mounted, dimmed and inert, under a small
  // overlay. `slots` is deliberately never cleared by the fetch effect, so its
  // emptiness is exactly the "nothing has ever landed" test.
  const hasSlotData = Object.keys(slots).length > 0
  const isFirstLoad = loading && !hasSlotData
  const isRefreshing = loading && hasSlotData

  // ── Handlers ──

  function changeWeek(nextKey: string) {
    if (nextKey === weekStartKey) return
    setWeekStartKey(nextKey)
    // The selection belongs to the old week's frame — clear eagerly rather
    // than letting a stale pick sit in the confirm panel while the new week
    // loads (the backstop effect would only clear it after the fetch lands).
    setSelectedStartIso(null)
    // The notice named a length that did not fit in the OLD week's slots.
    setSnapNotice(null)
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
    // Same reasoning for the notice: it described the OLD teacher's slots.
    setSnapNotice(null)
  }

  function handleDurationSelect(minutes: number) {
    if (isReschedule) return // duration locked on the reschedule path
    // Fail closed: a length outside the student's allowed list can never become
    // the selection. The pill is already disabled, so this only catches a
    // programmatic call. Deliberately placed AFTER the reschedule guard, so the
    // reschedule path never consults allowedDurations at all.
    if (!allowedDurations.includes(minutes)) return
    if (minutes === selectedDuration) return
    setSelectedDuration(minutes)
    // The notice names the OLD length ("A 90-minute class does not fit here"),
    // and a shorter one is exactly what it told the student to try.
    setSnapNotice(null)
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
        if (res.status === 409 || res.status === 400) {
          // 409: slot conflict. 400: a server rule rejected the pick (24h
          // window, hours, duration), which means the grid was stale too. Both:
          // clear the selection and refetch so the grid reflects the server.
          setSelectedStartIso(null)
          setRefetchNonce((n) => n + 1)
        }
        return
      }

      // Success — leave for My Classes. replace (not push) so the booking
      // route and its ?reschedule= param leave the history stack rather than
      // remaining live underneath. No router.refresh() either: the navigation
      // already fetches the destination's server components, whereas refresh()
      // re-ran the SOURCE route's server component — /student/book, still
      // carrying ?reschedule=<id> — whose dead-id guard then fired on the row
      // reschedule_class_atomic had just cancelled, producing a false "no longer
      // be rescheduled" banner on a SUCCESSFUL reschedule.
      router.replace('/student/my-classes')
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

  // Range text for the run's first cell, e.g. "15:30 – 17:00" — built with the
  // studentTimezone-pinned Intl formatter (never toLocaleTimeString, never
  // Date getters).
  const selectedRangeLabel =
    selectedStart !== null && selectedEnd !== null
      ? `${timeFormatter.format(selectedStart)} – ${timeFormatter.format(selectedEnd)}`
      : null

  // Same shape as selectedRangeLabel above, for the hover ghost's first cell.
  // hoverStartIso is the tap-resolved preview start (see ghostStartMs); the
  // formatter is the same studentTimezone-pinned instance, never a new one.
  const hoverStart = hoverStartIso !== null ? new Date(hoverStartIso) : null
  const ghostRangeLabel =
    hoverStart !== null
      ? `${timeFormatter.format(hoverStart)} – ${timeFormatter.format(new Date(hoverStart.getTime() + selectedDuration * 60000))}`
      : null

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

  // Reschedule only: the class's own current start in the EXACT ISO shape every
  // slot start on this page carries, plus the run it occupies.
  //
  // SHAPE. slot.startIso is minted as `new Date(startMs).toISOString()` by the
  // availability engine (api/student/availability/slotEngine.ts:148,164), and
  // snapToValidStart returns `new Date(...).toISOString()` as well
  // (lib/bookingWeekGrid.ts) — both the fixed ECMA-262 Date Time String Format,
  // YYYY-MM-DDTHH:mm:ss.sssZ. rescheduleLesson.scheduled_at arrives RAW from
  // PostgREST as a timestamptz, YYYY-MM-DDTHH:mm:ss+00:00, which would never
  // string-equal a slot start: every comparison below would be silently false
  // and the guard would do nothing at all. Round-tripping it through the SAME
  // `new Date(...).toISOString()` puts both sides in one shape, where `===` is
  // exactly epoch-ms equality.
  //
  // An unparseable scheduled_at fails the guard OPEN (null blocks nothing) and
  // must never throw a RangeError out of render — this is a UX guard, and
  // /api/student/book still refuses the identical booking.
  const originalStartMs =
    originalStart !== null && Number.isFinite(originalStart.getTime())
      ? originalStart.getTime()
      : null
  const originalStartIso =
    originalStartMs !== null ? new Date(originalStartMs).toISOString() : null
  // The original run's half-open instant bounds, in the same epoch-ms shape as
  // runStartMs/runEndMs and ghostStartMs/ghostEndMs above: a cell is inside the
  // run iff its instant falls in [originalStartMs, originalEndMs), which for a
  // 30/60/90-minute lesson is exactly that run's 30-minute step instants.
  const originalEndMs =
    originalStartMs !== null && rescheduleLesson !== null
      ? originalStartMs + rescheduleLesson.duration_minutes * 60000
      : null
  // Range text for the original run's first cell, off the same
  // studentTimezone-pinned formatter the context strip above already uses.
  const originalRangeLabel =
    originalStart !== null && originalEnd !== null
      ? `${timeFormatter.format(originalStart)} – ${timeFormatter.format(originalEnd)}`
      : null

  // Compact pills — bare minutes; the group label carries the unit and the
  // aria-label stays descriptive ("30 minutes").
  const durationOptions = [
    { minutes: 30, label: '30', hours: 0.5 },
    { minutes: 60, label: '60', hours: 1 },
    { minutes: 90, label: '90', hours: 1.5 },
  ]

  // Legend entries. Each swatch mirrors what the grid actually paints: an
  // available cell is now a bare CELL_BOOKABLE_BG fill — no edge, no centre
  // dot — so the Available swatch is the same solid fill and nothing else. The
  // Unavailable fill keeps a palette-grey edge so it doesn't vanish on white
  // (its fill is near-white). Decorative only.
  const legendItems = [
    { label: 'Available', bg: CELL_BOOKABLE_BG, border: 'none' },
    { label: 'Unavailable', bg: CELL_GREY_BG, border: '1px solid #E0DFDC' },
    // The swatch mirrors the run's cream fill and orange left accent, so the
    // legend cannot drift out of sync with what the grid actually paints.
    { label: 'Selected', bg: CELL_SELECTED_BG, border: CELL_SELECTED_BORDER, borderLeft: CELL_SELECTED_ACCENT },
  ]

  // Shared icon+label+value cell used by every confirm-panel row.
  const renderCell = (Icon: LucideIcon, label: string, value: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '8px',
          backgroundColor: '#f3f4f6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {/* Neutral box, neutral icon: on this panel orange is reserved for
            the Confirm action alone, so every row icon here — and the box
            behind it — matches the grey the cancellation footnote's Info
            icon already uses. */}
        <Icon size={18} color="#6b7280" />
      </div>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: '12px', color: '#6b7280' }}>{label}</p>
        <p style={{ fontSize: '15px', fontWeight: '700', color: '#111827' }}>{value}</p>
      </div>
    </div>
  )

  // Dead reschedule id — the effect above is already navigating away. One quiet
  // card holds the page for that frame instead of flashing the whole booking
  // grid, whose teacher and duration would be locked to a lesson that no longer
  // exists. Verified before writing this: no React hook is called between here
  // and the end of the file, so the early return cannot skip one.
  if (rescheduleDead) {
    return (
      <div
        style={{
          maxWidth: '420px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '10px',
          padding: '16px',
          textAlign: 'center',
          fontSize: '15px',
          color: '#4b5563',
        }}
      >
        That class can no longer be rescheduled. Taking you back to your classes.
      </div>
    )
  }

  return (
    // Row 0 (title + desktop summary header) and the full-width strips sit
    // above the two-column flex; the aside is the flex's second child. Static
    // Tailwind classes are LAYOUT ONLY — state-dependent colours all stay inline.
    <div>
      {/* ── Row 0: title + timezone line, desktop summary header ── */}
      <div className="flex lg:items-end gap-4" style={{ marginBottom: '10px' }}>
        <div className="flex-1 min-w-0">
          {/* The timezone line used to sit here; it now closes the left column
              as a quiet footer under the grid, where it answers the question it
              actually raises ("what clock are these cells on?"). */}
          <h1 style={{ fontSize: '16px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
            {isReschedule ? 'Reschedule Class' : 'Book a Class'}
          </h1>
        </div>
        {/* Desktop summary header — width mirrors the aside so their tops align
            (display comes from the classes; never set it inline here) */}
        <div className="hidden lg:flex lg:w-[288px] lg:shrink-0" style={{ alignItems: 'center', gap: '7px' }}>
          {/* #9ca3af to match the grey caption beside it — orange on this
              panel is reserved for the Confirm action alone. */}
          <Calendar size={14} color="#9ca3af" style={{ flexShrink: 0 }} />
          <p style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Booking Summary</p>
        </div>
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

      {hoursRemaining < minBookableHours && (
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
            You do not have enough hours remaining to book a class. Please contact support to purchase more hours.
          </p>
        </div>
      )}

      {/* Unbookable account: no class length is enabled. Same red-banner
          treatment as the out-of-hours notice above — both are "you cannot book
          right now, talk to admin" states. */}
      {noDurationsEnabled && (
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
            No class durations are enabled on your account. Please contact support.
          </p>
        </div>
      )}

      {/* ── Two-column flex: toolbar + grid left, summary aside right ── */}
      <div className="flex flex-col lg:flex-row lg:items-start gap-4">
      {/* ── Left column: toolbar, grid ── */}
      <div className="flex-1 min-w-0">
      {/* ── Toolbar card: teacher · duration · week groups on ONE nowrap row,
          centred as a single unit. The Teacher group NEVER scrolls, clips, or
          truncates — the space is freed by compact Duration ("30/60/90"
          pills) and a compact Week group instead. ── */}
      <div
        className="shadow-sm"
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '20px',
          marginBottom: '10px',
          backgroundColor: '#ffffff',
          border: '1px solid #f3f4f6',
          borderRadius: '12px',
          padding: '10px 14px',
        }}
      >
        {/* ── Teacher group — hidden entirely (label included) for
            single-teacher trainings; full names, no squeeze ── */}
        {teachers.length > 1 && (
          <div style={{ flexShrink: 0 }}>
            <p style={toolbarGroupLabel}>
              Teacher
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
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
                  borderColor: isSelected ? TEACHER_SELECTED_BORDER : '#E0DFDC',
                  backgroundColor: isSelected ? TEACHER_SELECTED_BG : '#ffffff',
                  cursor: interactive ? 'pointer' : 'default',
                  opacity: interactive || isSelected ? 1 : 0.5,
                  flexShrink: 0,
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

        {/* ── Duration group — compact "30/60/90" pills; local-only
            recompute, no refetch ── */}
        <div style={{ flexShrink: 0 }}>
          <p style={toolbarGroupLabel}>
            Duration (min)
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
        {durationOptions.map((option) => {
          const canBook = hoursRemaining >= option.hours
          // NEW-A1: enabled on this student's account.
          const isAllowed = allowedDurations.includes(option.minutes)
          const isSelected = selectedDuration === option.minutes
          // Reschedule locks the original duration: the other pills are inert.
          // The allowed check is applied on the FRESH-BOOK branch only, so it can
          // neither unlock a pill during a reschedule nor disable the locked one
          // when that length has since been removed from the account — the
          // reschedule arm here is byte-identical to what it was before NEW-A1.
          const disabled = !canBook || (isReschedule ? !isSelected : !isAllowed)
          // The two fresh-book disable reasons read identically at opacity 0.5,
          // so each gets its own 12px glyph: wallet = out of hours, lock = not
          // enabled on the account. Both are false on every reschedule render,
          // so the reschedule branch stays byte-identical.
          const showHoursIcon = !isReschedule && !canBook
          const showLockIcon = !isReschedule && canBook && !isAllowed
          return (
            <button
              key={option.minutes}
              onClick={() => handleDurationSelect(option.minutes)}
              disabled={disabled}
              aria-label={
                showHoursIcon
                  ? `${option.minutes} minutes, not enough hours remaining`
                  : showLockIcon
                  ? `${option.minutes} minutes, not enabled on your account`
                  : `${option.minutes} minutes`
              }
              title={
                !canBook
                  ? 'Not enough hours remaining'
                  : !isReschedule && !isAllowed
                  ? 'This class length is not enabled on your account'
                  : undefined
              }
              style={{
                minWidth: '76px',
                padding: '8px 16px',
                borderRadius: '8px',
                border: '2px solid',
                borderColor: isSelected ? '#FF8303' : '#E0DFDC',
                backgroundColor: isSelected ? '#FFF0DC' : '#ffffff',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled && !isSelected ? 0.5 : 1,
                fontSize: '14px',
                fontWeight: '600',
                color: '#111827',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
              }}
            >
              {showHoursIcon && <Wallet size={12} aria-hidden="true" />}
              {showLockIcon && <Lock size={12} aria-hidden="true" />}
              {option.label}
            </button>
          )
        })}
          </div>
        </div>

        {/* Divider between the two groups — a standalone 40px rule rather
            than the Week group's old full-height borderLeft, so it stays
            centred on the row whichever group happens to be taller.
            Decorative. */}
        <div
          aria-hidden="true"
          style={{ width: '1px', height: '40px', backgroundColor: '#E0DFDC', flexShrink: 0 }}
        />

        {/* ── Week group — prev · label · Today · next; fixed width, nothing
            shifts or appears/disappears on navigation ── */}
        <div style={{ flexShrink: 0 }}>
          <p style={toolbarGroupLabel}>
            Week
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={goBack}
          disabled={isPrevDisabled}
          aria-label="Previous week"
          style={{
            height: '36px',
            padding: '0 10px',
            border: '1px solid #E0DFDC',
            borderRadius: '8px',
            backgroundColor: '#ffffff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: isPrevDisabled ? 'not-allowed' : 'pointer',
            opacity: isPrevDisabled ? 0.4 : 1,
          }}
        >
          <ChevronLeft size={16} color="#4b5563" />
        </button>
          {/* Fixed min-width sized to the widest realistic cross-month label
              ("28 Sept – 4 Oct 2026") at 14px, text centred, so week
              navigation never shifts the arrows or the Today button. */}
          <span
            style={{
              fontSize: '14px',
              fontWeight: '600',
              color: '#111827',
              display: 'inline-block',
              minWidth: '170px',
              textAlign: 'center',
            }}
          >
            {weekLabel}
          </span>
          {/* Always rendered at constant width ("Today" matches the teacher
              calendar); on the current week it dims and disables but stays
              mounted, so the Week group never changes size. */}
          <button
            onClick={goThisWeek}
            disabled={isCurrentWeek}
            style={{
              height: '36px',
              padding: '0 14px',
              border: '1px solid #E0DFDC',
              borderRadius: '8px',
              backgroundColor: '#ffffff',
              fontSize: '12px',
              fontWeight: '500',
              color: '#4b5563',
              cursor: isCurrentWeek ? 'default' : 'pointer',
              opacity: isCurrentWeek ? 0.5 : 1,
            }}
          >
            Today
          </button>
        <button
          onClick={goForward}
          aria-label="Next week"
          style={{
            height: '36px',
            padding: '0 10px',
            border: '1px solid #E0DFDC',
            borderRadius: '8px',
            backgroundColor: '#ffffff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ChevronRight size={16} color="#4b5563" />
        </button>
          </div>
        </div>
      </div>

      {/* ── Grid area: loading / error / empty / grid ──
          Suppressed wholesale when no class length is enabled (fresh book only).
          Wrapping the region is the smallest change that removes slot selection:
          with no cells rendered nothing can set selectedStartIso, and that is the
          single value gating the confirm panel and its Confirm button. Gating
          only the grid branch would still show "No openings this week", which
          reads as a scheduling problem rather than an account one; disabling
          cells individually would touch the hot render path for a state the DB
          CHECK makes near-impossible. The availability fetch is left running —
          it is harmless and keeps the effect's dependency logic untouched. ── */}
      {!noDurationsEnabled && (
        <>
          {isFirstLoad && (
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
              {/* The message already says "please try again"; this is that try.
                  Wiring only — bumping refetchNonce re-runs the untouched fetch
                  effect on the current teacher and week, which is exactly the
                  plain re-fetch that heals the refresh-token race. */}
              <div style={{ marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setRefetchNonce((n) => n + 1)}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #E0DFDC',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#4b5563',
                    cursor: 'pointer',
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          )}

          {/* Everything the grid area can show once a response has landed,
              wrapped so a LATER load can dim it in place rather than unmount
              it. Week nav, teacher swaps and both background refetches keep
              the previous week on screen underneath; the wrapper is inert
              while that runs, so nothing under the pointer can be tapped
              against availability that is already being replaced. */}
          {!isFirstLoad && !error && (
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  opacity: isRefreshing ? 0.5 : 1,
                  pointerEvents: isRefreshing ? 'none' : undefined,
                }}
              >
              {visibleColumns.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 16px' }}>
                  <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '6px' }}>
                    No {selectedDuration}-minute openings {isCurrentWeek ? 'this week' : `the week of ${weekLabel}`}.
                  </p>
                  <p style={{ fontSize: '13px', color: '#9ca3af' }}>
                    {isCurrentWeek
                      ? shorterLengthAllowed
                        ? 'Use the arrow above to check the next week, or try a shorter class length.'
                        : 'Use the arrow above to check the next week.'
                      : shorterLengthAllowed
                        ? 'Use the arrows above to check another week, or try a shorter class length.'
                        : 'Use the arrows above to check another week.'}
                  </p>
                </div>
              )}

              {visibleColumns.length > 0 && (
                // Horizontally scrollable on mobile; the time column stays sticky.
                <>
                <div
                  className="shadow-[0_1px_2px_rgba(0,0,0,0.05),0_2px_6px_rgba(0,0,0,0.05),0_8px_20px_rgba(0,0,0,0.06)] hover:shadow-[0_2px_4px_rgba(0,0,0,0.06),0_6px_14px_rgba(0,0,0,0.07),0_14px_32px_rgba(0,0,0,0.08)] hover:-translate-y-[3px] transition-[box-shadow,transform] duration-200"
                  style={{
                    overflowX: 'auto',
                    border: '1px solid #f3f4f6',
                    borderRadius: '12px',
                    backgroundColor: '#ffffff',
                  }}
                >
                  {/* ── Colour legend — Day-to-Day-style dots, one line, top-left
                      above the day headers; swatch colours follow the consts ── */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 12px 0',
                    }}
                  >
                    {legendItems.map((item) => (
                      <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span
                          aria-hidden="true"
                          style={{
                            width: '10px',
                            height: '10px',
                            borderRadius: '50%',
                            backgroundColor: item.bg,
                            border: item.border,
                            ...(item.borderLeft ? { borderLeft: item.borderLeft } : {}),
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                          {item.label}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div
                    // ONE clear for the whole grid rather than a per-cell
                    // mouseleave: sweeping between two adjacent cells fires leave
                    // then enter, and a per-cell handler makes the ghost flicker off
                    // and on across every boundary. Leaving the grid entirely is the
                    // only moment the preview should actually disappear.
                    onMouseLeave={canHover ? () => setHoverStartIso(null) : undefined}
                    style={{
                      display: 'grid',
                      // Fixed 7-day Mon–Sun frame: every column renders every week,
                      // all at identical widths — empty days are all-grey columns.
                      gridTemplateColumns: '56px repeat(7, minmax(88px, 1fr))',
                      gap: '2px',
                      padding: '8px',
                    }}
                  >
                    {/* Header row: sticky corner + one label per day column. The
                        whole row is sticky to the TOP as well, so the day names stay
                        with the cells while the grid scrolls; the corner cell is
                        sticky on both axes and therefore sits one layer above the
                        day headers (4) and the sticky time column (2). Every header
                        is painted opaque white for that overlap. */}
                    <div
                      style={{
                        position: 'sticky',
                        left: 0,
                        top: 0,
                        zIndex: 4,
                        backgroundColor: '#ffffff',
                      }}
                    />
                    {columnKeys.map((key) => {
                      const day = columnDate(key)
                      // Today's column in the STUDENT frame — a plain key match, no
                      // Date comparison. Marked with a filled pill instead of an
                      // underline: the pill lives entirely inside the header cell's
                      // own box, so the marker cannot change the header row's height
                      // as the student navigates between weeks. That is what the old
                      // transparent 2px rule existed to guarantee, and with the pill
                      // it is structural rather than a painted-out border.
                      const isToday = key === todayKey
                      // Reuses the per-render emptyColumns set — never
                      // recomputed per cell. The label sits in the HEADER rather
                      // than overlaying the column: the grid is a single CSS
                      // grid whose cells are auto-placed through `display:
                      // contents` row wrappers, so there is no per-column box to
                      // position an overlay against, and an explicitly
                      // grid-placed spanning element would occupy tracks the
                      // auto-placement walks through and dislodge every cell
                      // after it.
                      const isEmptyColumn = emptyColumns.has(key)
                      return (
                        <div
                          key={key}
                          style={{
                            textAlign: 'center',
                            padding: '4px 2px',
                            position: 'sticky',
                            top: 0,
                            zIndex: 3,
                            backgroundColor: isToday ? TODAY_PILL_BG : '#ffffff',
                            borderRadius: isToday ? '8px' : '0',
                          }}
                        >
                          <p
                            style={{
                              fontSize: '10px',
                              fontWeight: '500',
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              color: isToday ? TODAY_ACCENT : '#6b7280',
                            }}
                          >
                            {weekdayFormatter.format(day)}
                          </p>
                          <p style={{ fontSize: '13px', fontWeight: '600', color: isToday ? TODAY_ACCENT : '#111827' }}>
                            {dayMonthFormatter.format(day)}
                          </p>
                          {/* A day the week returned no slots for at all. Named
                              once, in the header, instead of on any cell —
                              nothing is written into the column's own cells. */}
                          {isEmptyColumn && (
                            <p
                              aria-hidden="true"
                              style={{ fontSize: '10px', color: '#9ca3af', pointerEvents: 'none' }}
                            >
                              No availability
                            </p>
                          )}
                        </div>
                      )
                    })}

                    {/* Time rows — one per axis entry, top to bottom. The axis is
                        continuous by construction (buildRowAxis), so there are no
                        bands to separate and no "· · ·" marker: an empty stretch of
                        the day renders as ordinary grey rows, which is what it is. */}
                    {rowAxis.map((minutes, rowIdx) => (
                      <div key={minutes} style={{ display: 'contents' }}>
                        {/* Sticky time column. Root cause of the drifting labels
                            (previous attempt): lineHeight 24px made this cell's
                            line box TALLER than the slot cells, so the label cell —
                            not the slot cells — sized each row track, and the
                            top-anchored (flex-start) line box tied the glyphs to
                            the row top instead of the cell box. Fix: collapse the
                            line box (lineHeight 1), pin the cell to the slot height
                            (minHeight 30px) so it never competes in track sizing,
                            and flex-centre — every label now centres identically on
                            its own 30px cell. */}
                        <div
                          style={{
                            position: 'sticky',
                            left: 0,
                            zIndex: 2,
                            backgroundColor: '#ffffff',
                            minHeight: '30px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            paddingRight: '8px',
                            lineHeight: 1,
                            ...rowLabelChrome(minutes),
                          }}
                        >
                          {formatRowLabel(minutes)}
                        </div>
                        {columnKeys.map((key) => {
                          const columnMap = cellMaps.get(key)
                          const slot = columnMap?.get(minutes)
                          // Whole hours carry the axis hairline (HOUR_LINE) across
                          // the row's top edge, matching the heavier hour label.
                          const isHourRow = minutes % 60 === 0
                          // Grey = not FREE: blocked, booked, past, within 24h, or
                          // not offered at all. Deliberately not `!slot.bookable` —
                          // a free slot that cannot START this length is green and
                          // tappable, and snaps (see below).
                          if (slot === undefined || !slot.available) {
                            return (
                              <div
                                key={key}
                                aria-hidden="true"
                                style={{
                                  minHeight: '30px',
                                  borderRadius: '6px',
                                  border: 'none',
                                  borderTop: isHourRow ? HOUR_LINE : 'none',
                                  backgroundColor: emptyColumns.has(key) ? CELL_EMPTY_COLUMN_BG : CELL_GREY_BG,
                                }}
                              />
                            )
                          }
                          // Everything below is a FREE slot, so it is green and
                          // tappable whether or not it is a valid START for the
                          // chosen length: a free cell the run cannot start on snaps
                          // backwards to the run that ENDS on it (snapToValidStart).
                          // Colour therefore tracks raw availability alone and no
                          // longer flickers as the student flips 30/60/90.
                          //
                          // Selected-run painting lives on this branch only: every
                          // 30-min step of a valid run is available by construction
                          // (that is what made its start bookable), so no GREY cell
                          // can ever fall inside the highlight. That is the whole
                          // invariant — it does NOT promise the orange block is
                          // visually contiguous. A step can have no cell at all and
                          // leave a gap, in three pre-existing cases: a cross-
                          // midnight run continues in the next column (documented
                          // at runCellChrome), a NEW324 day-8 continuation instant
                          // is in instantSet but under no column key, and a DST
                          // fall-back row is won by the other of the two instants
                          // claiming it. All three predate the axis; none can paint
                          // a blocked cell orange.
                          const isSelected = slot.startIso === selectedStartIso
                          const t = new Date(slot.startIso).getTime()
                          const inSelectedRun =
                            runStartMs !== null && runEndMs !== null && t >= runStartMs && t < runEndMs
                          // Block position from epoch-ms only (see runCellChrome).
                          const isRunFirst = inSelectedRun && t === runStartMs
                          const isRunLast =
                            inSelectedRun && runEndMs !== null && t + SLOT_MINUTES * 60000 === runEndMs
                          // Band fusion. A free cell whose axis neighbour in THIS
                          // column is also free drops the edge between them, so a
                          // stretch of availability reads as one solid block instead
                          // of a ladder of separate pills: corners round only where
                          // the band actually ends, and a -2px top margin swallows
                          // the grid's 2px row gap exactly as runCellChrome does for
                          // the selected run (a negative margin overlaps the gap
                          // without changing the row-track sizing, and the sticky
                          // time column still contributes a full 30px to every row).
                          // Adjacency is read off the AXIS entries, never minutes
                          // +/- 30: buildRowAxis is a union of the 30-min ruler and
                          // every wall-minute a slot really lands on, so an
                          // off-residue week (:17/:47 overrides) has rows the ruler
                          // never steps to, and stepping would fuse across a gap.
                          const prevMinutes = rowAxis[rowIdx - 1]
                          const nextMinutes = rowAxis[rowIdx + 1]
                          const prevSlot =
                            prevMinutes === undefined ? undefined : columnMap?.get(prevMinutes)
                          const nextSlot =
                            nextMinutes === undefined ? undefined : columnMap?.get(nextMinutes)
                          const prevFree = prevSlot !== undefined && prevSlot.available
                          const nextFree = nextSlot !== undefined && nextSlot.available
                          // Inside a fused band the fill is continuous by design and
                          // the -2px margin would clip the line anyway, so the hour
                          // hairline is drawn on a band's TOP cell only (grey cells
                          // always take it — they are never fused).
                          const showHourLine = isHourRow && !prevFree
                          // Hover preview of the run this cell would place. Never
                          // drawn over the real selection: the selected run owns its
                          // cells outright.
                          const inGhostRun =
                            !inSelectedRun &&
                            ghostStartMs !== null &&
                            ghostEndMs !== null &&
                            t >= ghostStartMs &&
                            t < ghostEndMs
                          const isGhostFirst = inGhostRun && t === ghostStartMs
                          const isGhostLast =
                            inGhostRun && ghostEndMs !== null && t + SLOT_MINUTES * 60000 === ghostEndMs
                          // Reschedule only: the run this class currently sits
                          // on. Half-open epoch-ms bounds, exactly like the
                          // selected and ghost runs above; originalStartMs is
                          // null on every fresh booking, so both flags below are
                          // dead outside a reschedule. Painted on this AVAILABLE
                          // branch only, which is where the run normally lands:
                          // the excludeLessonId the fetch sends is precisely
                          // what keeps the class's own slots free. The three
                          // gaps the selected run already documents
                          // (cross-midnight column split, day-8 continuation,
                          // DST fall-back row) can leave a step unpainted, and a
                          // run blocked by something else entirely renders grey
                          // — cosmetic either way, the tap guard is independent.
                          const inOriginalRun =
                            originalStartMs !== null &&
                            originalEndMs !== null &&
                            t >= originalStartMs &&
                            t < originalEndMs
                          // The one instant a reschedule cannot move to. Uses
                          // the SAME string comparison the two tap guards use,
                          // so what is painted and what is refused can never
                          // disagree.
                          const isOriginalStart =
                            originalStartIso !== null && slot.startIso === originalStartIso
                          // First-cell label precedence, encoded once: selected
                          // wins outright, then ghost, then original.
                          const showOriginalLabel =
                            isOriginalStart &&
                            !inSelectedRun &&
                            !inGhostRun &&
                            originalRangeLabel !== null
                          const slotTime = timeFormatter.format(new Date(slot.startIso))
                          return (
                            <button
                              key={key}
                              onClick={() => {
                                // Reschedule only: the class's own current
                                // start. Re-booking it is a no-op the server
                                // rejects anyway, so refuse it here and say why
                                // rather than spend a round trip on a 400.
                                // ONLY this instant is refused — an OVERLAPPING
                                // move (+30 min into the same run) is a
                                // legitimate reschedule, which is exactly why
                                // /api/student/book excludes the lesson from its
                                // own clash check.
                                if (isReschedule && slot.startIso === originalStartIso) {
                                  setSnapNotice(CURRENT_TIME_NOTICE)
                                  return
                                }
                                if (slot.bookable) {
                                  setSelectedStartIso(slot.startIso)
                                  setSnapNotice(null)
                                  return
                                }
                                const snapped = snapToValidStart(
                                  slot.startIso,
                                  selectedDuration / SLOT_MINUTES,
                                  instantSet
                                )
                                if (snapped === null) {
                                  // Fails closed — nothing is selected, and the
                                  // notice says why instead of leaving a dead tap.
                                  setSnapNotice(
                                    `A ${selectedDuration}-minute class does not fit here. Try a shorter length.`
                                  )
                                  return
                                }
                                // The snap walked backwards onto the class's own
                                // current start: unplaceable for the same reason
                                // a direct tap on it is, so it is rejected at the
                                // CALL SITE — snapToValidStart stays a pure
                                // instant walk with no reschedule knowledge.
                                if (isReschedule && snapped === originalStartIso) {
                                  setSnapNotice(CURRENT_TIME_NOTICE)
                                  return
                                }
                                setSelectedStartIso(snapped)
                                setSnapNotice(null)
                              }}
                              onMouseEnter={
                                canHover
                                  ? () => {
                                      // Resolved by EXACTLY the rule onClick uses, so
                                      // the preview and the tap can never disagree: a
                                      // bookable cell ghosts its own run, a free but
                                      // un-startable one ghosts the run that would
                                      // snap in, and a tap that would resolve to
                                      // nothing ghosts nothing (null clears it).
                                      const preview = slot.bookable
                                        ? slot.startIso
                                        : snapToValidStart(
                                            slot.startIso,
                                            selectedDuration / SLOT_MINUTES,
                                            instantSet
                                          )
                                      // Including the reschedule refusal, for the
                                      // same reason: previewing a run the tap
                                      // will not place would be a lie, so the
                                      // class's own current start ghosts nothing.
                                      setHoverStartIso(
                                        isReschedule && preview === originalStartIso ? null : preview
                                      )
                                    }
                                  : undefined
                              }
                              aria-pressed={isSelected}
                              aria-disabled={isOriginalStart}
                              aria-label={
                                // aria-disabled above, never the `disabled`
                                // attribute: the cell must stay FOCUSABLE so a
                                // keyboard user reaches it, hears why it is
                                // refused and tabs on. Only the start cell is
                                // refused — the rest of the original run keeps
                                // its normal label because it remains a
                                // legitimate target.
                                isOriginalStart
                                  ? 'Current class time - choose a different slot'
                                  : slot.bookable
                                  ? `Book ${slotTime}`
                                  : `Book a class around ${slotTime}`
                              }
                              style={{
                                minHeight: '30px',
                                cursor: 'pointer',
                                // CHROME PRECEDENCE — selected > ghost >
                                // original, with one deliberate exception: an
                                // original-run cell under the ghost keeps the
                                // original FILL while the ghost owns its edge
                                // and its label. Selected wins outright, fill
                                // included, so a cell inside both the original
                                // and the selected run reads purely as the pick.
                                ...(inSelectedRun
                                  ? runCellChrome(isRunFirst, isRunLast)
                                  : {
                                      // Top corners round only at a band's top, bottom
                                      // corners only at its bottom; 0 in between.
                                      borderRadius: `${prevFree ? '0' : '6px'} ${prevFree ? '0' : '6px'} ${nextFree ? '0' : '6px'} ${nextFree ? '0' : '6px'}`,
                                      border: inGhostRun ? GHOST_BORDER : 'none',
                                      // Key order matters: React writes `border`
                                      // first, so these longhands land on top of
                                      // it. Both are omitted entirely on a ghost
                                      // cell, whose dashed edge owns all four
                                      // sides — that is the ghost-over-original
                                      // half of the precedence noted above.
                                      ...(inOriginalRun && !inGhostRun
                                        ? { borderLeft: CELL_ORIGINAL_ACCENT }
                                        : {}),
                                      ...(showHourLine && !inGhostRun ? { borderTop: HOUR_LINE } : {}),
                                      // The original run's near-white fill
                                      // outranks BOTH greens, the ghost's
                                      // included: hovering the class's own run
                                      // still previews the move, without
                                      // pretending the run underneath is a fresh
                                      // opening. Deeper green under the ghost
                                      // otherwise: exactly the cells this hover
                                      // would fill, called out beneath the dashed
                                      // outline.
                                      backgroundColor: inOriginalRun
                                        ? CELL_ORIGINAL_BG
                                        : inGhostRun
                                        ? CELL_BOOKABLE_HOVER_BG
                                        : CELL_BOOKABLE_BG,
                                      marginTop: prevFree ? '-2px' : '0',
                                    }),
                                ...(isRunFirst ? runFirstCellLayout : {}),
                                ...(!inSelectedRun ? bookableCellLayout : {}),
                                ...(isRunLast && !isRunFirst ? runLastCellLayout : {}),
                                ...(isGhostFirst ? runFirstCellLayout : {}),
                                ...(isGhostLast && !isGhostFirst ? runLastCellLayout : {}),
                                // Last, and only where no selected or ghost label
                                // already owns the cell (showOriginalLabel encodes
                                // that): the same clipped single-line box the
                                // other two run heads use, so the label cannot
                                // change the row height.
                                ...(showOriginalLabel ? runFirstCellLayout : {}),
                              }}
                            >
                              {isRunFirst && selectedRangeLabel !== null && (
                                <>
                                  <Check size={11} strokeWidth={3} aria-hidden="true" style={{ color: '#FF8303', flexShrink: 0 }} />
                                  <span aria-hidden="true" style={runLabelStyle}>
                                    {selectedRangeLabel}
                                  </span>
                                </>
                              )}
                              {isRunLast && !isRunFirst && (
                                <span aria-hidden="true" style={runSubLabelStyle}>
                                  {selectedDuration} min
                                </span>
                              )}
                              {/* Ghost head marker + time range, same shape as the
                                  selected run's first-cell tick+label. Mutually
                                  exclusive with the two run labels above —
                                  inGhostRun requires !inSelectedRun — and
                                  decorative: the cell's own aria-label already
                                  names the slot. */}
                              {isGhostFirst && ghostRangeLabel !== null && (
                                <>
                                  <Plus
                                    size={11}
                                    aria-hidden="true"
                                    style={{ color: GHOST_GLYPH_COLOR, flexShrink: 0 }}
                                  />
                                  <span aria-hidden="true" style={ghostLabelStyle}>
                                    {ghostRangeLabel}
                                  </span>
                                </>
                              )}
                              {isGhostLast && !isGhostFirst && (
                                <span aria-hidden="true" style={ghostSubLabelStyle}>
                                  {selectedDuration} min
                                </span>
                              )}
                              {/* Original-run head — the class's current time
                                  range. Yields to both the selected and the ghost
                                  label; decorative, the start cell's own
                                  aria-label carries the meaning. */}
                              {showOriginalLabel && (
                                <span aria-hidden="true" style={originalLabelStyle}>
                                  {originalRangeLabel}
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                {/* Snap notice — raised only by a tap that could not resolve to any
                    valid start. Amber, matching the low-hours notice in the summary
                    aside: both are "this cannot happen as asked" rather than errors.
                    role="status" so the tap gives screen-reader users the same
                    feedback the fill change gives everyone else. */}
                {snapNotice !== null && (
                  <div
                    role="status"
                    style={{
                      marginTop: '10px',
                      padding: '12px 16px',
                      backgroundColor: '#fffbeb',
                      border: '1px solid #fde68a',
                      borderRadius: '8px',
                      fontSize: '13px',
                      color: '#92400e',
                    }}
                  >
                    {snapNotice}
                  </div>
                )}
                {/* Hint under the grid — decorative, the cells carry their own labels. */}
                <p style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', fontSize: '12px', color: '#6b7280' }}>
                  <Lightbulb size={13} color="#FF8303" aria-hidden="true" />
                  Tap any available time to place your class. It will snap to a start that fits.
                </p>
                </>
              )}
              </div>
              {isRefreshing && (
                <div
                  role="status"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#6b7280',
                  }}
                >
                  Loading...
                </div>
              )}
            </div>
          )}
        </>
      )}
      {/* Timezone footer: the quiet answer to the question the grid raises,
          moved out from under the H1. Full width of the left column, below
          the card and both of its notices, so it reads as a caption on the
          grid rather than a subtitle on the page. Rendered outside the
          noDurationsEnabled gate, exactly as it was in row 0: which clock
          the page speaks is true whether or not a grid is on screen. */}
      <p
        style={{
          marginTop: '10px',
          padding: '8px 12px',
          backgroundColor: '#F7F6F4',
          borderRadius: '8px',
          fontSize: '12px',
          color: '#6b7280',
        }}
      >
        Times shown in your timezone: {studentTimezone}
      </p>
      {/* ── end left column ── */}
      </div>

        {/* ── Sticky summary column — the confirm panel, styled to read as the
            page's right panel (shell-panel visual language, StudentRightPanel);
            second child of the two-column flex ── */}
        <aside className="w-full lg:w-[288px] lg:shrink-0 lg:sticky lg:top-0">
          {/* Panel header — mobile-only copy; the desktop header lives in Row 0 */}
          <div className="lg:hidden">
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px' }}>
              {/* #9ca3af to match the grey caption beside it — orange on this
                  panel is reserved for the Confirm action alone. */}
              <Calendar size={14} color="#9ca3af" style={{ flexShrink: 0 }} />
              <p style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Booking Summary</p>
            </div>
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
                  {/* Green, not orange: green already means "available / yours"
                      on the grid above (CELL_BOOKABLE_BG), and orange on this
                      panel is reserved for the Confirm action alone. */}
                  <span
                    style={{
                      flexShrink: 0,
                      backgroundColor: '#D8EEDC',
                      borderRadius: '999px',
                      padding: '4px 12px',
                      fontSize: '13px',
                      fontWeight: '600',
                      color: '#2E7D4F',
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
                  After this booking you will have less than 2 hours remaining. Contact support to purchase more hours.
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
      {/* ── end two-column flex ── */}
      </div>

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
