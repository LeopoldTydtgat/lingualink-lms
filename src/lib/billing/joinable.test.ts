import { describe, it, expect } from 'vitest'
import { isLessonJoinable, JOIN_WINDOW_MS } from './joinable'

describe('isLessonJoinable', () => {
  const start = '2026-06-18T10:00:00.000Z'
  const startMs = new Date(start).getTime()
  const duration = 60 // minutes
  const endMs = startMs + duration * 60 * 1000

  it('is NOT joinable more than 10 minutes before start', () => {
    const now = startMs - JOIN_WINDOW_MS - 1000 // 10m01s before
    expect(isLessonJoinable(start, duration, 'scheduled', now)).toBe(false)
  })

  it('is joinable exactly 10 minutes before start', () => {
    const now = startMs - JOIN_WINDOW_MS // exactly 10m before
    expect(isLessonJoinable(start, duration, 'scheduled', now)).toBe(true)
  })

  it('is joinable during the class', () => {
    const now = startMs + 30 * 60 * 1000 // 30 min in
    expect(isLessonJoinable(start, duration, 'scheduled', now)).toBe(true)
  })

  it('is joinable at the exact end instant', () => {
    expect(isLessonJoinable(start, duration, 'scheduled', endMs)).toBe(true)
  })

  it('is NOT joinable one second after end', () => {
    expect(isLessonJoinable(start, duration, 'scheduled', endMs + 1000)).toBe(false)
  })

  it('is NOT joinable for a blocked status even inside the window', () => {
    const now = startMs - 60 * 1000 // 1 min before start
    expect(isLessonJoinable(start, duration, 'cancelled', now)).toBe(false)
    expect(isLessonJoinable(start, duration, 'cancelled_by_student', now)).toBe(false)
    expect(isLessonJoinable(start, duration, 'cancelled_by_teacher', now)).toBe(false)
    expect(isLessonJoinable(start, duration, 'completed', now)).toBe(false)
    expect(isLessonJoinable(start, duration, 'student_no_show', now)).toBe(false)
    expect(isLessonJoinable(start, duration, 'teacher_no_show', now)).toBe(false)
  })
})
