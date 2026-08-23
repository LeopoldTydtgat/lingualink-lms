import { describe, it, expect } from 'vitest'
import { TeacherAvailabilitySchema, TeacherAvailabilityMoveSchema } from './schemas'

// The two cross-field refines on TeacherAvailabilitySchema are the ONLY gate
// keeping a self-contradicting availability row out of the table: both slot
// readers (slotEngine.ts, availability.ts) trust the type column and ignore
// is_available for general rows, and require !is_available before a holiday
// blocks anything. A row that slips past these refines is read as bookable
// time. POST /api/teacher/availability surfaces issues[0].message verbatim as
// the 400 body, so the message text is asserted, not just the failure.

const TEACHER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** A recurring row as GeneralAvailability.tsx sends it: day_of_week + HH:mm. */
function generalRow(is_available: boolean) {
  return {
    teacher_id: TEACHER_ID,
    type: 'general' as const,
    day_of_week: 1,
    start_time: '09:00',
    end_time: '10:00',
    is_available,
  }
}

/** A dated row as Holidays.tsx / DayToDay.tsx send it: start_at + end_at. */
function datedRow(type: 'holiday' | 'specific', is_available: boolean) {
  return {
    teacher_id: TEACHER_ID,
    type,
    start_at: '2026-08-20T00:00:00.000Z',
    end_at: '2026-08-22T00:00:00.000Z',
    is_available,
  }
}

describe('TeacherAvailabilitySchema - general rows cannot be unavailable', () => {
  it('rejects type=general with is_available=false', () => {
    const result = TeacherAvailabilitySchema.safeParse(generalRow(false))

    expect(result.success).toBe(false)
    // The route reads issues[0] only, so the new rule must be the first issue.
    expect(result.error?.issues[0].message).toBe(
      'General availability rows cannot be marked unavailable'
    )
    expect(result.error?.issues[0].path).toEqual(['is_available'])
  })

  it('accepts type=general with is_available=true', () => {
    // The shape GeneralAvailability.tsx actually posts - must stay legal.
    expect(TeacherAvailabilitySchema.safeParse(generalRow(true)).success).toBe(true)
  })
})

describe('TeacherAvailabilitySchema - holiday rows cannot be available', () => {
  it('still rejects type=holiday with is_available=true', () => {
    const result = TeacherAvailabilitySchema.safeParse(datedRow('holiday', true))

    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe('Holiday periods cannot be marked available')
    expect(result.error?.issues[0].path).toEqual(['is_available'])
  })

  it('still accepts type=holiday with is_available=false', () => {
    expect(TeacherAvailabilitySchema.safeParse(datedRow('holiday', false)).success).toBe(true)
  })
})

describe('TeacherAvailabilitySchema - specific rows keep both polarities', () => {
  // 'specific' is the one type that is genuinely two-way: DayToDay.tsx writes
  // is_available from the picked mode, and the busy-sync cron writes false.
  // Neither refine may touch it.
  it('accepts type=specific with is_available=false', () => {
    expect(TeacherAvailabilitySchema.safeParse(datedRow('specific', false)).success).toBe(true)
  })

  it('accepts type=specific with is_available=true', () => {
    expect(TeacherAvailabilitySchema.safeParse(datedRow('specific', true)).success).toBe(true)
  })
})

// PATCH /api/teacher/availability/[id] body. This schema is the only thing
// standing between a move request and the two instants the route writes, so
// both properties below are load-bearing: a backwards range would be written as
// an invisible 0px block that reconcileSpecific fails closed on (turning a move
// into a duplicate), and any field beyond the two instants must be STRIPPED,
// not honoured - the route reads is_available, type and teacher_id off the
// fetched row precisely so a caller cannot flip a block's polarity, change its
// kind, or move it onto another teacher's calendar.
describe('TeacherAvailabilityMoveSchema', () => {
  const START = '2026-08-24T09:00:00.000Z'
  const END = '2026-08-24T10:00:00.000Z'

  it('accepts a forward range', () => {
    const result = TeacherAvailabilityMoveSchema.safeParse({ start_at: START, end_at: END })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ start_at: START, end_at: END })
  })

  it('rejects a zero-length range', () => {
    const result = TeacherAvailabilityMoveSchema.safeParse({ start_at: START, end_at: START })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe('End must be after start')
    expect(result.error?.issues[0].path).toEqual(['end_at'])
  })

  it('rejects a backwards range', () => {
    const result = TeacherAvailabilityMoveSchema.safeParse({ start_at: END, end_at: START })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe('End must be after start')
  })

  it('rejects an unparseable instant', () => {
    const result = TeacherAvailabilityMoveSchema.safeParse({ start_at: 'yesterday', end_at: END })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe('Must be a valid ISO 8601 datetime')
  })

  it('rejects a missing instant', () => {
    expect(TeacherAvailabilityMoveSchema.safeParse({ start_at: START }).success).toBe(false)
    expect(TeacherAvailabilityMoveSchema.safeParse({ end_at: END }).success).toBe(false)
  })

  it('strips every field except the two instants', () => {
    const result = TeacherAvailabilityMoveSchema.safeParse({
      start_at: START,
      end_at: END,
      is_available: true,
      type: 'holiday',
      teacher_id: TEACHER_ID,
      source: 'google_sync',
      id: TEACHER_ID,
    })

    expect(result.success).toBe(true)
    expect(Object.keys(result.data ?? {}).sort()).toEqual(['end_at', 'start_at'])
  })
})
