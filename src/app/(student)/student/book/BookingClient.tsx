'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { User, ChevronLeft, ChevronRight, Check, CheckCircle2, Star, X, Clock } from 'lucide-react'
import { getLocalDateKey } from '@/lib/utils/timezone'

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

interface Props {
  studentId: string
  studentTimezone: string
  trainingId: string
  hoursRemaining: number
  teachers: Teacher[]
  rescheduleLesson: RescheduleLesson | null
}

// A single 30-minute bookable slot
interface Slot {
  startIso: string  // UTC ISO string
  available: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatHours(hours: number): string {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

// Get the Monday of the week containing a given date
function getWeekStart(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day // adjust to Monday
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// Format a date as "Mon 7 Apr" in the student's timezone
function formatDayLabel(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(date)
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

// Get day-of-week (0=Sun, 1=Mon ... 6=Sat) for a date in a given timezone
function getDayOfWeek(date: Date, timezone: string): number {
  const dayStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: timezone,
  }).format(date)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[dayStr] ?? 0
}

// ─── Step indicators ──────────────────────────────────────────────────────────

function StepIndicator({
  currentStep,
  totalSteps,
  skipTeacherStep,
  skipDurationStep,
}: {
  currentStep: number
  totalSteps: number
  skipTeacherStep: boolean
  skipDurationStep: boolean
}) {
  // The label SET, not just the count, depends on WHICH steps are skipped: the
  // two 3-step shapes (skip Teacher vs skip Duration) differ, so totalSteps alone
  // cannot disambiguate them. Build the visible labels from the flags — by
  // construction labels.length === totalSteps.
  const labels = [
    ...(skipTeacherStep ? [] : ['Teacher']),
    ...(skipDurationStep ? [] : ['Duration']),
    'Date & Time',
    'Confirm',
  ]

  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '32px' }}>
      {labels.map((label, i) => {
        const stepNum = i + 1
        const isComplete = stepNum < currentStep
        const isActive = stepNum === currentStep

        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: i < totalSteps - 1 ? 1 : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: '700',
                  backgroundColor: isComplete ? '#FF8303' : isActive ? '#FF8303' : '#E0DFDC',
                  color: isComplete || isActive ? '#ffffff' : '#9ca3af',
                }}
              >
                {isComplete ? <Check size={14} /> : stepNum}
              </div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: isActive ? '600' : '400',
                  color: isActive ? '#111827' : '#9ca3af',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            </div>
            {i < totalSteps - 1 && (
              <div
                style={{
                  flex: 1,
                  height: '2px',
                  backgroundColor: isComplete ? '#FF8303' : '#E0DFDC',
                  margin: '0 8px',
                  marginBottom: '20px',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1 — Teacher selection ───────────────────────────────────────────────

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
              <div style={{ width: '72px', height: '72px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                <Image
                  src={teacher.photo_url}
                  alt={teacher.full_name}
                  width={72}
                  height={72}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            ) : (
              <div
                style={{
                  width: '72px',
                  height: '72px',
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

function StepTeacher({
  teachers,
  selectedTeacherId,
  studentTimezone,
  onSelect,
}: {
  teachers: Teacher[]
  selectedTeacherId: string | null
  studentTimezone: string
  onSelect: (id: string) => void
}) {
  const [profileTeacher, setProfileTeacher] = useState<Teacher | null>(null)

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Select your teacher
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        Choose which teacher you would like to book with.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {teachers.map((teacher) => {
          const isSelected = selectedTeacherId === teacher.id
          const teaches = cleanList(teacher.teaching_languages)
          return (
            <div
              key={teacher.id}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              onClick={() => onSelect(teacher.id)}
              onKeyDown={(e) => {
                // Ignore keydowns bubbling up from the nested "View profile" button.
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(teacher.id)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                padding: '16px',
                borderRadius: '10px',
                border: '2px solid',
                borderColor: isSelected ? '#FF8303' : '#E0DFDC',
                backgroundColor: '#ffffff',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {teacher.photo_url ? (
                <div style={{ width: '56px', height: '56px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                  <Image
                    src={teacher.photo_url}
                    alt={teacher.full_name}
                    width={56}
                    height={56}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </div>
              ) : (
                <div
                  style={{
                    width: '56px',
                    height: '56px',
                    borderRadius: '50%',
                    backgroundColor: '#f3f4f6',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <User size={26} color="#9ca3af" />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '15px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
                  {teacher.full_name}
                </p>
                {teacher.reviewCount > 0 && (
                  <div style={{ marginBottom: '4px' }}>
                    <RatingLine avgRating={teacher.avgRating} reviewCount={teacher.reviewCount} />
                  </div>
                )}
                {teaches.length > 0 && (
                  <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '4px' }}>
                    Teaches {teaches.join(', ')}
                  </p>
                )}
                {teacher.bio && teacher.bio.trim().length > 0 && (
                  <p
                    className="line-clamp-2"
                    style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.5' }}
                  >
                    {teacher.bio}
                  </p>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setProfileTeacher(teacher)
                  }}
                  style={{
                    marginTop: '8px',
                    padding: '0',
                    background: 'none',
                    border: 'none',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#FF8303',
                    cursor: 'pointer',
                  }}
                >
                  View profile
                </button>
              </div>
              {isSelected && (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: '#FF8303',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Check size={14} color="#ffffff" />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {profileTeacher && (
        <TeacherProfileModal
          teacher={profileTeacher}
          studentTimezone={studentTimezone}
          onClose={() => setProfileTeacher(null)}
          onSelect={onSelect}
        />
      )}
    </div>
  )
}

// ─── Step 2 — Duration selection ─────────────────────────────────────────────

function StepDuration({
  hoursRemaining,
  selectedDuration,
  onSelect,
}: {
  hoursRemaining: number
  selectedDuration: number | null
  onSelect: (minutes: number) => void
}) {
  const options = [
    { minutes: 30, label: '30 minutes', hours: 0.5, description: 'Great for quick practice and focused conversations.' },
    { minutes: 60, label: '1 hour', hours: 1, description: 'Ideal for deeper learning and real progress.' },
    { minutes: 90, label: '1.5 hours', hours: 1.5, description: 'Perfect for in-depth sessions and specialised topics.' },
  ]

  return (
    <div>
      {/* Header row: title + subtitle on the left, training-balance chip on the right */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
            Choose your lesson duration
          </h2>
          <p style={{ fontSize: '14px', color: '#6b7280' }}>
            Select the duration that works best for you.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexShrink: 0,
            backgroundColor: '#ffffff',
            border: '1px solid #E0DFDC',
            borderRadius: '10px',
            padding: '8px 14px',
          }}
        >
          <Clock size={18} color="#FF8303" style={{ flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.3' }}>Training balance</p>
            <p style={{ fontSize: '14px', fontWeight: '700', color: '#111827', lineHeight: '1.3' }}>
              {formatHours(hoursRemaining)}
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {options.map((option) => {
          const canBook = hoursRemaining >= option.hours
          const isSelected = selectedDuration === option.minutes

          return (
            <button
              key={option.minutes}
              onClick={() => canBook && onSelect(option.minutes)}
              disabled={!canBook}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                padding: '16px 20px',
                borderRadius: '10px',
                border: '2px solid',
                borderColor: isSelected ? '#FF8303' : '#E0DFDC',
                backgroundColor: '#ffffff',
                cursor: canBook ? 'pointer' : 'not-allowed',
                opacity: canBook ? 1 : 0.5,
                textAlign: 'left',
              }}
            >
              {/* Icon holder — neutral grey circle with an orange clock */}
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '50%',
                  backgroundColor: '#f3f4f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Clock size={20} color="#FF8303" />
              </div>

              {/* Title + one-line description */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '15px', fontWeight: '600', color: '#111827', marginBottom: '2px' }}>
                  {option.label}
                </p>
                <p style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.5' }}>
                  {option.description}
                </p>
              </div>

              {/* Right cluster: insufficient-hours message, or the per-option deduction + selection check */}
              {!canBook ? (
                <span
                  style={{
                    fontSize: '12px',
                    color: '#FD5602',
                    fontWeight: '500',
                    flexShrink: 0,
                  }}
                >
                  Not enough hours
                </span>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                  <div style={{ width: '1px', height: '36px', backgroundColor: '#E0DFDC' }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Clock size={14} color="#9ca3af" style={{ flexShrink: 0 }} />
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '13px', fontWeight: '700', color: '#111827', lineHeight: '1.3' }}>
                        Uses {formatHours(option.hours)}
                      </p>
                      <p style={{ fontSize: '12px', color: '#9ca3af', lineHeight: '1.3' }}>
                        from your balance
                      </p>
                    </div>
                  </div>
                  {isSelected && (
                    <div
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '50%',
                        backgroundColor: '#FF8303',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Check size={14} color="#ffffff" />
                    </div>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {hoursRemaining < 0.5 && (
        <div
          style={{
            marginTop: '20px',
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
    </div>
  )
}

// ─── Step 3 — Date and time selection ────────────────────────────────────────

function StepDateTime({
  teacherId,
  studentTimezone,
  durationMinutes,
  onSelect,
  onAdvance,
  selectedStartIso,
}: {
  teacherId: string
  studentTimezone: string
  durationMinutes: number
  onSelect: (isoString: string | null) => void
  onAdvance: () => void
  selectedStartIso: string | null
}) {
  const slotsNeeded = durationMinutes / 30

  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()))
  const [slots, setSlots] = useState<Record<string, Slot[]>>({}) // keyed by YYYY-MM-DD
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null) // a YYYY-MM-DD dateKey

  // Pending auto-advance timer after a start-time click. The short delay lets the
  // span-pill selection paint before the wizard moves on; the latest slot click
  // always wins (the previous timer is cleared and restarted). Any in-step
  // navigation — a day switch or a week arrow — cancels a pending advance: the
  // user is still browsing, and a day switch runs onSelect(null), so a queued
  // advance would otherwise fire into a null start and render a blank Confirm
  // step. The timer is also cleared on unmount, which is every step change (this
  // component only renders on the date-&-time step), so it can never fire after
  // the user has navigated away.
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingAdvance = () => {
    if (advanceTimerRef.current !== null) {
      clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
  }
  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) clearTimeout(advanceTimerRef.current)
    }
  }, [])

  // Fetch availability slots from the API whenever week or teacher changes.
  //
  // The first fetch on step entry can lose the Supabase refresh-token race in
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
    // weekStart is browser-local Monday midnight; format it in the STUDENT tz (not UTC) so the server's 7-day window matches the client's Mon–Sun columns. Formatting in UTC rolls positive-offset browsers back to Sunday and blanks the Sunday column.
    const weekStartStr = getLocalDateKey(weekStart, studentTimezone)
    const url = `/api/student/availability?teacherId=${teacherId}&weekStart=${weekStartStr}&timezone=${encodeURIComponent(studentTimezone)}`

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
  }, [teacherId, weekStart, studentTimezone])

  // Build the 7 days of this week to display
  const weekDays: Date[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    weekDays.push(d)
  }

  // Check if a slot at index `slotIndex` within a day can be the start of a booking.
  // Requires slotsNeeded consecutive 30-minute slots that are all available AND
  // actually adjacent in time (no gaps — teacher might have non-contiguous availability).
  function isBookableStart(daySlots: Slot[], slotIndex: number): boolean {
    for (let i = 0; i < slotsNeeded; i++) {
      const s = daySlots[slotIndex + i]
      if (!s || !s.available) return false
      if (i > 0) {
        const expectedMs = new Date(daySlots[slotIndex + i - 1].startIso).getTime() + 30 * 60 * 1000
        if (new Date(s.startIso).getTime() !== expectedMs) return false
      }
    }
    return true
  }

  // A day can be picked iff it isn't past and a booking of the chosen
  // duration can start somewhere in it.
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0))
  const selectableDayKeys: string[] = []
  for (const day of weekDays) {
    const dateKey = getLocalDateKey(day, studentTimezone)
    const daySlots = slots[dateKey] ?? []
    if (day >= todayStart && daySlots.some((_, i) => isBookableStart(daySlots, i))) {
      selectableDayKeys.push(dateKey)
    }
  }

  // The active day is derived, never synced via an effect: keep the student's
  // pick while it stays selectable, otherwise fall back to the first open day.
  // This auto-selects on load and re-defaults after week/duration changes.
  const activeDayKey =
    selectedDay !== null && selectableDayKeys.includes(selectedDay)
      ? selectedDay
      : selectableDayKeys[0] ?? null
  const activeDay =
    activeDayKey !== null
      ? weekDays.find((d) => getLocalDateKey(d, studentTimezone) === activeDayKey)
      : undefined

  // Bookable START slots of the active day, grouped by part of day. The hour
  // comes from a formatter pinned to the student's timezone — Date.getHours()
  // is browser-local and wrong for a student in another timezone.
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    timeZone: studentTimezone,
  })
  const activeDaySlots = activeDayKey !== null ? slots[activeDayKey] ?? [] : []
  const morningStarts: Slot[] = []
  const afternoonStarts: Slot[] = []
  const eveningStarts: Slot[] = []
  activeDaySlots.forEach((slot, i) => {
    if (!isBookableStart(activeDaySlots, i)) return
    const hour = Number(hourFormatter.format(new Date(slot.startIso)))
    if (hour < 12) morningStarts.push(slot)
    else if (hour < 17) afternoonStarts.push(slot)
    else eveningStarts.push(slot)
  })
  const partsOfDay = [
    { label: 'Morning', starts: morningStarts },
    { label: 'Afternoon', starts: afternoonStarts },
    { label: 'Evening', starts: eveningStarts },
  ]

  const longDayFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: studentTimezone,
  })
  const timeFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: studentTimezone,
  })
  const selectedStart = selectedStartIso !== null ? new Date(selectedStartIso) : null
  const selectedEnd =
    selectedStart !== null ? new Date(selectedStart.getTime() + durationMinutes * 60000) : null

  const goBack = () => {
    cancelPendingAdvance() // browsing weeks is navigation, never a confirm
    const prev = new Date(weekStart)
    prev.setDate(prev.getDate() - 7)
    // Don't allow going before current week
    if (prev >= getWeekStart(new Date())) setWeekStart(prev)
    else setWeekStart(getWeekStart(new Date()))
  }

  const goForward = () => {
    cancelPendingAdvance() // browsing weeks is navigation, never a confirm
    const next = new Date(weekStart)
    next.setDate(next.getDate() + 7)
    setWeekStart(next)
  }

  const isPrevDisabled = weekStart <= getWeekStart(new Date())

  // Week label e.g. "31 Mar – 6 Apr 2026"
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const weekLabel = `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(weekStart)} – ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(weekEnd)}`

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Choose date and time
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        Times shown in your local timezone ({studentTimezone}).
      </p>

      {/* Week navigation */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '16px',
        }}
      >
        <button
          onClick={goBack}
          disabled={isPrevDisabled}
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
        <span style={{ fontSize: '14px', fontWeight: '600', color: '#111827' }}>
          {weekLabel}
        </span>
        <button
          onClick={goForward}
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

      {!loading && !error && (
        <>
          {/* Week strip — pick a day */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '6px' }}>
            {weekDays.map((day) => {
              const dateKey = getLocalDateKey(day, studentTimezone)
              const selectable = selectableDayKeys.includes(dateKey)
              const isActive = selectable && dateKey === activeDayKey

              return (
                <button
                  key={dateKey}
                  disabled={!selectable}
                  onClick={() => {
                    // Touching the day strip is navigation, never a confirm — cancel any queued advance.
                    cancelPendingAdvance()
                    if (selectable && dateKey !== activeDayKey) {
                      setSelectedDay(dateKey)
                      onSelect(null) // a time picked on the previous day no longer applies
                    }
                  }}
                  style={{
                    borderRadius: '10px',
                    padding: '9px 2px',
                    textAlign: 'center',
                    border: '1px solid',
                    borderColor: selectable && !isActive ? '#E0DFDC' : 'transparent',
                    backgroundColor: isActive ? '#FF8303' : selectable ? '#ffffff' : '#fafafa',
                    cursor: selectable ? 'pointer' : 'default',
                  }}
                >
                  <p
                    style={{
                      fontSize: '10px',
                      fontWeight: '500',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: isActive ? '#ffe7cf' : selectable ? '#6b7280' : '#d1d5db',
                    }}
                  >
                    {formatDayLabel(day, studentTimezone).split(' ')[0]}
                  </p>
                  <p
                    style={{
                      fontSize: '15px',
                      fontWeight: '500',
                      color: isActive ? '#ffffff' : selectable ? '#111827' : '#d1d5db',
                    }}
                  >
                    {new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: studentTimezone }).format(day)}
                  </p>
                  {selectable && (
                    <div
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        backgroundColor: isActive ? '#ffffff' : '#FF8303',
                        margin: '4px auto 0',
                      }}
                    />
                  )}
                </button>
              )
            })}
          </div>

          {/* Times for the active day */}
          <div style={{ marginTop: '24px' }}>
            {activeDayKey !== null && activeDay ? (
              <>
                <p style={{ fontSize: '15px', fontWeight: '500', color: '#111827', marginBottom: '16px' }}>
                  {longDayFormatter.format(activeDay)}
                </p>

                {partsOfDay
                  .filter((part) => part.starts.length > 0)
                  .map((part) => (
                    <div key={part.label}>
                      <p
                        style={{
                          fontSize: '11px',
                          fontWeight: '500',
                          color: '#9ca3af',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          marginBottom: '8px',
                        }}
                      >
                        {part.label}
                      </p>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(68px, 1fr))',
                          gap: '8px',
                          marginBottom: '18px',
                        }}
                      >
                        {part.starts.map((slot) => {
                          const isSelected = slot.startIso === selectedStartIso
                          // Hide starts strictly inside the selected window —
                          // the selected start renders as the span pill, and
                          // the slot exactly at the window end still renders.
                          const startMs = new Date(slot.startIso).getTime()
                          const selMs =
                            selectedStartIso !== null ? new Date(selectedStartIso).getTime() : null
                          const isInsideSelection =
                            selMs !== null &&
                            startMs > selMs &&
                            startMs < selMs + durationMinutes * 60000
                          if (isInsideSelection) return null

                          return (
                            <button
                              key={slot.startIso}
                              onClick={() => {
                                onSelect(slot.startIso)
                                // Debounced Calendly-style auto-advance — the latest slot click wins.
                                cancelPendingAdvance()
                                advanceTimerRef.current = setTimeout(() => {
                                  advanceTimerRef.current = null
                                  onAdvance()
                                }, 250)
                              }}
                              style={{
                                padding: '10px 2px',
                                borderRadius: '8px',
                                border: 'none',
                                fontSize: '12px',
                                fontWeight: '500',
                                textAlign: 'center',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                                gridColumn: isSelected ? 'span 2' : 'auto',
                                backgroundColor: isSelected ? '#FF8303' : '#FFF0DC',
                                color: isSelected ? '#ffffff' : '#FF8303',
                              }}
                            >
                              {isSelected
                                ? `${formatSlotTime(slot.startIso, studentTimezone)} – ${timeFormatter.format(new Date(startMs + durationMinutes * 60000))}`
                                : formatSlotTime(slot.startIso, studentTimezone)}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}

                {selectedStart !== null &&
                  selectedEnd !== null &&
                  getLocalDateKey(selectedStart, studentTimezone) === activeDayKey && (
                    <div
                      style={{
                        marginTop: '20px',
                        backgroundColor: '#FFF7ED',
                        border: '1px solid #FFE0C0',
                        borderRadius: '10px',
                        padding: '12px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                      }}
                    >
                      <CheckCircle2 size={18} color="#FF8303" style={{ flexShrink: 0 }} />
                      <p style={{ fontSize: '13px', color: '#5C1F0A' }}>
                        <span style={{ fontWeight: '500' }}>
                          {longDayFormatter.format(selectedStart)} · {timeFormatter.format(selectedStart)} – {timeFormatter.format(selectedEnd)}
                        </span>
                        {' · '}
                        {durationMinutes} minutes
                      </p>
                    </div>
                  )}
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '32px 16px' }}>
                <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '6px' }}>
                  No openings this week.
                </p>
                <p style={{ fontSize: '13px', color: '#9ca3af' }}>
                  Use the arrow above to check the next week.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Step 4 — Confirm ─────────────────────────────────────────────────────────

function StepConfirm({
  teacher,
  durationMinutes,
  startIso,
  studentTimezone,
  hoursRemaining,
  isSubmitting,
  onConfirm,
}: {
  teacher: Teacher
  durationMinutes: number
  startIso: string
  studentTimezone: string
  hoursRemaining: number
  isSubmitting: boolean
  onConfirm: () => void
}) {
  const hoursUsed = durationMinutes / 60
  const hoursAfter = hoursRemaining - hoursUsed

  const start = new Date(startIso)
  const end = new Date(start.getTime() + durationMinutes * 60000)
  const dateFormatter = new Intl.DateTimeFormat('en-GB', {
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

  return (
    <div>
      <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>
        Confirm your booking
      </h2>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '24px' }}>
        Please review your class details before confirming.
      </p>

      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '12px',
          overflow: 'hidden',
          marginBottom: '24px',
        }}
      >
        {/* Orange header */}
        <div style={{ backgroundColor: '#FF8303', padding: '12px 20px' }}>
          <span style={{ color: '#ffffff', fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Class Summary
          </span>
        </div>

        <div style={{ padding: '20px' }}>
          {/* Teacher */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            {teacher.photo_url ? (
              <div style={{ width: '44px', height: '44px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                <Image
                  src={teacher.photo_url}
                  alt={teacher.full_name}
                  width={44}
                  height={44}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            ) : (
              <div
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '50%',
                  backgroundColor: '#f3f4f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <User size={20} color="#9ca3af" />
              </div>
            )}
            <div>
              <p style={{ fontSize: '15px', fontWeight: '700', color: '#111827' }}>{teacher.full_name}</p>
              <p style={{ fontSize: '13px', color: '#9ca3af' }}>Your teacher</p>
            </div>
          </div>

          {/* Details rows */}
          {[
            { label: 'Date & Time', value: `${dateFormatter.format(start)} · ${timeFormatter.format(start)} – ${timeFormatter.format(end)}` },
            { label: 'Duration', value: formatHours(durationMinutes / 60) },
            { label: 'Hours deducted', value: formatHours(hoursUsed) },
            { label: 'Remaining after booking', value: formatHours(hoursAfter) },
          ].map(({ label, value }) => (
            <div
              key={label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: '12px',
                paddingBottom: '12px',
                borderTop: '1px solid #f3f4f6',
              }}
            >
              <span style={{ fontSize: '14px', color: '#6b7280' }}>{label}</span>
              <span style={{ fontSize: '14px', fontWeight: '600', color: '#111827' }}>{value}</span>
            </div>
          ))}
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
            marginBottom: '20px',
          }}
        >
          After this booking you will have less than 2 hours remaining. Contact admin to purchase more hours.
        </div>
      )}

      <button
        onClick={onConfirm}
        disabled={isSubmitting}
        style={{
          width: '100%',
          padding: '14px',
          backgroundColor: isSubmitting ? '#9ca3af' : '#FF8303',
          color: '#ffffff',
          border: 'none',
          borderRadius: '8px',
          fontSize: '15px',
          fontWeight: '700',
          cursor: isSubmitting ? 'not-allowed' : 'pointer',
        }}
      >
        {isSubmitting ? 'Booking...' : 'Confirm Booking'}
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BookingClient({
  studentId,
  studentTimezone,
  trainingId,
  hoursRemaining,
  teachers,
  rescheduleLesson,
}: Props) {
  const router = useRouter()

  // Two steps can be skipped independently: the Teacher step (single-teacher
  // trainings — currently never) and the Duration step (a reschedule locks the
  // original duration in, so there is nothing to choose). The wizard therefore
  // has 4, 3, or 2 steps.
  const skipTeacherStep = false
  const skipDurationStep = rescheduleLesson !== null
  const totalSteps = 4 - (skipTeacherStep ? 1 : 0) - (skipDurationStep ? 1 : 0)

  // Step numbering: if skipping teacher step, step 1=Duration, 2=DateTime, 3=Confirm
  // If not skipping: step 1=Teacher, 2=Duration, 3=DateTime, 4=Confirm
  const [step, setStep] = useState(1)

  const [selectedTeacherId, setSelectedTeacherId] = useState<string | null>(
    skipTeacherStep ? teachers[0].id : rescheduleLesson?.teacher_id ?? null
  )
  const [selectedDuration, setSelectedDuration] = useState<number | null>(
    rescheduleLesson?.duration_minutes ?? null
  )
  const [selectedStartIso, setSelectedStartIso] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const selectedTeacher = teachers.find((t) => t.id === selectedTeacherId) ?? null

  // Determine which logical step we're on regardless of skip
  // logicalStep: 'teacher' | 'duration' | 'datetime' | 'confirm'
  function getLogicalStep(): 'teacher' | 'duration' | 'datetime' | 'confirm' {
    if (!skipTeacherStep) {
      if (step === 1) return 'teacher'
      if (!skipDurationStep) {
        if (step === 2) return 'duration'
        if (step === 3) return 'datetime'
        return 'confirm'
      } else {
        if (step === 2) return 'datetime'
        return 'confirm'
      }
    } else {
      if (!skipDurationStep) {
        if (step === 1) return 'duration'
        if (step === 2) return 'datetime'
        return 'confirm'
      } else {
        if (step === 1) return 'datetime'
        return 'confirm'
      }
    }
  }

  const logicalStep = getLogicalStep()

  function handleNext() {
    setStep((s) => s + 1)
  }

  function handleBack() {
    if (step === 1) {
      router.push('/student/my-classes')
    } else {
      setStep((s) => s - 1)
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

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ marginBottom: '8px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827' }}>
          {rescheduleLesson ? 'Reschedule Class' : 'Book a Class'}
        </h1>
      </div>

      {/* Step indicator */}
      <StepIndicator
        currentStep={step}
        totalSteps={totalSteps}
        skipTeacherStep={skipTeacherStep}
        skipDurationStep={skipDurationStep}
      />

      {/* Step content */}
      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E0DFDC',
          borderRadius: '12px',
          padding: '28px',
          marginBottom: '20px',
        }}
      >
        {logicalStep === 'teacher' && (
          <StepTeacher
            teachers={teachers}
            selectedTeacherId={selectedTeacherId}
            studentTimezone={studentTimezone}
            onSelect={(id) => {
              // Reset the time only when the teacher actually changes, so Back-then-forward keeps the pick.
              if (id !== selectedTeacherId) setSelectedStartIso(null)
              setSelectedTeacherId(id)
              handleNext() // Calendly-style: selecting a teacher advances to the next step
            }}
          />
        )}

        {logicalStep === 'duration' && (
          <StepDuration
            hoursRemaining={hoursRemaining}
            selectedDuration={selectedDuration}
            onSelect={(minutes) => {
              // Reset the time only when the duration actually changes, so Back-then-forward keeps the pick.
              if (minutes !== selectedDuration) setSelectedStartIso(null)
              setSelectedDuration(minutes)
              handleNext() // Calendly-style: selecting a duration advances to the next step
            }}
          />
        )}

        {logicalStep === 'datetime' && selectedTeacherId && selectedDuration && (
          <StepDateTime
            teacherId={selectedTeacherId}
            studentTimezone={studentTimezone}
            durationMinutes={selectedDuration}
            selectedStartIso={selectedStartIso}
            onSelect={setSelectedStartIso}
            onAdvance={handleNext}
          />
        )}

        {logicalStep === 'confirm' &&
          selectedTeacher &&
          selectedDuration &&
          selectedStartIso && (
            <StepConfirm
              teacher={selectedTeacher}
              durationMinutes={selectedDuration}
              startIso={selectedStartIso}
              studentTimezone={studentTimezone}
              hoursRemaining={hoursRemaining}
              isSubmitting={isSubmitting}
              onConfirm={handleConfirm}
            />
          )}

        {submitError && (
          <div
            style={{
              marginTop: '16px',
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
      </div>

      {/* Steps auto-advance on selection, so there is no Continue button; Back stays on every step. */}
      <button
        onClick={handleBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
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
        <ChevronLeft size={16} />
        Back
      </button>
    </div>
  )
}
