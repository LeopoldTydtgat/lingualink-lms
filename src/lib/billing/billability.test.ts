import { describe, it, expect } from 'vitest'
import { getBillability, getProjectedAmount, projectedContribution, isCancelledStatus, BLOCKED_STATUSES } from '@/lib/billing/billability'

/**
 * Tests for src/lib/billing/billability.ts — the source of truth for "is this
 * lesson billable to the teacher?" and "is this a 48hr B2B-billable cancel?"
 *
 * Why this file exists: this logic decides what teachers get paid and what
 * Lingualink bills B2B clients. A regression here is a money bug — and unlike
 * a UI bug it doesn't get noticed by the user. Lock every branch with an
 * explicit case so it can't drift silently.
 *
 * Rules under test (from project briefs + memory):
 *   - completed                   → teacher paid
 *   - student_no_show             → teacher paid
 *   - teacher_no_show             → teacher NOT paid
 *   - cancelled_by_teacher        → teacher NOT paid
 *   - cancelled <24hr by student  → teacher paid (protection)
 *   - cancelled >24hr by student  → teacher NOT paid
 *   - cancelled 24-48hr, policy=48hr → teacher NOT paid, billable48hr=true
 *     (Lingualink bills the company; teacher pay is unaffected — the
 *     teacher-pay vs company-bill distinction is absolute)
 */

const ONE_HOUR_MS = 60 * 60 * 1000

// Helper: build an input with sensible defaults so each test only states what matters.
function input(overrides: Partial<Parameters<typeof getBillability>[0]> = {}) {
  return {
    status: 'completed' as const,
    scheduledAt: '2026-07-15T14:00:00.000Z',
    cancelledAt: null,
    cancellationPolicy: null,
    hourlyRate: 20,
    durationMinutes: 60,
    ...overrides,
  }
}

describe('getBillability — taken / no-show branches', () => {
  it('completed: billable, full hour @ €20 = €20', () => {
    const r = getBillability(input({ status: 'completed' }))
    expect(r.billableToTeacher).toBe(true)
    expect(r.billable48hr).toBe(false)
    expect(r.amount).toBe(20)
  })

  it('student_no_show: billable (teacher was ready)', () => {
    const r = getBillability(input({ status: 'student_no_show' }))
    expect(r.billableToTeacher).toBe(true)
    expect(r.amount).toBe(20)
  })

  it('teacher_no_show: NOT billable, zero amount', () => {
    const r = getBillability(input({ status: 'teacher_no_show' }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.amount).toBe(0)
  })

  it('cancelled_by_teacher: NOT billable', () => {
    const r = getBillability(input({ status: 'cancelled_by_teacher' }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.amount).toBe(0)
  })

  // Memory NEW104 flagged a dead `teacher_cancelled` predicate — but the
  // function still accepts it as a synonym branch. Lock the behaviour either way.
  it('legacy teacher_cancelled string: NOT billable (synonym)', () => {
    const r = getBillability(input({ status: 'teacher_cancelled' }))
    expect(r.billableToTeacher).toBe(false)
  })
})

describe('getBillability - missed status', () => {
  // 'missed' = the class happened but the teacher blew the 12h report window.
  // Teacher forfeits pay (amount 0, billableToTeacher false). The student is
  // still billed, but student billing is hours-based and lives outside this fn,
  // so the 0 here only zeroes the teacher side.
  it('missed: NOT billable to teacher, amount 0', () => {
    const r = getBillability(input({ status: 'missed' }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(false)
    expect(r.amount).toBe(0)
  })
})

describe('getBillability — student cancellation by notice window', () => {
  // scheduledAt − cancelledAt = hoursNotice. Source uses < 24, < 48 (strict).

  it('cancelled 23h before: billable (<24hr protection)', () => {
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 23 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({ status: 'cancelled_by_student', scheduledAt, cancelledAt }))
    expect(r.billableToTeacher).toBe(true)
    expect(r.amount).toBe(20)
  })

  it('cancelled 24h exactly before: NOT billable (24 is not < 24)', () => {
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 24 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({ status: 'cancelled_by_student', scheduledAt, cancelledAt }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(false)
  })

  it('cancelled 30h before, no 48hr policy: NOT billable to anyone', () => {
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 30 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({
      status: 'cancelled_by_student',
      scheduledAt,
      cancelledAt,
      cancellationPolicy: '24hr',
    }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(false)
    expect(r.amount).toBe(0)
  })

  it('cancelled 30h before, 48hr policy: NOT teacher-billable, IS company-billable', () => {
    // Critical case: teacher pay must NOT change because of the 48hr policy.
    // Only the company-billable flag flips.
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 30 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({
      status: 'cancelled_by_student',
      scheduledAt,
      cancelledAt,
      cancellationPolicy: '48hr',
    }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(true)
    expect(r.amount).toBe(0)
  })

  it('cancelled 48h exactly before, 48hr policy: NOT 48hr-billable (48 is not < 48)', () => {
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 48 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({
      status: 'cancelled_by_student',
      scheduledAt,
      cancelledAt,
      cancellationPolicy: '48hr',
    }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(false)
  })

  it('cancelled 72h before, 48hr policy: still NOT billable (outside the 24-48 window)', () => {
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 72 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({
      status: 'cancelled_by_student',
      scheduledAt,
      cancelledAt,
      cancellationPolicy: '48hr',
    }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(false)
  })

  it('cancelled with no cancelledAt timestamp: NOT billable (cannot compute notice)', () => {
    const r = getBillability(input({ status: 'cancelled_by_student', cancelledAt: null }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.amount).toBe(0)
  })

  it('legacy cancelled status (no _by_ suffix) follows same notice rules', () => {
    const scheduledAt = '2026-07-15T14:00:00.000Z'
    const cancelledAt = new Date(new Date(scheduledAt).getTime() - 23 * ONE_HOUR_MS).toISOString()
    const r = getBillability(input({ status: 'cancelled', scheduledAt, cancelledAt }))
    expect(r.billableToTeacher).toBe(true)
  })
})

describe('getBillability — amount calculation', () => {
  it('30-minute lesson @ €20: €10.00', () => {
    expect(getBillability(input({ durationMinutes: 30 })).amount).toBe(10)
  })

  it('90-minute lesson @ €20: €30.00', () => {
    expect(getBillability(input({ durationMinutes: 90 })).amount).toBe(30)
  })

  it('rounds to 2 decimal places', () => {
    // 45 min @ €17.50/hr = €13.125 → €13.13
    expect(getBillability(input({ durationMinutes: 45, hourlyRate: 17.5 })).amount).toBe(13.13)
  })

  it('amount is 0 when not billable, regardless of duration/rate', () => {
    expect(getBillability(input({
      status: 'teacher_no_show',
      durationMinutes: 90,
      hourlyRate: 100,
    })).amount).toBe(0)
  })
})

describe('getBillability — unknown status', () => {
  it('unknown status: NOT billable (default-safe)', () => {
    const r = getBillability(input({ status: 'something_unexpected' }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.billable48hr).toBe(false)
    expect(r.amount).toBe(0)
  })

  it('scheduled (future, no outcome yet): NOT billable via getBillability', () => {
    // Projected amount is what UI shows for the right-panel forecast; actual
    // billability is decided after the class.
    const r = getBillability(input({ status: 'scheduled' }))
    expect(r.billableToTeacher).toBe(false)
    expect(r.amount).toBe(0)
  })
})

describe('getProjectedAmount', () => {
  it('scheduled: returns projected (duration × rate)', () => {
    expect(getProjectedAmount(input({ status: 'scheduled', durationMinutes: 60, hourlyRate: 20 }))).toBe(20)
  })

  it('scheduled 30 min @ €25: €12.50', () => {
    expect(getProjectedAmount(input({ status: 'scheduled', durationMinutes: 30, hourlyRate: 25 }))).toBe(12.5)
  })

  it('completed: returns the realised billability amount', () => {
    expect(getProjectedAmount(input({ status: 'completed', durationMinutes: 60, hourlyRate: 20 }))).toBe(20)
  })

  it('teacher_no_show: returns 0 (not projected, real outcome known)', () => {
    expect(getProjectedAmount(input({ status: 'teacher_no_show' }))).toBe(0)
  })
})

describe('isCancelledStatus', () => {
  it('recognises all three cancellation strings', () => {
    expect(isCancelledStatus('cancelled')).toBe(true)
    expect(isCancelledStatus('cancelled_by_student')).toBe(true)
    expect(isCancelledStatus('cancelled_by_teacher')).toBe(true)
  })

  it('rejects non-cancellation statuses', () => {
    expect(isCancelledStatus('completed')).toBe(false)
    expect(isCancelledStatus('scheduled')).toBe(false)
    expect(isCancelledStatus('student_no_show')).toBe(false)
  })

  it('handles null/undefined safely', () => {
    expect(isCancelledStatus(null)).toBe(false)
    expect(isCancelledStatus(undefined)).toBe(false)
  })
})

describe('BLOCKED_STATUSES', () => {
  // This array is referenced elsewhere as the "this lesson cannot be re-cancelled
  // or rebooked" set. If anything changes it, lock the contents here.
  it('contains exactly the expected six statuses', () => {
    expect([...BLOCKED_STATUSES].sort()).toEqual([
      'cancelled',
      'cancelled_by_student',
      'cancelled_by_teacher',
      'completed',
      'student_no_show',
      'teacher_no_show',
    ])
  })
})

describe('projectedContribution - missed status (settled, never projected)', () => {
  const HOUR = 60 * 60 * 1000
  const nowMs = new Date('2026-06-16T12:00:00Z').getTime()

  it('missed lesson in the PAST: contributes ZERO', () => {
    const pastAt = new Date(nowMs - 48 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'missed', scheduledAt: pastAt, durationMinutes: 60, hourlyRate: 20 }),
      nowMs
    )
    expect(amt).toBe(0)
  })

  it('missed lesson with a FUTURE scheduledAt: still ZERO (settled, not scheduled)', () => {
    const futureAt = new Date(nowMs + 48 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'missed', scheduledAt: futureAt, durationMinutes: 60, hourlyRate: 20 }),
      nowMs
    )
    expect(amt).toBe(0)
  })
})

describe('projectedContribution — the teacher projected-total rule', () => {
  const HOUR = 60 * 60 * 1000
  const nowMs = new Date('2026-06-16T12:00:00Z').getTime()

  it('future scheduled lesson: contributes full projected pay', () => {
    const futureAt = new Date(nowMs + 48 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'scheduled', scheduledAt: futureAt, durationMinutes: 60, hourlyRate: 20 }),
      nowMs
    )
    expect(amt).toBe(20)
  })

  it('past scheduled lesson (ended, awaiting report): contributes full projected pay', () => {
    const pastAt = new Date(nowMs - 48 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'scheduled', scheduledAt: pastAt, durationMinutes: 60, hourlyRate: 20 }),
      nowMs
    )
    expect(amt).toBe(20)
  })

  it('completed lesson: contributes the realised billable amount regardless of time', () => {
    const pastAt = new Date(nowMs - 48 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'completed', scheduledAt: pastAt, durationMinutes: 60, hourlyRate: 20 }),
      nowMs
    )
    expect(amt).toBe(20)
  })

  it('teacher no-show: contributes zero', () => {
    const pastAt = new Date(nowMs - 48 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'teacher_no_show', scheduledAt: pastAt }),
      nowMs
    )
    expect(amt).toBe(0)
  })

  it('student cancellation <24hr: contributes full pay (teacher protected)', () => {
    const scheduledAt = new Date(nowMs - 48 * HOUR).toISOString()
    const cancelledAt = new Date(nowMs - 48 * HOUR + 23 * HOUR).toISOString()
    const amt = projectedContribution(
      input({ status: 'cancelled_by_student', scheduledAt, cancelledAt, durationMinutes: 60, hourlyRate: 20 }),
      nowMs
    )
    expect(amt).toBe(20)
  })
})
