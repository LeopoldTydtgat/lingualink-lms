// Cancel-family membership is owned by billability.ts (CANCELLED_STATUSES) —
// one source of truth for outcome labels AND billing derivation.
import { isCancelledStatus } from '@/lib/billing/billability'

export type LessonViewer = 'admin' | 'teacher' | 'student'

export interface CancellationLabelInput {
  status: string
  cancelled_by?: string | null
  rescheduled_by?: string | null
}

// A reschedule's dead old leg also lands in the cancelled family (status
// 'cancelled' + rescheduled_by set), which is the whole reason this helper
// distinguishes cancellation from reschedule.

/**
 * Returns the cancellation-family label for a lesson, or null if the lesson is
 * not in the cancelled family - callers fall through to their own status map for
 * scheduled/completed/no-show/missed. Deliberately scoped to cancellations: the
 * eight call sites use different wording and palettes for the other statuses and
 * unifying those is a UX decision, not a bug fix.
 *
 * rescheduled_by is only consulted for cancelled-family rows. A live scheduled
 * lesson that an admin moved keeps its normal scheduled label.
 *
 * Legacy rows (cancelled_by null, pre-attribution) fall back to plain "Cancelled"
 * rather than inventing an actor.
 */
export function getCancellationLabel(
  input: CancellationLabelInput,
  viewer: LessonViewer
): string | null {
  if (!isCancelledStatus(input.status)) return null

  // Reschedule leg: rescheduled_by is only ever set on a row that was cancelled to
  // make way for a new booking. It is 'student' | 'admin' | null; the verb becomes
  // "Rescheduled". An unrecognised non-null value falls through to cancellation.
  if (input.rescheduled_by === 'student') {
    return viewer === 'student' ? 'Rescheduled by you' : 'Rescheduled by student'
  }
  if (input.rescheduled_by === 'admin') {
    return 'Rescheduled by admin'
  }

  // Resolve the cancellation actor: prefer cancelled_by; if null, derive from the
  // status suffix; bare 'cancelled' with no attribution is unknown.
  let actor: 'student' | 'teacher' | 'admin' | 'unknown'
  if (input.cancelled_by === 'student' || input.cancelled_by === 'teacher' || input.cancelled_by === 'admin') {
    actor = input.cancelled_by
  } else if (input.status === 'cancelled_by_student') {
    actor = 'student'
  } else if (input.status === 'cancelled_by_teacher') {
    actor = 'teacher'
  } else {
    actor = 'unknown'
  }

  switch (viewer) {
    case 'admin':
      if (actor === 'student') return 'Cancelled by student'
      if (actor === 'teacher') return 'Cancelled by teacher'
      if (actor === 'admin') return 'Cancelled by admin'
      return 'Cancelled'
    case 'teacher':
      if (actor === 'teacher') return 'Cancelled by you'
      if (actor === 'student') return 'Cancelled by student'
      if (actor === 'admin') return 'Cancelled by admin'
      return 'Cancelled'
    case 'student':
      if (actor === 'student') return 'Cancelled by you'
      if (actor === 'teacher') return 'Cancelled by your teacher'
      if (actor === 'admin') return 'Cancelled by admin'
      return 'Cancelled'
  }

  return 'Cancelled'
}
