export type LessonStatus =
  | 'scheduled'
  | 'completed'
  | 'student_no_show'
  | 'teacher_no_show'
  | 'cancelled'
  | 'cancelled_by_student'
  | 'cancelled_by_teacher'

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
