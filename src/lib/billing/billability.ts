// Canonical lesson-status vocabulary. Mirrors the DB CHECK on lessons.status
// EXACTLY (scheduled, completed, cancelled, cancelled_by_student,
// cancelled_by_teacher, student_no_show, teacher_no_show). Single source of
// truth: any new status is added here AND to the DB CHECK in the same change.
// All consumer status sets below derive from this so a filter cannot silently
// drift. NOTE: this is the `lessons` vocabulary; the legacy `classes` table
// uses a different spelling (no_show_student/no_show_teacher) — never mix them.
export const ALL_LESSON_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'cancelled_by_student',
  'cancelled_by_teacher',
  'student_no_show',
  'teacher_no_show',
] as const

export type LessonStatus = typeof ALL_LESSON_STATUSES[number]

export type CancellationPolicy = '24hr' | '48hr' | null

export interface BillabilityInput {
  status: LessonStatus | string
  scheduledAt: string
  cancelledAt: string | null
  cancellationPolicy: CancellationPolicy
  hourlyRate: number
  durationMinutes: number
}

export interface BillabilityResult {
  billableToTeacher: boolean
  billable48hr: boolean
  amount: number
  label: string
  labelColor: string
}

export function getBillability(input: BillabilityInput): BillabilityResult {
  const { status, scheduledAt, cancelledAt, cancellationPolicy, hourlyRate, durationMinutes } = input

  const notBillable = (label: string, labelColor = '#6b7280'): BillabilityResult => ({
    billableToTeacher: false,
    billable48hr: false,
    amount: 0,
    label,
    labelColor,
  })

  const billable = (label: string): BillabilityResult => ({
    billableToTeacher: true,
    billable48hr: false,
    amount: Math.round((durationMinutes / 60) * hourlyRate * 100) / 100,
    label,
    labelColor: '#16a34a',
  })

  if (status === 'completed') return billable('Billable')
  if (status === 'student_no_show') return billable('Billable (no-show)')
  if (status === 'teacher_no_show') return notBillable('Not billable')
  if (status === 'cancelled_by_teacher' || status === 'teacher_cancelled') return notBillable('Not billable')

  if (status === 'cancelled' || status === 'cancelled_by_student') {
    if (!cancelledAt) return notBillable('Not billable')

    const hoursNotice =
      (new Date(scheduledAt).getTime() - new Date(cancelledAt).getTime()) / (1000 * 60 * 60)

    if (hoursNotice < 24) return billable('Billable (<24hr)')

    if (hoursNotice < 48 && cancellationPolicy === '48hr') {
      return {
        billableToTeacher: false,
        billable48hr: true,
        amount: 0,
        label: '48hr policy',
        labelColor: '#FF8303',
      }
    }

    return notBillable('Not billable (>24hr)')
  }

  return notBillable('Not billable')
}

export function getProjectedAmount(input: BillabilityInput): number {
  if (input.status === 'scheduled') {
    return Math.round((input.durationMinutes / 60) * input.hourlyRate * 100) / 100
  }
  return getBillability(input).amount
}

export const CANCELLED_STATUSES: readonly string[] = [
  'cancelled',
  'cancelled_by_student',
  'cancelled_by_teacher',
]

export function isCancelledStatus(status: string | null | undefined): boolean {
  return status != null && CANCELLED_STATUSES.includes(status)
}

export const BLOCKED_STATUSES: readonly string[] = [
  'cancelled',
  'cancelled_by_student',
  'cancelled_by_teacher',
  'completed',
  'student_no_show',
  'teacher_no_show',
]

// --- Derived consumer status sets (subsets of ALL_LESSON_STATUSES) ---

// The two no-show outcomes (lessons spelling).
export const NO_SHOW_STATUSES: readonly LessonStatus[] = [
  'student_no_show',
  'teacher_no_show',
]

// Every status except 'scheduled' — lessons whose outcome is settled.
// Admin billing prefilters use this, then gate each row via getBillability.
export const SETTLED_LESSON_STATUSES: readonly LessonStatus[] =
  ALL_LESSON_STATUSES.filter((s) => s !== 'scheduled')

// COARSE prefilter for the teacher /billing month query and recomputeAmounts:
// the set the teacher-billing path currently pulls before re-gating each row
// through getBillability. NOT an authoritative "teacher gets paid" set —
// getBillability still zeroes cancelled_by_teacher and >=24hr cancellations
// inside this set. Every consumer MUST re-gate via getBillability; never treat
// membership here as "billable". teacher_no_show is omitted only because it
// would always sum to zero (admin billing wants the visible line, so it uses
// SETTLED_LESSON_STATUSES instead).
export const MONTH_BILLING_PREFILTER_STATUSES: readonly LessonStatus[] =
  SETTLED_LESSON_STATUSES.filter((s) => s !== 'teacher_no_show')
