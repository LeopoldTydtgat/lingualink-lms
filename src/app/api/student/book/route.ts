import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  studentBookingConfirmationEmailContent,
  teacherNewBookingEmailContent,
  studentRescheduledEmailContent,
  teacherRescheduledEmailContent,
} from '@/lib/email/templates'
import { createTeamsMeeting, cancelTeamsMeeting } from '@/lib/microsoft/graph'
import { BookClassSchema } from '@/lib/validation/schemas'
import { revalidatePath } from 'next/cache'
import { isSlotAvailable } from '@/lib/availability'
import { checkStudentBookingLimit, recordStudentBookingAttempt } from '@/lib/rateLimit'
import { requireTz } from '@/lib/time/requireTz'
import { createPendingReport } from '@/lib/reports/createPendingReport'
import { createLessonGoogleEvent, deleteLessonGoogleEvent } from '@/lib/google/lessonEvents'
import { CANCELLED_STATUSES, toPostgrestInList } from '@/lib/billing/billability'
import { raiseReconciliationTask } from '@/lib/admin/raiseReconciliationTask'
import { isRollbackProven, verifyLessonCommitted } from '@/lib/lessons/verifyLessonCommitted'

// A reversal owed to the student for a money RPC that has already moved their
// hours, held for the window in which no lesson row exists yet. See the
// pendingCompensation declaration inside the handler for the invariant.
type PendingCompensation =
  | { kind: 'refund'; trainingId: string; studentId: string; hours: number }
  | {
      kind: 'unwind'
      oldLessonId: string
      trainingId: string
      studentId: string
      oldDurationHours: number
      newDurationHours: number
    }

// ── POST /api/student/book ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Set the moment the new lesson row is committed. Everything after that
  // point is documented non-blocking, so the outer catch below must report
  // success once this is non-null - a 500 there tells the student a booking
  // failed when it exists, and a fresh-book retry on another slot books a
  // second real class.
  let committedLessonId: string | null = null

  // Non-null means exactly this: a money RPC has already moved this student's
  // hours, no reversal has been dispatched, and no lesson row exists. The outer
  // catch reads it so that a throw in the window between the deduction and the
  // insert-failure handlers - the Teams call, a transport-level throw at the
  // insert, anything unexpected inside those handlers - can no longer swallow
  // the hours with no lesson, no refund and no log naming the training.
  //
  // Cleared at the DISPATCH of each existing reversal rather than at its
  // completion, and again the moment committedLessonId is set. Dispatch, not
  // completion, because an RPC that throws mid-flight may already have been
  // applied by the database: re-running it from the catch could refund twice.
  // Those clears are what make double-compensation impossible by construction
  // rather than by reasoning about control flow.
  let pendingCompensation: PendingCompensation | null = null

  // Non-null means a Teams meeting exists in Microsoft that no committed lesson
  // row points at. Declared out here, alongside the two above, because the outer
  // catch could not see it while it lived inside the try: a transport-level throw
  // at the lesson insert reversed the hours correctly but left the meeting alive
  // with no lesson row carrying its id, and the orphan sweeper matches on
  // lessons.teams_meeting_id, so nothing could ever find it again.
  //
  // Retired to null at the DISPATCH of each cancel below, and the moment the
  // lesson is committed. Dispatch, not success, mirrors pendingCompensation: a
  // cancel that already failed is CRITICAL-logged, and re-running it from the
  // catch would act on a meeting Graph may already have removed. The commit
  // retirement is the important one - past that point the meeting IS the
  // student's live join link and must never be cancelled.
  let teamsMeetingId: string | null = null

  // The instant captured immediately before the lessons insert, used as the
  // created_at floor when a lost insert response has to be resolved by reading
  // the row back. Both insert-failure gates - the reschedule one and the fresh
  // booking one - and the outer catch read it; it is declared out here with the
  // three above rather than as a const beside the insert because the outer catch
  // could not otherwise see it: a const inside the try is invisible to it. Null
  // means the insert was never reached, so there is nothing to verify.
  let insertStartedAtIso: string | null = null

  // The natural key of the row the insert tried to write, captured at the same
  // instant as the floor above and for the same reason: the outer catch cannot
  // see the parsed body. teacherId, studentId, trainingId, startTime and
  // durationMinutes are all const INSIDE the try, so a throw AT the insert
  // reaches the catch with no way to describe the row it needs to read back.
  // Null means the insert was never reached.
  let insertNaturalKey: {
    teacherId: string
    studentId: string
    trainingId: string
    scheduledAtIso: string
    durationMinutes: number
  } | null = null

  try {
    const supabase = await createClient()

    // ── 1. Verify the student is authenticated ───────────────────────────────
    // Auth runs BEFORE the body is read: an unauthenticated caller must get a
    // bare 401 and never a Zod validation message describing the schema.
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
    }

    // ── 2. Parse and validate request body ───────────────────────────────────
    // The parse gets its own catch: malformed JSON is a client error, and
    // letting it reach the outer catch returned a 500 for a bad request.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const parsed = BookClassSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json({ error: firstError.message }, { status: 400 })
    }
    const { trainingId, teacherId, studentId, durationMinutes, scheduledAt, rescheduleId } = parsed.data

    // Ownership check — the authenticated user must own the requested
    // studentId. Stays below the parse because it needs studentId from the
    // body; step 1 above is what now gates anonymous callers.
    const { data: studentRow, error: studentError } = await supabase
      .from('students')
      .select('id, full_name, email, timezone, auth_user_id, profile_completed, allowed_durations')
      .eq('id', studentId)
      .single()

    if (studentError || !studentRow) {
      return NextResponse.json({ error: 'Student not found.' }, { status: 404 })
    }

    if (studentRow.auth_user_id !== user.id) {
      return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
    }

    if (studentRow.profile_completed !== true) {
      return NextResponse.json(
        { error: 'Please confirm your timezone in My Account before booking a class.', code: 'PROFILE_INCOMPLETE' },
        { status: 403 }
      )
    }

    // ── 2a. Per-student allowed class durations (NEW-A1) ─────────────────────
    // FRESH BOOKINGS ONLY. A reschedule deliberately keeps the ORIGINAL
    // lesson's duration even when that length has since been removed from the
    // student's allowed list, so this branch must never read allowed_durations.
    // The reschedule half of the rule is enforced further down, where oldLesson
    // is loaded: durationMinutes must equal oldLesson.duration_minutes.
    //
    // Fail closed by construction. A null, absent or malformed column value
    // fails Array.isArray (or the .includes below) and blocks the booking —
    // there is deliberately NO permissive fallback, because "we could not read
    // the list" must never resolve to "every duration is allowed". The read
    // itself cannot fail silently either: it is part of the studentRow select
    // above, whose failure already returns 404 before this point.
    //
    // A rejected duration costs the student none of their booking-attempt
    // budget. That no longer depends on this guard sitting above the limiter:
    // the 2b check below only COUNTS, and budget is spent only where an attempt
    // is recorded, immediately before the money RPCs in 4c. Nothing is written
    // on either side of this guard, so the ordering has no state consequences.
    if (!rescheduleId) {
      if (
        !Array.isArray(studentRow.allowed_durations) ||
        !studentRow.allowed_durations.includes(durationMinutes)
      ) {
        return NextResponse.json(
          { error: 'This class length is not enabled on your account. Please contact support.' },
          { status: 403 }
        )
      }
    }

    // ── 2b. Rate limit per student (10 bookings / 60 min, fail closed) ───────
    // Early over-limit gate ONLY: this call counts the attempts already in the
    // window and writes nothing. The attempt for THIS request is recorded later,
    // immediately before the money RPC in 4c, so every validation rejection
    // between here and there costs the student no booking-attempt budget.
    const rl = await checkStudentBookingLimit(studentRow.id)
    if (rl.blocked) {
      return NextResponse.json(
        { error: 'Too many booking attempts. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
      )
    }

    // ── 3. Load the training and check hours balance ───────────────────────────
    const { data: training, error: trainingError } = await supabase
      .from('trainings')
      .select('id, total_hours, hours_consumed, status')
      .eq('id', trainingId)
      .eq('student_id', studentId)
      .single()

    if (trainingError || !training) {
      return NextResponse.json({ error: 'Training not found.' }, { status: 404 })
    }

    if (training.status !== 'active') {
      return NextResponse.json({ error: 'This training is no longer active.' }, { status: 400 })
    }

    const hoursRemaining = training.total_hours - training.hours_consumed
    const hoursNeeded = durationMinutes / 60

    // FRESH BOOKINGS ONLY. A reschedule consumes no ADDITIONAL hours: the
    // duration lock further down pins durationMinutes to the old lesson's
    // duration, so reschedule_class_atomic_keyed's net delta (new - old) is
    // always zero. This absolute check demands a full duration of free balance,
    // so running it on the reschedule branch 400s a fully-consumed student
    // trying to move their last lesson - a move the RPC itself would allow.
    //
    // Nothing is lost by skipping it here. reschedule_class_atomic_keyed is the
    // authoritative gate on that branch: it takes FOR UPDATE on the training
    // row and raises insufficient_hours on (consumed + net > total), which the
    // reschedule branch already maps to this same 400 message. That check is
    // delta-based and therefore correct whether or not the duration lock holds.
    if (!rescheduleId) {
      if (hoursRemaining < hoursNeeded) {
        return NextResponse.json(
          { error: 'You do not have enough hours remaining for this class.' },
          { status: 400 }
        )
      }
    }

    // ── 3b. Enforce 24-hour booking rule ─────────────────────────────────────────
    const hoursUntilClass = (new Date(scheduledAt).getTime() - Date.now()) / (1000 * 60 * 60)
    if (hoursUntilClass < 24) {
      return NextResponse.json(
        { error: 'Classes cannot be booked within 24 hours of the start time.' },
        { status: 400 }
      )
    }

    const adminClient = createAdminClient()

    // Verify the requested teacher is assigned to this training — assignment check, NEW260.
    // The client only offers assigned teachers, but the API must enforce it too: without
    // this, a student could POST any teacherId and book (or reschedule onto) a teacher who
    // was never assigned to their training. Placed before the fresh-book/reschedule split so
    // the single check gates both branches. adminClient because hours_log/junction reads are
    // service-role here and this must not depend on the student's training_teachers RLS.
    const { data: assignedTeacher, error: assignmentError } = await adminClient
      .from('training_teachers')
      .select('teacher_id')
      .eq('training_id', trainingId)
      .eq('teacher_id', teacherId)
      .maybeSingle()

    if (assignmentError) {
      console.error('training_teachers assignment check failed:', assignmentError)
      return NextResponse.json(
        { error: 'Failed to verify teacher assignment. Please try again.' },
        { status: 500 }
      )
    }

    if (!assignedTeacher) {
      return NextResponse.json(
        { error: 'This teacher is not assigned to your training' },
        { status: 403 }
      )
    }

    // ── 3c. Re-check teacher availability server-side ─────────────────────────
    const slotAvailable = await isSlotAvailable(teacherId, scheduledAt, durationMinutes, adminClient)
    if (!slotAvailable) {
      return NextResponse.json(
        { error: 'This time slot is no longer available. Please pick another.', code: 'SLOT_NOT_AVAILABLE' },
        { status: 409 }
      )
    }

    // ── 4. Load the teacher's profile for emails ──────────────────────────────
    const { data: teacher, error: teacherError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, timezone')
      .eq('id', teacherId)
      .single()

    if (teacherError || !teacher) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    // ── 4b. Check teacher is not already booked at this time ─────────────────
    const newStart = new Date(scheduledAt)
    const newEnd = new Date(newStart.getTime() + durationMinutes * 60 * 1000)

    // Reschedule self-clash: both clash checks run BEFORE
    // reschedule_class_atomic cancels the old row, so without this exclusion the
    // lesson being moved counts as a clash against itself and a small shift
    // (e.g. +15 min) 409s. Applied conditionally — on a fresh book rescheduleId
    // is unset and the query is exactly as before.
    // The status filter mirrors the lessons exclusion-constraint predicate
    // (no_teacher_overlap / no_student_overlap): it excludes exactly
    // CANCELLED_STATUSES, so a completed / no-show / missed lesson still counts
    // as a clash here and query and constraint cannot drift.
    let teacherClashQuery = adminClient
      .from('lessons')
      .select('id, scheduled_at, duration_minutes')
      .eq('teacher_id', teacherId)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
      .lt('scheduled_at', newEnd.toISOString())
      .gte('scheduled_at', new Date(newStart.getTime() - 90 * 60 * 1000).toISOString())
    if (rescheduleId) teacherClashQuery = teacherClashQuery.neq('id', rescheduleId)

    const { data: clashLessons, error: teacherClashError } = await teacherClashQuery

    // Fail closed: a query error previously yielded an empty list, which reads as
    // "no clash" and lets the booking proceed straight past the overlap guard.
    if (teacherClashError) {
      console.error('[student book] teacher clash check failed:', teacherClashError)
      return NextResponse.json(
        { error: 'Could not verify availability. Please try again.' },
        { status: 500 }
      )
    }

    const hasClash = (clashLessons ?? []).some(
      (l) =>
        new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000 >
        newStart.getTime()
    )

    if (hasClash) {
      return NextResponse.json(
        { error: 'This time slot is no longer available. Please select a different time.' },
        { status: 409 }
      )
    }

    // 4b-2. Check the student is not already booked at this time. Mirrors the
    // teacher check above exactly (same adminClient, same select, same status
    // filter, same 90-minute back-window, same half-open JS overlap test) but
    // keyed on student_id. Backs the no_student_overlap DB exclusion constraint
    // the same way the teacher check backs no_teacher_overlap.
    // Same reschedule self-clash exclusion as the teacher check above — this is
    // the check the student's own original lesson trips on a shift-in-place.
    let studentClashQuery = adminClient
      .from('lessons')
      .select('id, scheduled_at, duration_minutes')
      .eq('student_id', studentId)
      .not('status', 'in', toPostgrestInList(CANCELLED_STATUSES))
      .lt('scheduled_at', newEnd.toISOString())
      .gte('scheduled_at', new Date(newStart.getTime() - 90 * 60 * 1000).toISOString())
    if (rescheduleId) studentClashQuery = studentClashQuery.neq('id', rescheduleId)

    const { data: studentClashLessons, error: studentClashError } = await studentClashQuery

    // Fail closed, same reasoning as the teacher check above.
    if (studentClashError) {
      console.error('[student book] student clash check failed:', studentClashError)
      return NextResponse.json(
        { error: 'Could not verify availability. Please try again.' },
        { status: 500 }
      )
    }

    const hasStudentClash = (studentClashLessons ?? []).some(
      (l) =>
        new Date(l.scheduled_at).getTime() + l.duration_minutes * 60 * 1000 >
        newStart.getTime()
    )

    if (hasStudentClash) {
      return NextResponse.json(
        { error: 'You already have a class booked at this time.' },
        { status: 409 }
      )
    }

    // ── 4c. Atomic hours reservation ──────────────────────────────────────────
    // Reschedule path uses reschedule_class_atomic_keyed, which cancels the old
    // lesson, refunds its hours, and deducts the new hours in a single
    // transaction. Fresh-booking path uses book_class_atomic_keyed, which only
    // deducts. Both take row-level locks and re-validate state inside the
    // transaction, closing the read-then-write TOCTOU window.
    let oldDurationHours = 0
    let oldTeamsMeetingId: string | null = null
    // Original start time of the rescheduled-from lesson — captured before the RPC
    // cancels it, so the reschedule emails can show "Previous time". Null on a fresh book.
    let oldScheduledAt: string | null = null
    let oldDurationMinutes: number | null = null
    // NEW257: id of the hours_log ledger row inserted by book_class_atomic_keyed.
    // Set only on the fresh-book path below; stays null on the reschedule path
    // (which uses reschedule_class_atomic and is not backfilled here).
    let hoursLogId: string | null = null

    if (rescheduleId) {
      // training_id and teacher_id are selected to feed the two guards below.
      // training_id is ALSO an equality filter: reschedule_class_atomic refunds
      // the old duration against p_training_id (this request's training), not
      // against the old lesson's own training, so without this filter a lesson
      // belonging to another still-active training would have its hours
      // migrated onto this one. Scoped here it reads as not found and falls into
      // the existing 404 'Original lesson not found or no longer reschedulable.'
      const { data: oldLesson, error: oldLessonError } = await adminClient
        .from('lessons')
        .select('duration_minutes, teams_meeting_id, teams_join_url, scheduled_at, training_id, teacher_id')
        .eq('id', rescheduleId)
        .eq('student_id', studentId)
        .eq('training_id', trainingId)
        .eq('status', 'scheduled')
        .maybeSingle()

      if (oldLessonError || !oldLesson) {
        return NextResponse.json(
          { error: 'Original lesson not found or no longer reschedulable.' },
          { status: 404 }
        )
      }

      // Teacher lock. Students may never move a lesson onto a different teacher;
      // the client pins the teacher to rescheduleLesson.teacher_id, so this only
      // fires on a forged POST. The 3b assignment check alone would allow any
      // OTHER teacher assigned to the training, which is why this is separate.
      if (teacherId !== oldLesson.teacher_id) {
        return NextResponse.json(
          {
            error:
              'You cannot change teacher when rescheduling. Please cancel and book a new class instead.',
          },
          { status: 400 }
        )
      }

      // Duration lock (NEW-A1). Same shape as the teacher lock above: the client
      // pins the duration to rescheduleLesson.duration_minutes, and until now
      // nothing on the server enforced it, so a forged POST could silently
      // change the class length (and, via the net-delta refund in
      // reschedule_class_atomic, the hours) while rescheduling.
      //
      // This is ALSO the reschedule half of the allowed-durations rule, which is
      // why it is an equality check against the OLD lesson and not a lookup of
      // students.allowed_durations: rescheduling deliberately preserves a length
      // that may since have been disabled on the account. One guard, both jobs.
      // Runs before any mutation — the atomic RPC is further down.
      if (durationMinutes !== oldLesson.duration_minutes) {
        return NextResponse.json(
          {
            error:
              'The class length cannot be changed when rescheduling. Please cancel and book a new class instead.',
          },
          { status: 400 }
        )
      }

      // 24-hour rule on the OLD lesson. The NEW time is already gated at 3b;
      // this is the missing half — the rule existed only as a disabled attribute
      // on the client, so a lesson starting in 30 minutes, or a past lesson
      // still sitting at 'scheduled', could be moved and its hours recovered.
      // A past start makes this value negative, so one comparison covers both.
      const hoursUntilOldClass =
        (new Date(oldLesson.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60)
      if (hoursUntilOldClass < 24) {
        return NextResponse.json(
          { error: 'Classes cannot be rescheduled within 24 hours of the start time.' },
          { status: 403 }
        )
      }

      oldDurationHours = oldLesson.duration_minutes / 60
      oldTeamsMeetingId = oldLesson.teams_meeting_id ?? null
      oldScheduledAt = oldLesson.scheduled_at ?? null
      oldDurationMinutes = oldLesson.duration_minutes ?? null

      // Record the booking attempt HERE, not at 2b: recording immediately
      // before the money RPC means every validation rejection above (duration,
      // hours, 24h, assignment, slot, clashes, and the four reschedule guards)
      // costs the student none of their booking-attempt budget. Fail closed —
      // if the attempt cannot be recorded, no hours may move.
      const rescheduleAttempt = await recordStudentBookingAttempt(studentRow.id)
      if (!rescheduleAttempt.ok) {
        return NextResponse.json(
          { error: 'Too many booking attempts. Please try again shortly.' },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }

      // Minted per REQUEST, same as the fresh-book branch below: if the RPC's
      // transaction commits but its response leg dies, a retry of THAT call
      // carrying THIS key replays the stored result instead of moving hours a
      // second time. A client that resubmits arrives with no key and gets a
      // fresh reschedule - a user-level retry needs a client-supplied key,
      // which is a later step.
      const idempotencyKey = randomUUID()

      const { data: rescheduleData, error: rescheduleError } = await adminClient.rpc('reschedule_class_atomic_keyed', {
        p_old_lesson_id: rescheduleId,
        p_student_id: studentId,
        p_training_id: trainingId,
        p_old_duration_hours: oldDurationHours,
        p_new_duration_hours: hoursNeeded,
        p_idempotency_key: idempotencyKey,
      })

      // The payload the gates below read. Mutable because the ambiguous-failure
      // probe replaces it with the answer THAT call returned; on every other
      // path it is the direct response, untouched.
      let reschedulePayloadRaw: unknown = rescheduleData
      // True only on the probed path, and gate 2 turns on it: a replay stops
      // being an impossible state there and becomes the expected one.
      let resolvedViaProbe = false

      if (rescheduleError) {
        const msg = (rescheduleError.message || '').toLowerCase()
        if (msg.includes('insufficient_hours')) {
          return NextResponse.json(
            { error: 'You do not have enough hours remaining for this class.' },
            { status: 400 }
          )
        }
        if (msg.includes('old_lesson_not_reschedulable')) {
          return NextResponse.json(
            { error: 'Original lesson not found or no longer reschedulable.' },
            { status: 404 }
          )
        }
        if (msg.includes('training_not_found')) {
          return NextResponse.json({ error: 'Training not found.' }, { status: 404 })
        }

        // Fall-through = none of the three named raises. Those are DEFINITE:
        // each aborts the whole function transaction before or without leaving
        // a keyed ledger row, nothing is half-done, and none may probe. This is
        // a transport/unknown failure instead, so the transaction may have
        // committed before the response leg died - the old lesson may or may not
        // be cancelled and the hours may or may not have moved, and the error in
        // hand cannot say which.
        //
        // The idempotency key makes that decidable. ONE more call carrying the
        // SAME key answers it outright:
        //
        //   replayed: true  - the first call DID commit. The cancel, the report
        //                     delete and the hours move all landed together, and
        //                     the ledger row it wrote comes back here.
        //   replayed: false - the first call never committed, and this probe has
        //                     now performed the reschedule itself, cleanly.
        //
        // Either answer leaves exactly ONE forward leg on the books, which is
        // why the booking CONTINUES on both rather than returning.
        //
        // Exactly ONE probe - no retry, no delay, no loop.
        let probeData: unknown = null
        let probeError: unknown = null
        try {
          const probe = await adminClient.rpc('reschedule_class_atomic_keyed', {
            p_old_lesson_id: rescheduleId,
            p_student_id: studentId,
            p_training_id: trainingId,
            p_old_duration_hours: oldDurationHours,
            p_new_duration_hours: hoursNeeded,
            p_idempotency_key: idempotencyKey,
          })
          probeData = probe.data
          probeError = probe.error
        } catch (probeThrow) {
          // A transport-level throw is a FAILED probe, not an unhandled error.
          // Letting it escape would reach the outer catch with pendingCompensation
          // still unarmed and nothing in the logs naming the key.
          probeError = probeThrow
        }

        if (probeError) {
          const probeMsg =
            typeof probeError === 'object' &&
            probeError !== null &&
            typeof (probeError as { message?: unknown }).message === 'string'
              ? (probeError as { message: string }).message.toLowerCase()
              : ''

          // Two probe errors PROVE the first call rolled back, and the proof is
          // structural: old_lesson_not_reschedulable and insufficient_hours are
          // both raised BELOW the RPC's replay guard. Had the first call
          // committed, the guard would have matched this key and returned before
          // either could fire - so reaching one means no keyed row exists, which
          // means nothing was committed. The request is answered as the ordinary
          // rejection it is: no task, no compensation, nothing held.
          //
          // training_not_found is deliberately NOT in this pair even though it is
          // also a named raise: it sits ABOVE the guard, so it fires whether or
          // not the key is present and proves nothing about the first call. It
          // falls through and holds.
          if (probeMsg.includes('old_lesson_not_reschedulable')) {
            console.warn('reschedule_class_atomic_keyed failed and a same-key probe proved the rollback (old_lesson_not_reschedulable) - nothing was committed:', {
              training_id: trainingId,
              student_id: studentId,
              old_lesson_id: rescheduleId,
              idempotency_key: idempotencyKey,
              error: rescheduleError,
            })
            return NextResponse.json(
              { error: 'Original lesson not found or no longer reschedulable.' },
              { status: 404 }
            )
          }
          if (probeMsg.includes('insufficient_hours')) {
            console.warn('reschedule_class_atomic_keyed failed and a same-key probe proved the rollback (insufficient_hours) - nothing was committed:', {
              training_id: trainingId,
              student_id: studentId,
              old_lesson_id: rescheduleId,
              idempotency_key: idempotencyKey,
              error: rescheduleError,
            })
            return NextResponse.json(
              { error: 'You do not have enough hours remaining for this class.' },
              { status: 400 }
            )
          }

          // Still ambiguous, and nothing may be written on the strength of a
          // guess: unwind_reschedule_atomic would restore a lesson that may
          // never have been cancelled and reverse hours that may never have
          // moved. The idempotency key is what settles it by hand - the
          // hours_log row carrying it either exists or it does not.
          console.error('CRITICAL: reschedule_class_atomic_keyed failed - the old lesson MAY be cancelled and hours MAY have moved with no new lesson, check hours_log for this idempotency key:', {
            training_id: trainingId,
            student_id: studentId,
            old_lesson_id: rescheduleId,
            old_duration_hours: oldDurationHours,
            new_hours_needed: hoursNeeded,
            idempotency_key: idempotencyKey,
            error: rescheduleError,
            probe_error: probeError,
          })
          await raiseReconciliationTask({
            studentId,
            trainingId,
            lessonId: rescheduleId,
            hours: hoursNeeded,
            context: 'reschedule_class_atomic_keyed failed and the same-key probe could not resolve it - manual check required (student reschedule)',
            errorDetail: {
              idempotencyKey,
              rescheduleError,
              probeError,
            },
          })
          return NextResponse.json(
            { error: 'Failed to reschedule. Please try again.' },
            { status: 500 }
          )
        }

        // Resolved. Hand the probe's payload to the gates below in place of the
        // failed call's and fall THROUGH - the reschedule continues from here
        // exactly as it would have had the first call answered. Deliberately
        // console.warn and not console.error: this is a recovery that completed,
        // and nothing on it needs a human.
        reschedulePayloadRaw = probeData
        resolvedViaProbe = true
        console.warn('reschedule_class_atomic_keyed failed but a same-key probe resolved it - exactly one forward leg stands and the booking continues:', {
          training_id: trainingId,
          student_id: studentId,
          old_lesson_id: rescheduleId,
          idempotency_key: idempotencyKey,
          // true = the failed call had committed after all; false = it had not,
          // and the probe itself performed the reschedule.
          replayed:
            probeData !== null && typeof probeData === 'object'
              ? ((probeData as { replayed?: unknown }).replayed ?? null)
              : null,
          error: rescheduleError,
        })
      }

      // Every gate below is HOLD-AND-RAISE, and the hold is the point. None of
      // them may write anything: no lesson is inserted, pendingCompensation is
      // deliberately NOT armed, and unwind_reschedule_atomic is deliberately NOT
      // called - it would restore a lesson that may never have been cancelled
      // and reverse hours that may never have moved.
      //
      // hours on every task below is the GROSS new duration, matching every
      // other reschedule task site in this route: if the forward leg DID commit
      // with no new lesson, hours_consumed sits at old + (new - old) = the full
      // new duration with zero lessons held, so gross IS the exposure. Do not
      // "correct" this to the net delta - that would report 0.
      const reschedulePayload =
        reschedulePayloadRaw !== null && typeof reschedulePayloadRaw === 'object'
          ? (reschedulePayloadRaw as { log_id?: unknown; replayed?: unknown; lesson_id?: unknown })
          : null

      // Gate 1 - malformed payload. reschedule_class_atomic_keyed contracts to
      // return { log_id, replayed, lesson_id }. Anything else means the RPC did
      // not answer in its contracted shape, so the forward leg may or may not
      // have landed and nothing in hand proves which. Applies to the probed
      // payload exactly as it does to the direct one.
      if (
        reschedulePayload === null ||
        typeof reschedulePayload.log_id !== 'string' ||
        reschedulePayload.log_id.length === 0
      ) {
        console.error('CRITICAL: reschedule_class_atomic_keyed returned a malformed payload - the old lesson MAY be cancelled and hours MAY have moved with no new lesson, check hours_log for this idempotency key:', {
          training_id: trainingId,
          student_id: studentId,
          old_lesson_id: rescheduleId,
          old_duration_hours: oldDurationHours,
          new_hours_needed: hoursNeeded,
          idempotency_key: idempotencyKey,
          resolved_via_probe: resolvedViaProbe,
          reschedule_data: reschedulePayloadRaw,
        })
        await raiseReconciliationTask({
          studentId,
          trainingId,
          lessonId: rescheduleId,
          hours: hoursNeeded,
          context: 'reschedule_class_atomic_keyed returned a malformed payload - manual check required (student reschedule)',
          errorDetail: {
            idempotencyKey,
            rescheduleData: reschedulePayloadRaw,
          },
        })
        return NextResponse.json({ error: 'Failed to reschedule. Please try again.' }, { status: 500 })
      }

      // Gate 2 - an UNPROBED replay. The key is minted per request and this was
      // its first and only use, so a replay is unreachable by construction.
      // Reaching it means a key collision or an RPC contract drift, and neither
      // is something to reschedule on top of.
      //
      // Deliberately NO "return the existing booking" success path. Replays only
      // become reachable once the client supplies the key, and answering 200
      // with a lesson id this route did not verify is the kind of guess that
      // hands the student a second real class.
      if (reschedulePayload.replayed === true && !resolvedViaProbe) {
        console.error('CRITICAL: reschedule_class_atomic_keyed replayed a per-request idempotency key - key collision or contract drift, reschedule held with no new lesson and no unwind:', {
          training_id: trainingId,
          student_id: studentId,
          old_lesson_id: rescheduleId,
          old_duration_hours: oldDurationHours,
          new_hours_needed: hoursNeeded,
          idempotency_key: idempotencyKey,
          log_id: reschedulePayload.log_id,
          lesson_id: reschedulePayload.lesson_id ?? null,
        })
        await raiseReconciliationTask({
          studentId,
          trainingId,
          lessonId: rescheduleId,
          hours: hoursNeeded,
          context: 'reschedule_class_atomic_keyed replayed a per-request idempotency key - manual check required (student reschedule)',
          errorDetail: {
            idempotencyKey,
            logId: reschedulePayload.log_id,
            lessonId: reschedulePayload.lesson_id ?? null,
          },
        })
        return NextResponse.json({ error: 'Failed to reschedule. Please try again.' }, { status: 500 })
      }

      // Gate 3 - the ledger row the probe named must be THIS reschedule's.
      //
      // This is the inverse of the fresh-book branch's third gate and the
      // difference is the RPC contract, not a style choice. book_class_atomic_keyed
      // leaves lesson_id null and lets the route backfill it, so there a non-null
      // value is the anomaly. reschedule_class_atomic_keyed stamps lesson_id with
      // p_old_lesson_id inside the transaction, unconditionally, on every
      // successful path including a zero-net same-length move - so here the row
      // MUST come back carrying exactly the lesson this request asked to move. A
      // null or foreign value means the key found somebody else's row, which a
      // key minted inside this request cannot legitimately do.
      //
      // Checked on both probed outcomes, not only on a replay: on replayed=false
      // the equality holds by construction, so this can only ever fire on real
      // contract drift.
      if (resolvedViaProbe && reschedulePayload.lesson_id !== rescheduleId) {
        console.error('CRITICAL: reschedule_class_atomic_keyed same-key probe named a ledger row for a different lesson - reschedule held with no new lesson and no unwind:', {
          training_id: trainingId,
          student_id: studentId,
          old_lesson_id: rescheduleId,
          old_duration_hours: oldDurationHours,
          new_hours_needed: hoursNeeded,
          idempotency_key: idempotencyKey,
          log_id: reschedulePayload.log_id,
          ledger_lesson_id: reschedulePayload.lesson_id ?? null,
        })
        await raiseReconciliationTask({
          studentId,
          trainingId,
          // The lesson this request asked to move is the row a human acts on.
          // The foreign id the ledger named is carried in the detail below.
          lessonId: rescheduleId,
          hours: hoursNeeded,
          context: 'reschedule_class_atomic_keyed same-key probe named a ledger row for a different lesson - manual check required (student reschedule)',
          errorDetail: {
            idempotencyKey,
            logId: reschedulePayload.log_id,
            ledgerLessonId: reschedulePayload.lesson_id ?? null,
          },
        })
        return NextResponse.json({ error: 'Failed to reschedule. Please try again.' }, { status: 500 })
      }

      // Hours have moved: the old lesson is cancelled and the net delta
      // (new - old) is applied to hours_consumed. Own the reversal from here
      // until an insert handler dispatches it or the new lesson is committed.
      // The reversal is unwind_reschedule_atomic with the same four arguments
      // the insert-failure handler below passes - never refund_hours_atomic
      // with hoursNeeded, which would refund a gross duration against a
      // net-delta deduction and hand the student hours they never spent.
      pendingCompensation = {
        kind: 'unwind',
        oldLessonId: rescheduleId,
        trainingId,
        studentId,
        oldDurationHours,
        newDurationHours: hoursNeeded,
      }
    } else {
      // Record the booking attempt HERE, not at 2b — same reasoning as the
      // reschedule branch: recording immediately before the money RPC means
      // validation rejections cost the student none of their booking-attempt
      // budget. Fail closed — if the attempt cannot be recorded, no hours may
      // move.
      const bookAttempt = await recordStudentBookingAttempt(studentRow.id)
      if (!bookAttempt.ok) {
        return NextResponse.json(
          { error: 'Too many booking attempts. Please try again shortly.' },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }

      // Minted per REQUEST, and that is the whole of what it buys today: if the
      // RPC's transaction commits but its response leg dies, a retry of THAT
      // call carrying THIS key replays the stored result instead of deducting a
      // second time. A client that resubmits the booking arrives with no key at
      // all and still gets a fresh deduction - making a user-level retry
      // idempotent needs a client-supplied key, which is a later step.
      const idempotencyKey = randomUUID()

      const { data: deductData, error: deductError } = await adminClient.rpc('book_class_atomic_keyed', {
        p_training_id: trainingId,
        p_hours_needed: hoursNeeded,
        p_idempotency_key: idempotencyKey,
      })

      // The payload the gates below read. Mutable because the ambiguous-failure
      // probe further down replaces it with the answer THAT call returned; on
      // every other path it is the direct response, untouched.
      let deductPayloadRaw: unknown = deductData
      // True only on the probed path, and gate 2 turns on it: a replay stops
      // being an impossible state there and becomes the expected one.
      let resolvedViaProbe = false

      if (deductError) {
        const msg = (deductError.message || '').toLowerCase()
        if (msg.includes('insufficient_hours')) {
          return NextResponse.json(
            { error: 'You do not have enough hours remaining for this class.' },
            { status: 400 }
          )
        }
        if (msg.includes('training_not_active')) {
          return NextResponse.json(
            { error: 'This training is no longer active.' },
            { status: 400 }
          )
        }
        // Fall-through = neither insufficient_hours nor training_not_active. Those
        // two are DEFINITE: the RPC raised before moving anything, no deduction
        // happened, and neither may probe. This is a transport/unknown failure
        // instead, so the transaction may have committed before the response leg
        // died - the hours may or may not have moved, and the error in hand
        // cannot say which.
        //
        // The idempotency key makes that decidable. ONE more call to
        // book_class_atomic_keyed carrying the SAME key answers it outright:
        //
        //   replayed: true  - the first call DID commit. The hours are already
        //                     deducted, the ledger row exists, and its log_id
        //                     comes back here.
        //   replayed: false - the first call never committed, and this probe has
        //                     now performed the deduction itself, cleanly.
        //
        // Either answer leaves exactly ONE deduction on the books, which is why
        // the booking CONTINUES on both rather than returning. It is also safe
        // against the first transaction still committing underneath: the probe's
        // pre-check misses, it deducts, its hours_log insert trips the partial
        // unique index on idempotency_key, and the RPC's own unique_violation
        // handler rolls the probe's deduction back inside its subtransaction and
        // returns the winner's row.
        //
        // Exactly ONE probe - no retry, no delay, no loop. A second attempt could
        // only repeat the answer this one already has, and looping would hold the
        // student's request open against a database that is already failing.
        let probeData: unknown = null
        let probeError: unknown = null
        try {
          const probe = await adminClient.rpc('book_class_atomic_keyed', {
            p_training_id: trainingId,
            p_hours_needed: hoursNeeded,
            p_idempotency_key: idempotencyKey,
          })
          probeData = probe.data
          probeError = probe.error
        } catch (probeThrow) {
          // A transport-level throw is a FAILED probe, not an unhandled error.
          // Letting it escape would reach the outer catch with pendingCompensation
          // still unarmed and nothing in the logs naming the key.
          probeError = probeThrow
        }

        if (probeError) {
          // Still ambiguous, and nothing may be written on the strength of a
          // guess: refund_hours_atomic has no "was never deducted" guard, so a
          // blind refund here could credit hours that were never spent. The
          // idempotency key is what settles it by hand - the hours_log row
          // carrying it either exists or it does not.
          console.error('CRITICAL: book_class_atomic_keyed failed - hours MAY have been deducted with no lesson, check hours_log for this training:', {
            training_id: trainingId,
            student_id: studentId,
            hours: hoursNeeded,
            idempotency_key: idempotencyKey,
            error: deductError,
            probe_error: probeError,
          })
          await raiseReconciliationTask({
            studentId,
            trainingId,
            lessonId: null,
            hours: hoursNeeded,
            context: 'book_class_atomic_keyed failed and the same-key probe could not resolve it - manual check required (student booking)',
            errorDetail: {
              idempotencyKey,
              deductError,
              probeError,
            },
          })
          return NextResponse.json(
            { error: 'Failed to reserve hours. Please try again.' },
            { status: 500 }
          )
        }

        // Resolved. Hand the probe's payload to the gates below in place of the
        // failed call's and fall THROUGH - the booking continues from here
        // exactly as it would have had the first call answered. Deliberately
        // console.warn and not console.error: this is a recovery that completed,
        // and nothing on it needs a human.
        deductPayloadRaw = probeData
        resolvedViaProbe = true
        console.warn('book_class_atomic_keyed failed but a same-key probe resolved it - exactly one deduction stands and the booking continues:', {
          training_id: trainingId,
          student_id: studentId,
          hours: hoursNeeded,
          idempotency_key: idempotencyKey,
          // true = the failed call had committed after all; false = it had not,
          // and the probe itself performed the deduction.
          replayed:
            probeData !== null && typeof probeData === 'object'
              ? ((probeData as { replayed?: unknown }).replayed ?? null)
              : null,
          error: deductError,
        })
      }

      // Every gate below is HOLD-AND-RAISE, and the hold is the point. None of
      // them may write anything: no lesson is inserted, pendingCompensation is
      // deliberately NOT armed, and refund_hours_atomic is deliberately NOT
      // called - it has no "was never deducted" guard, so a blind refund here
      // could credit hours that were never spent. Same reasoning as the
      // unresolved-probe branch above, and the idempotency key is what a human
      // looks the hours_log row up by.
      //
      // deductPayloadRaw, not deductData: on the probed path the payload that
      // has to be judged is the probe's answer, and on every other path the two
      // are the same value.
      const deductPayload =
        deductPayloadRaw !== null && typeof deductPayloadRaw === 'object'
          ? (deductPayloadRaw as { log_id?: unknown; replayed?: unknown; lesson_id?: unknown })
          : null

      // Gate 1 - malformed payload. book_class_atomic_keyed contracts to return
      // { log_id, replayed, lesson_id }. Anything else means the RPC did not
      // answer in its contracted shape, so the hours may or may not have moved
      // and nothing in hand proves which. Applies to the probed payload exactly
      // as it does to the direct one: a probe that answers in the wrong shape has
      // resolved nothing.
      if (
        deductPayload === null ||
        typeof deductPayload.log_id !== 'string' ||
        deductPayload.log_id.length === 0
      ) {
        console.error('CRITICAL: book_class_atomic_keyed returned a malformed payload - hours MAY have been deducted with no lesson, check hours_log for this idempotency key:', {
          training_id: trainingId,
          student_id: studentId,
          hours: hoursNeeded,
          idempotency_key: idempotencyKey,
          resolved_via_probe: resolvedViaProbe,
          deduct_data: deductPayloadRaw,
        })
        await raiseReconciliationTask({
          studentId,
          trainingId,
          lessonId: null,
          hours: hoursNeeded,
          context: 'book_class_atomic_keyed returned a malformed payload - manual check required (student booking)',
          errorDetail: {
            idempotencyKey,
            deductData: deductPayloadRaw,
          },
        })
        return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
      }

      // Gate 2 - replay. Two different states reach this flag now, and
      // resolvedViaProbe is what tells them apart.
      //
      // NOT probed: the key above is minted per request and this was its first
      // and only use, so a replay is unreachable by construction. Reaching it
      // means a key collision or an RPC contract drift, and neither is something
      // to book on top of. The stored lesson_id being null does NOT prove no
      // lesson exists - the 6a backfill is best-effort - so the state is
      // UNKNOWN, not "no class".
      //
      // Deliberately NO "return the existing booking" success path. Replays only
      // become reachable once the client supplies the key, and answering 200
      // with a lesson id this route did not verify is the kind of guess that
      // hands the student a second real class.
      if (deductPayload.replayed === true && !resolvedViaProbe) {
        console.error('CRITICAL: book_class_atomic_keyed replayed a per-request idempotency key - key collision or contract drift, booking held with no lesson and no refund:', {
          training_id: trainingId,
          student_id: studentId,
          hours: hoursNeeded,
          idempotency_key: idempotencyKey,
          log_id: deductPayload.log_id,
          lesson_id: deductPayload.lesson_id ?? null,
        })
        await raiseReconciliationTask({
          studentId,
          trainingId,
          // The stored lesson id when there is one - it is the only row a human
          // can act on. Null is not evidence of absence, only of an unlinked row.
          lessonId: typeof deductPayload.lesson_id === 'string' ? deductPayload.lesson_id : null,
          hours: hoursNeeded,
          context: 'book_class_atomic_keyed replayed a per-request idempotency key - manual check required (student booking)',
          errorDetail: {
            idempotencyKey,
            logId: deductPayload.log_id,
            lessonId: deductPayload.lesson_id ?? null,
          },
        })
        return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
      }

      // Gate 3 - a PROBED replay is the expected, resolved case: the probe
      // reporting that the first call had committed after all. One guard stands
      // between it and the booking. The ledger row the probe named was written by
      // THIS request's first call, which died before it could ever reach the
      // lessons insert, so that row's lesson_id MUST still be null. A non-null
      // one says the row is already linked to a committed lesson, which a key
      // minted inside this request cannot be - so the state is anomalous, and it
      // is held rather than booked on top of, exactly as the unprobed replay is.
      if (
        resolvedViaProbe &&
        deductPayload.replayed === true &&
        deductPayload.lesson_id !== null &&
        deductPayload.lesson_id !== undefined
      ) {
        console.error('CRITICAL: book_class_atomic_keyed same-key probe replayed a ledger row that is already linked to a lesson - booking held with no lesson and no refund:', {
          training_id: trainingId,
          student_id: studentId,
          hours: hoursNeeded,
          idempotency_key: idempotencyKey,
          log_id: deductPayload.log_id,
          lesson_id: deductPayload.lesson_id,
        })
        await raiseReconciliationTask({
          studentId,
          trainingId,
          // The linked lesson is the row a human acts on, so it is carried here.
          lessonId: typeof deductPayload.lesson_id === 'string' ? deductPayload.lesson_id : null,
          hours: hoursNeeded,
          context: 'book_class_atomic_keyed same-key probe replayed a ledger row already linked to a lesson - manual check required (student booking)',
          errorDetail: {
            idempotencyKey,
            logId: deductPayload.log_id,
            lessonId: deductPayload.lesson_id,
          },
        })
        return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
      }

      // NEW257: the id of the 'class_booking' ledger row the RPC inserted, for
      // the lesson_id backfill at 6a. Assigned only past the gates above, so it
      // can never carry a value the shape checks would have rejected.
      hoursLogId = deductPayload.log_id

      // Hours have been deducted. Own the reversal from here until an insert
      // handler dispatches it or the lesson is committed - the same arguments
      // the refund in the insert-failure handler below uses.
      pendingCompensation = { kind: 'refund', trainingId, studentId, hours: hoursNeeded }
    }

    // ── 5. MS Graph API – create Teams meeting ────────────────────────────────
    // Meeting is created under the shared organiser account.
    // The join URL is tied to the lesson slot – not the teacher –
    // so teacher swaps never break the student's link.
    let teamsJoinUrl: string | null = null

    try {
      const meeting = await createTeamsMeeting({
        subject: `LinguaLink class – ${studentRow.full_name} with ${teacher.full_name}`,
        startTime: scheduledAt,
        durationMinutes,
      })
      teamsJoinUrl = meeting.joinUrl
      teamsMeetingId = meeting.meetingId
    } catch (graphError) {
      // Log the error but don't block the booking –
      // admin can manually fix the link if Graph API fails.
      // Sentry will capture this.
      console.error('MS Graph API failed – booking will proceed without Teams link:', graphError)
    }

    // ── 6. Create the new lesson record ───────────────────────────────────────
    const startTime = new Date(scheduledAt)

    // Captured here and nowhere earlier: this is the created_at floor the
    // read-back uses to ignore rows that predate this request, and every
    // millisecond of slack widens the window in which somebody else's booking
    // could be mistaken for ours.
    insertStartedAtIso = new Date().toISOString()
    insertNaturalKey = {
      teacherId,
      studentId,
      trainingId,
      scheduledAtIso: startTime.toISOString(),
      durationMinutes,
    }

    const { data: newLesson, error: lessonError } = await adminClient
      .from('lessons')
      .insert({
        training_id: trainingId,
        teacher_id: teacherId,
        student_id: studentId,
        scheduled_at: startTime.toISOString(),
        duration_minutes: durationMinutes,
        teams_join_url: teamsJoinUrl,
        teams_meeting_id: teamsMeetingId,
        status: 'scheduled',
      })
      .select('id')
      .single()

    if (lessonError || !newLesson) {
      const isSlotConflict = lessonError?.code === '23P01'
      // A 23P01 carries the violated constraint name in the Postgres error text.
      // no_student_overlap means the STUDENT already has an overlapping class;
      // anything else (no_teacher_overlap) keeps the existing wording below.
      const isStudentSlotConflict =
        isSlotConflict &&
        `${lessonError?.message ?? ''} ${lessonError?.details ?? ''}`.includes('no_student_overlap')

      if (rescheduleId) {
        // Is the unwind below actually owed? It is correct ONLY if the insert
        // rolled back. If the insert COMMITTED and merely lost its response,
        // unwinding restores the old lesson alongside a live new one, reverses
        // hours the student has legitimately spent, and cancels the Teams
        // meeting that is now the real class's join link. unwind's own
        // exclusion_violation guard cannot catch that: when the new slot does
        // not overlap the old one there is no violation to raise.
        //
        // A SQLSTATE proves the rollback (see isRollbackProven), so the common
        // case - the 23P01 slot conflict every branch below is written for -
        // skips the read-back entirely and behaves exactly as it always has.
        // Only an UNPROVEN failure pays for a read.
        if (!isRollbackProven(lessonError)) {
          // scheduled_at is startTime.toISOString(), the value the insert
          // actually wrote - not the raw scheduledAt string, which would not
          // match the stored timestamp.
          //
          // Teacher and duration are locked on a reschedule, so the new row's
          // natural key differs from the cancelled old row's only by
          // scheduled_at. Mode B leans on its own cancelled-status exclusion to
          // ignore that old row; nothing is duplicated here.
          const verdict = await verifyLessonCommitted(adminClient, {
            teamsMeetingId,
            teacherId,
            studentId,
            trainingId,
            scheduledAtIso: startTime.toISOString(),
            durationMinutes,
            requestStartIso: insertStartedAtIso,
          })

          if (verdict.outcome === 'committed') {
            // The reschedule SUCCEEDED and only the reply died. Nothing is owed
            // back, so no unwind and no refund; and the meeting must survive,
            // because the committed row carries its id and it is now this
            // student's live join link. Retiring both trackers is what stops
            // the outer catch compensating or cancelling behind us.
            committedLessonId = verdict.lessonId
            pendingCompensation = null
            teamsMeetingId = null

            console.error('CRITICAL: lesson insert committed but its response was lost (student reschedule) - returning success without unwinding:', {
              lesson_id: verdict.lessonId,
              old_lesson_id: rescheduleId,
              training_id: trainingId,
              student_id: studentId,
              error: lessonError,
            })

            // Everything the DATABASE owed this row is already done. Both
            // trg_create_pending_report and trg_snapshot_lesson_rate fire AFTER
            // INSERT on lessons, inside the row's own transaction, so a row that
            // committed carries its pending report and its rate snapshot even
            // when the response was lost. Nothing to recreate from here - only
            // the route-side follow-ups below the success path were missed, and
            // those are named on the reconciliation task.

            // hours is null, not hoursNeeded: the class exists, so the hours are
            // correctly spent and there is no exposure to reconcile. The task is
            // raised for the follow-ups that were skipped, not for money.
            //
            // The three revalidatePath calls were skipped too and are
            // deliberately NOT listed: they are cache invalidations no human can
            // action, and every target re-renders per request anyway.
            await raiseReconciliationTask({
              studentId,
              trainingId,
              lessonId: verdict.lessonId,
              hours: null,
              context: 'lesson insert committed but response lost (student reschedule)',
              errorDetail: {
                note: 'Hours are correct and the class exists - no reversal owed. The pending report and teacher rate snapshot were written by AFTER INSERT triggers on lessons and need no action. Only the items below did not run.',
                skipped: [
                  'the old lesson row still holds live Teams columns and its Microsoft meeting was not cancelled',
                  'no Google Calendar event for the new class, and the old one was not removed',
                  'no reschedule email to the student or the teacher',
                ],
              },
            })

            // Same shape as the normal success return. A 409 or a 500 here would
            // invite a retry that books the student a second real class.
            return NextResponse.json({ success: true, lessonId: verdict.lessonId })
          }

          if (verdict.outcome === 'unresolved') {
            // Neither state is proven, and the dangerous half of the pair is a
            // committed row: unwinding, refunding or cancelling the meeting
            // would each act on a class that may be live. So nothing is written
            // at all and a human decides. Both trackers are retired for that
            // reason - not because either has been dispatched, but so the outer
            // catch cannot compensate or cancel in our place. The meeting is
            // deliberately left ALIVE in Microsoft and named below.
            pendingCompensation = null
            const unresolvedMeetingId = teamsMeetingId
            teamsMeetingId = null

            console.error('CRITICAL: lesson insert verdict unresolved (student reschedule) - no unwind, no refund, no Teams cancel. Manual check required.', {
              old_lesson_id: rescheduleId,
              training_id: trainingId,
              student_id: studentId,
              scheduled_at: startTime.toISOString(),
              teams_meeting_id: unresolvedMeetingId,
              old_duration_hours: oldDurationHours,
              new_hours_needed: hoursNeeded,
              reason: verdict.reason,
              detail: verdict.detail,
              error: lessonError,
            })

            // hours is deliberately the GROSS new duration, matching the failed-unwind
            // site below: if the insert did roll back, hours_consumed sits at
            // old + (new - old) = the full new duration with zero lessons held, so
            // gross IS the student's exposure. Do not "correct" this to the net delta
            // - that would report 0.
            await raiseReconciliationTask({
              studentId,
              trainingId,
              lessonId: rescheduleId,
              hours: hoursNeeded,
              context: 'lesson insert verdict unresolved - manual check required (student reschedule)',
              // Field order is load-bearing: raiseReconciliationTask JSON-renders
              // this and hard-truncates at 500 chars. A Graph event id is long,
              // and this is the one path that leaves a meeting alive in
              // Microsoft with no row pointing at it, so it goes FIRST and the
              // open-ended verdict detail goes last where truncation can only
              // eat what the CRITICAL log above already carries in full.
              errorDetail: {
                teamsMeetingId: unresolvedMeetingId,
                reason: verdict.reason,
                scheduledAt: startTime.toISOString(),
                detail: verdict.detail,
              },
            })

            return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
          }

          // 'not_committed': no row exists, the hours are genuinely owed back,
          // and the unwind below is correct. Fall through unchanged.
        }

        // Reschedule recovery: reschedule_class_atomic has already cancelled
        // the old lesson and applied net delta (new - old) to hours_consumed.
        // unwind_reschedule_atomic restores the old lesson to scheduled and
        // reverses the hours delta in a single transaction. Any orphaned
        // Teams meeting created earlier is cancelled non-blockingly.
        //
        // Note: Teams cols on the old row are intentionally untouched here.
        // reschedule_class_atomic does not modify them, and the original
        // Microsoft meeting is not deleted on the unwind path (only the NEW
        // meeting created at L334-347 is cancelled below). Old row restores
        // to 'scheduled' with its original Teams link intact - the student's
        // working URL survives.
        console.error('Failed to create lesson during reschedule. Attempting unwind.', {
          lesson_id: rescheduleId,
          training_id: trainingId,
          student_id: studentId,
          old_duration_hours: oldDurationHours,
          new_hours_needed: hoursNeeded,
          error: lessonError,
        })
        // The reversal is being dispatched here, so the outer catch must not
        // dispatch a second one - including when this call throws mid-flight,
        // where the database may already have applied it. The CRITICAL log
        // below stays the signal for a reversal that comes back failed.
        pendingCompensation = null
        // A reversal RPC that rejects at the network level never returns an
        // { error } to destructure, so the CRITICAL log and the admin task
        // below would both be skipped on that path. Both channels are funnelled
        // into unwindError so a failed reversal is reported either way.
        let unwindRestored: boolean | null = null
        let unwindError: unknown = null
        try {
          const unwindResult = await adminClient.rpc('unwind_reschedule_atomic', {
            p_old_lesson_id: rescheduleId,
            p_training_id: trainingId,
            p_old_duration_hours: oldDurationHours,
            p_new_duration_hours: hoursNeeded,
          })
          unwindRestored = unwindResult.data
          unwindError = unwindResult.error
        } catch (caughtErr) {
          unwindError = caughtErr
        }
        if (unwindError) {
          console.error('CRITICAL: unwind_reschedule_atomic failed. Manual reconciliation required.', {
            lesson_id: rescheduleId,
            training_id: trainingId,
            student_id: studentId,
            old_duration_hours: oldDurationHours,
            new_hours_needed: hoursNeeded,
            error: unwindError,
          })
          // The log above is only visible in Vercel. Raise the same failure as
          // an admin task so it is visible to whoever reconciles hours. Cannot
          // throw and returns void - control flow below is unchanged.
          // hours here is deliberately the GROSS new duration, not the net reschedule
          // delta: a failed unwind leaves hours_consumed at old + (new - old) = the
          // full new duration with zero lessons held, so gross IS the student's
          // exposure. Do not "correct" this to the net delta - that would report 0.
          await raiseReconciliationTask({
            studentId,
            trainingId,
            lessonId: rescheduleId,
            hours: hoursNeeded,
            context: 'unwind_reschedule_atomic failed after lesson insert error (student reschedule)',
            errorDetail: unwindError,
          })
        }
        if (teamsMeetingId) {
          // Retired before dispatch so the outer catch cannot cancel it a second time.
          const orphanMeetingId = teamsMeetingId
          teamsMeetingId = null
          try {
            await cancelTeamsMeeting(orphanMeetingId)
          } catch (cancelError) {
            console.error('CRITICAL: orphan Teams meeting after reschedule unwind:', {
              teams_meeting_id: orphanMeetingId,
              lesson_id: rescheduleId,
              error: cancelError,
            })
          }
        }

        if (!unwindError && unwindRestored === false) {
          // Hours were returned, but the original lesson could not be restored
          // (its freed slot was taken). The student has no class now but their
          // hours are back — tell them to rebook.
          return NextResponse.json(
            {
              error: 'RESCHEDULE_FAILED_HOURS_RETURNED',
              message:
                'We could not keep your original class and the new time was no longer available. Your hours have been returned — please book a new class.',
            },
            { status: 409 }
          )
        }

        if (isStudentSlotConflict && !unwindError) {
          return NextResponse.json(
            { error: 'SLOT_NOT_AVAILABLE', message: 'You already have a class booked at this time.' },
            { status: 409 }
          )
        }

        if (isSlotConflict && !unwindError) {
          // unwindRestored === true: original lesson is back at its original time.
          // The reschedule simply did not go through — original class is intact.
          return NextResponse.json(
            {
              error: 'SLOT_NOT_AVAILABLE',
              message:
                'That time was just booked by someone else. Your original class is unchanged — please choose a different time.',
            },
            { status: 409 }
          )
        }
        // Any other case (unwindError set, or restored but a non-slot insert error)
        // falls through to the generic 500 below; the CRITICAL log above flags
        // genuine unwind failures for manual reconciliation.
      } else {
        // Is the refund below actually owed? It is correct ONLY if the insert
        // rolled back. If the insert COMMITTED and merely lost its response,
        // refunding reverses hours the student has legitimately spent, cancels
        // the Teams meeting that is now the live class's join link, and answers
        // a 409 or a 500 that invites a rebook - a second real class.
        //
        // A SQLSTATE proves the rollback (see isRollbackProven), so the common
        // case - the 23P01 slot conflict the branches below are written for -
        // skips the read-back entirely and behaves exactly as it always has.
        // Only an UNPROVEN failure pays for a read.
        if (!isRollbackProven(lessonError)) {
          // scheduled_at is startTime.toISOString(), the value the insert
          // actually wrote - not the raw scheduledAt string, which would not
          // match the stored timestamp.
          const verdict = await verifyLessonCommitted(adminClient, {
            teamsMeetingId,
            teacherId,
            studentId,
            trainingId,
            scheduledAtIso: startTime.toISOString(),
            durationMinutes,
            requestStartIso: insertStartedAtIso,
          })

          if (verdict.outcome === 'committed') {
            // The booking SUCCEEDED and only the reply died. Nothing is owed
            // back, so no refund; and the meeting must survive, because the
            // committed row carries its id and it is now this student's live
            // join link. Retiring both trackers is what stops the outer catch
            // compensating or cancelling behind us.
            committedLessonId = verdict.lessonId
            pendingCompensation = null
            teamsMeetingId = null

            console.error('CRITICAL: lesson insert committed but its response was lost (student booking) - returning success without refunding:', {
              lesson_id: verdict.lessonId,
              training_id: trainingId,
              student_id: studentId,
              error: lessonError,
            })

            // Everything the DATABASE owed this row is already done. Both
            // trg_create_pending_report and trg_snapshot_lesson_rate fire AFTER
            // INSERT on lessons, inside the row's own transaction, so a row that
            // committed carries its pending report and its rate snapshot even
            // when the response was lost. Nothing to recreate from here - only
            // the route-side follow-ups below the success path were missed, and
            // those are named on the reconciliation task.

            // hours is null, not hoursNeeded: the class exists, so the hours are
            // correctly spent and there is no exposure to reconcile. The task is
            // raised for the follow-ups that were skipped, not for money.
            //
            // The three revalidatePath calls were skipped too and are
            // deliberately NOT listed: they are cache invalidations no human can
            // action, and every target re-renders per request anyway.
            await raiseReconciliationTask({
              studentId,
              trainingId,
              lessonId: verdict.lessonId,
              hours: null,
              context: 'lesson insert committed but response lost (student booking)',
              errorDetail: {
                note: 'Hours are correct and the class exists - no reversal owed. The pending report and teacher rate snapshot were written by AFTER INSERT triggers on lessons and need no action. Only the items below did not run.',
                skipped: [
                  'the class_booking hours_log row was not linked to the new lesson, so hours_log.lesson_id is still null',
                  'no Google Calendar event for the new class',
                  'no booking confirmation email to the student or the teacher',
                ],
              },
            })

            // Same shape as the normal success return. A 409 or a 500 here would
            // invite a retry that books the student a second real class.
            return NextResponse.json({ success: true, lessonId: verdict.lessonId })
          }

          if (verdict.outcome === 'unresolved') {
            // Neither state is proven, and the dangerous half of the pair is a
            // committed row: unwinding, refunding or cancelling the meeting
            // would each act on a class that may be live. So nothing is written
            // at all and a human decides. Both trackers are retired for that
            // reason - not because either has been dispatched, but so the outer
            // catch cannot compensate or cancel in our place. The meeting is
            // deliberately left ALIVE in Microsoft and named below.
            pendingCompensation = null
            const unresolvedMeetingId = teamsMeetingId
            teamsMeetingId = null

            console.error('CRITICAL: lesson insert verdict unresolved (student booking) - no refund, no Teams cancel. Manual check required.', {
              training_id: trainingId,
              student_id: studentId,
              scheduled_at: startTime.toISOString(),
              teams_meeting_id: unresolvedMeetingId,
              hours_needed: hoursNeeded,
              reason: verdict.reason,
              detail: verdict.detail,
              error: lessonError,
            })

            // hours is the full deduction this request made, so it is the student's
            // exact exposure if the insert rolled back.
            await raiseReconciliationTask({
              studentId,
              trainingId,
              lessonId: null,
              hours: hoursNeeded,
              context: 'lesson insert verdict unresolved - manual check required (student booking)',
              // Field order is load-bearing: raiseReconciliationTask JSON-renders
              // this and hard-truncates at 500 chars. A Graph event id is long,
              // and this is the one path that leaves a meeting alive in
              // Microsoft with no row pointing at it, so it goes FIRST and the
              // open-ended verdict detail goes last where truncation can only
              // eat what the CRITICAL log above already carries in full.
              errorDetail: {
                teamsMeetingId: unresolvedMeetingId,
                reason: verdict.reason,
                scheduledAt: startTime.toISOString(),
                detail: verdict.detail,
              },
            })

            return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
          }

          // 'not_committed': no row exists, the hours are genuinely owed back, and the refund below is correct. Fall through unchanged.
        }

        console.error('Failed to create lesson — refunding deducted hours:', lessonError)
        // Dispatching the reversal here retires it: the outer catch must not
        // run a second one, including when this call throws mid-flight. The two
        // CRITICAL logs below stay the signal for a refund that comes back
        // failed.
        pendingCompensation = null
        // The RPC signals TRAINING_NOT_FOUND / LESSON_NOT_FOUND / ALREADY_REFUNDED in its jsonb payload, not as an error, so both channels must be checked.
        // A throw from the RPC never yields an { error } to destructure; it is
        // funnelled into refundError so the CRITICAL log and the admin task
        // below are reached on that path too.
        let refundData: { success?: boolean; code?: string } | null = null
        let refundError: unknown = null
        try {
          const refundResult = await adminClient.rpc('refund_hours_atomic', {
            p_training_id: trainingId,
            p_hours: hoursNeeded,
          })
          refundData = refundResult.data
          refundError = refundResult.error
        } catch (caughtErr) {
          refundError = caughtErr
        }
        if (refundError) {
          console.error('CRITICAL: refund_hours_atomic failed after lesson insert error:', {
            training_id: trainingId,
            student_id: studentId,
            lesson_id: null,
            error: refundError,
          })
          await raiseReconciliationTask({
            studentId,
            trainingId,
            lessonId: null,
            hours: hoursNeeded,
            context: 'refund_hours_atomic failed after lesson insert error (student booking)',
            errorDetail: refundError,
          })
        } else if (refundData?.success === false) {
          console.error('CRITICAL: refund_hours_atomic reported failure after lesson insert error:', {
            training_id: trainingId,
            student_id: studentId,
            lesson_id: null,
            code: refundData.code,
          })
          await raiseReconciliationTask({
            studentId,
            trainingId,
            lessonId: null,
            hours: hoursNeeded,
            context: 'refund_hours_atomic reported failure after lesson insert error (student booking)',
            errorDetail: refundData.code,
          })
        }

        // Deliberately AFTER the refund dispatch above: cancelTeamsMeeting has no
        // timeout, and a hung Graph DELETE must never strand deducted hours.
        if (teamsMeetingId) {
          // Retired before dispatch so the outer catch cannot cancel it a second time.
          const orphanMeetingId = teamsMeetingId
          teamsMeetingId = null
          try {
            await cancelTeamsMeeting(orphanMeetingId)
          } catch (cancelError) {
            console.error('CRITICAL: orphan Teams meeting after fresh-booking insert failure:', {
              teams_meeting_id: orphanMeetingId,
              lesson_id: null,
              error: cancelError,
            })
          }
        }

        // Both branches above mean the hours were NOT returned. A 409 asserts
        // the slot is gone and the hours are safe: BookingGridClient clears the
        // selection and refetches the grid on it, steering the student straight
        // into a rebook. Only make that assertion when the refund actually
        // landed; otherwise fall through to the generic 500, which leaves the
        // pick in place and does not refetch.
        //
        // This NARROWS the window, it does not close it - the Confirm button
        // still re-enables on the 500, and what actually stops a second
        // book_class_atomic is this route's own pre-checks (isSlotAvailable and
        // the clash checks above), not the status code. It also keeps the
        // invariant that a 409 is never returned alongside an open
        // reconciliation task for the same request: the predicate below is the
        // same pair the two CRITICAL branches test.
        // Mirrors the reschedule branch's !unwindError gate above.
        const refundSucceeded = !refundError && refundData?.success !== false

        if (isStudentSlotConflict && refundSucceeded) {
          return NextResponse.json(
            { error: 'SLOT_NOT_AVAILABLE', message: 'You already have a class booked at this time.' },
            { status: 409 }
          )
        }

        if (isSlotConflict && refundSucceeded) {
          return NextResponse.json(
            { error: 'SLOT_NOT_AVAILABLE', message: 'This slot was just booked by another student. Please choose a different time.' },
            { status: 409 }
          )
        }
      }
      return NextResponse.json({ error: 'Failed to create booking. Please try again.' }, { status: 500 })
    }

    committedLessonId = newLesson.id
    // The lesson exists, so the hours are correctly spent and nothing is owed
    // back. Second, independent guard on top of the committedLessonId check in
    // the outer catch.
    pendingCompensation = null
    // The lesson row now carries this meeting id, so it is no longer an orphan -
    // it is the student's live join link. Retiring it here stops the outer catch
    // from cancelling a meeting for a class that exists.
    teamsMeetingId = null

    // ── 6a. Backfill hours_log.lesson_id (NEW257) ─────────────────────────────
    // book_class_atomic_keyed returned the id of the 'class_booking' ledger row; now
    // that the lesson exists, link the two. Fresh-book path only — hoursLogId is
    // null on the reschedule path (reschedule_class_atomic writes its own paired
    // ledger row and is not backfilled here). Non-blocking: the booking already
    // succeeded and the ledger row exists, so a failure only leaves the link
    // unset — log it and continue. Uses adminClient because hours_log grants
    // students SELECT only (RLS would deny a student-session UPDATE).
    if (hoursLogId) {
      const { error: backfillError } = await adminClient
        .from('hours_log')
        .update({ lesson_id: newLesson.id })
        .eq('id', hoursLogId)
      if (backfillError) {
        console.error('[NEW257] hours_log.lesson_id backfill failed (student book):', {
          hours_log_id: hoursLogId,
          lesson_id: newLesson.id,
          error: backfillError,
        })
      }
    }

    // H1i: After successful reschedule, the OLD lesson row (cancelled by
    // reschedule_class_atomic) still holds the deleted meeting's Teams
    // columns. NULL them inline so the row matches its 'cancelled' status.
    //
    // Placement is load-bearing. Do NOT move this UPDATE into the unwind
    // branch above. On the unwind path the original Teams meeting is never
    // deleted (the route only cancels the NEW meeting on unwind), so
    // nulling the old row's Teams cols there would orphan a live meeting
    // in Microsoft with no DB pointer for the sweeper to find.
    if (oldTeamsMeetingId) {
      let graphSucceeded = true
      try {
        await cancelTeamsMeeting(oldTeamsMeetingId)
      } catch (teamsError) {
        graphSucceeded = false
        console.error('CRITICAL: orphan Teams meeting after student reschedule:', {
          teams_meeting_id: oldTeamsMeetingId,
          lesson_id: rescheduleId,
          error: teamsError,
        })
      }

      // Null Teams cols on the old (now cancelled) row.
      // teams_join_url: unconditional. The URL is dead either way (Graph
      //   DELETE succeeded) or unreachable to the user (cancelled status
      //   hides it from all UI gates). Mirrors H1h.
      // teams_meeting_id: only if graphSucceeded. If Graph DELETE failed,
      //   we leave the id set so scripts/cleanup-orphan-teams-meetings.ts
      //   can recover (sweeper predicate: teams_meeting_id IS NOT NULL
      //   AND status IN cancel-family).
      // needs_teams_cleanup: set true ONLY when Graph DELETE failed. The
      //   orphan meeting still lives in M365 and teams_meeting_id is retained
      //   above; this flag is an explicit admin-visible signal so the orphan
      //   row is directly findable. The intended worklist is
      //   needs_teams_cleanup = true AND teams_meeting_id IS NOT NULL (the AND
      //   excludes rows the sweeper later resolves but does not un-flag). That
      //   beats relying solely on CRITICAL #1 in the logs. The sweeper does not
      //   read this column today (it matches on teams_meeting_id +
      //   cancel-status), so the flag is purely additive. On Graph success we
      //   leave the column at its NOT NULL DEFAULT false — nothing to clean up.
      const updatePayload: Record<string, unknown> = {
        teams_join_url: null,
        updated_at: new Date().toISOString(),
      }
      if (graphSucceeded) {
        updatePayload.teams_meeting_id = null
      } else {
        updatePayload.needs_teams_cleanup = true
      }

      const { data: nulled, error: nullError } = await adminClient
        .from('lessons')
        .update(updatePayload)
        .eq('id', rescheduleId)
        .select('id')

      if (nullError) {
        console.error('CRITICAL: failed to null Teams cols on rescheduled-from lesson:', {
          lesson_id: rescheduleId,
          error: nullError,
        })
      } else if (!nulled || nulled.length === 0) {
        // 0 rows matched means the UPDATE itself landed on no row, so neither
        // the null nor the needs_teams_cleanup flag could be persisted
        // anywhere. This is the one orphan scenario the flag cannot capture
        // (nothing was updated); by necessity the CRITICAL log below is the
        // only signal — it cannot self-heal via the same (unmatched) row.
        console.error('CRITICAL: Teams col null UPDATE affected 0 rows:', {
          lesson_id: rescheduleId,
        })
      }
    }

    // ── 6b. Create the paired pending report row (NEW178) ─────────────────────
    // Every lesson gets a 'pending' report the teacher later completes via
    // complete_report_atomic. Non-blocking: the booking must still succeed if
    // this write fails, so we log and continue.
    const classEndsAtIso = new Date(new Date(scheduledAt).getTime() + durationMinutes * 60 * 1000).toISOString()
    const { error: pendingReportError } = await createPendingReport(adminClient, newLesson.id, teacherId, classEndsAtIso)
    if (pendingReportError) {
      console.error('[NEW178] pending report create failed (student book):', {
        lesson_id: newLesson.id,
        error: pendingReportError,
      })
    }

    // ── 6c. Mirror the class onto the connected Google Calendar ─────────
    // GCAL REBUILD 2. Writes a private time-block on the connected account's
    // own calendar and stores the event id on this lesson row. Non-blocking by
    // construction - createLessonGoogleEvent never throws and returns nothing,
    // so there is no branch here and no failure of it can change what the
    // student is told. Awaited rather than fired and forgotten because the
    // serverless function can be frozen the instant the response is returned,
    // which would silently drop a dangling promise mid-request.
    //
    // The RESCHEDULE path lands here too, and that is intended: the insert
    // above created a NEW lesson row, so it needs its own event. The OLD row's
    // event is taken back off the calendar by the gated delete immediately
    // below.
    await createLessonGoogleEvent({
      lessonId: newLesson.id,
      teacherId,
      studentName: studentRow.full_name,
      scheduledAtIso: startTime.toISOString(),
      durationMinutes,
    })

    // Now take the OLD block back off the calendar. ORDER IS LOAD-BEARING: the
    // new event is created FIRST and the old one deleted after. Reversed, a
    // create that fails would leave the class with no block on her calendar at
    // all - the exact failure this rebuild exists to remove. This way round the
    // worst case is a stale block sitting on the old time, which is visible to
    // her and recoverable.
    //
    // Gated on rescheduleId because a fresh booking has no old row to clean up.
    //
    // Deliberately OUTSIDE the if (oldTeamsMeetingId) block above: the Google
    // event exists independently of any Teams meeting, so nesting it there
    // would skip a lesson booked before that integration existed.
    //
    // Unreachable on the unwind path - every branch of the insert-failure block
    // returns, so this line only runs once the new lesson row is committed.
    if (rescheduleId) {
      await deleteLessonGoogleEvent(rescheduleId)
    }

    // ── 7. Send confirmation emails ───────────────────────────────────────────
    const isReschedule = !!rescheduleId
    const newScheduledAtIso = startTime.toISOString()

    // One try per recipient. Previously both guards were hoisted above a single
    // Promise.allSettled, so a null timezone on either side threw before either
    // send was built and the route still returned 200 - silent loss of both
    // confirmations on a booking that had already committed.
    try {
      const studentTimezone = requireTz(studentRow.timezone, 'book:student')

      const studentSubject = isReschedule
        ? 'Lingualink Online - Your class has been rescheduled'
        : 'Lingualink Online - Your class is confirmed'

      const studentBodyHtml = isReschedule
        ? studentRescheduledEmailContent(oldScheduledAt, oldDurationMinutes, newScheduledAtIso, durationMinutes, studentTimezone, 'student')
        : studentBookingConfirmationEmailContent(newScheduledAtIso, durationMinutes, studentTimezone)

      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: studentRow.email,
        subject: studentSubject,
        html: buildEmailTemplate({
          recipientName: studentRow.full_name,
          recipientFallback: 'Student',
          subject: studentSubject,
          bodyHtml: studentBodyHtml,
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    } catch (emailErr) {
      console.error('[Email] Student booking/reschedule email failed - lesson still created:', { lesson_id: newLesson.id, error: emailErr })
    }

    try {
      const teacherTimezone = requireTz(teacher.timezone, 'book:teacher')

      const teacherSubject = isReschedule
        ? `Lingualink Online - Class rescheduled by ${studentRow.full_name}`
        : `Lingualink Online - New class booked with ${studentRow.full_name}`

      const teacherBodyHtml = isReschedule
        ? teacherRescheduledEmailContent(studentRow.full_name, oldScheduledAt, oldDurationMinutes, newScheduledAtIso, durationMinutes, teacherTimezone, 'student')
        : teacherNewBookingEmailContent(studentRow.full_name, newScheduledAtIso, durationMinutes, teacherTimezone)

      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: teacher.email,
        subject: teacherSubject,
        html: buildEmailTemplate({
          recipientName: teacher.full_name,
          recipientFallback: 'Teacher',
          subject: teacherSubject,
          bodyHtml: teacherBodyHtml,
          contactEmail: 'teachers@lingualinkonline.com',
        }),
      })
    } catch (emailErr) {
      console.error('[Email] Teacher booking/reschedule email failed - lesson still created:', { lesson_id: newLesson.id, error: emailErr })
    }

    revalidatePath('/upcoming-classes')
    revalidatePath('/student/my-classes')
    revalidatePath('/admin/classes')
    // ── 8. Return success ─────────────────────────────────────────────────────
    return NextResponse.json({ success: true, lessonId: newLesson.id })

  } catch (err) {
    if (committedLessonId) {
      // The lesson exists and hours have moved. Whatever threw was one of the
      // documented non-blocking follow-ups (ledger backfill, Teams null on the
      // old row, pending report, emails, revalidate). Report success so the
      // client does not offer a retry that would book a second class; the
      // CRITICAL log is the signal for manual follow-up.
      console.error('CRITICAL: post-commit step threw in /api/student/book - lesson committed, returning success:', {
        lesson_id: committedLessonId,
        error: err,
      })
      return NextResponse.json({ success: true, lessonId: committedLessonId })
    }

    // A throw AT the insert - a transport abort, a client that threw instead of
    // returning an error - lands here with the compensation still armed and no
    // lesson id, and the compensation block below would then act blind. The
    // insert was REACHED (both trackers are non-null only from the line before
    // it) and the throw carries no SQLSTATE, so committed and rolled-back are
    // indistinguishable without a read. A null insertStartedAtIso means the
    // throw came before the insert: no row can exist, and the compensation below
    // is correct exactly as it stands.
    //
    // Nothing in this block can throw. createAdminClient is wrapped below, and
    // verifyLessonCommitted and raiseReconciliationTask never throw by
    // contract - so the compensation block, the orphan cancel and the 500 at the
    // end of this catch all stay reachable on the fall-through path.
    if (pendingCompensation && insertNaturalKey && insertStartedAtIso && !isRollbackProven(err)) {
      // Copied into consts before the awaits below, the same reason the
      // compensation block does const pending = pendingCompensation: these are
      // handler-scope bindings that this block itself sets back to null.
      const pending = pendingCompensation
      const key = insertNaturalKey
      const requestStartIso = insertStartedAtIso

      // The route's own adminClient is scoped to the try and may never have been
      // constructed, so the read-back builds its own. If it cannot even be built
      // there is no read to be had - which IS an unresolved verdict, never a
      // licence to fall through and compensate against a class that may be live.
      let verifyClient: ReturnType<typeof createAdminClient> | null = null
      let verifyClientError: unknown = null
      try {
        verifyClient = createAdminClient()
      } catch (clientError) {
        verifyClientError = clientError
      }

      const verdict = verifyClient
        ? await verifyLessonCommitted(verifyClient, {
            teamsMeetingId,
            teacherId: key.teacherId,
            studentId: key.studentId,
            trainingId: key.trainingId,
            scheduledAtIso: key.scheduledAtIso,
            durationMinutes: key.durationMinutes,
            requestStartIso,
          })
        : ({ outcome: 'unresolved', reason: 'verify_failed', detail: verifyClientError } as const)

      if (verdict.outcome === 'committed') {
        // The class SUCCEEDED and only the reply died. Nothing is owed back, so
        // no unwind and no refund; and the meeting must survive, because the
        // committed row carries its id and it is now this student's live join
        // link. Retiring both trackers is what stops the compensation block and
        // the orphan cancel below running behind us.
        pendingCompensation = null
        teamsMeetingId = null

        if (pending.kind === 'unwind') {
          console.error('CRITICAL: lesson insert committed but its response was lost (student reschedule, outer catch) - returning success without unwinding:', {
            lesson_id: verdict.lessonId,
            old_lesson_id: pending.oldLessonId,
            training_id: pending.trainingId,
            student_id: pending.studentId,
            error: err,
          })
        } else {
          console.error('CRITICAL: lesson insert committed but its response was lost (student booking, outer catch) - returning success without refunding:', {
            lesson_id: verdict.lessonId,
            training_id: pending.trainingId,
            student_id: pending.studentId,
            error: err,
          })
        }

        // Everything the DATABASE owed this row is already done. Both
        // trg_create_pending_report and trg_snapshot_lesson_rate fire AFTER
        // INSERT on lessons, inside the row's own transaction, so a row that
        // committed carries its pending report and its rate snapshot even
        // when the response was lost. Nothing to recreate from here - only
        // the route-side follow-ups below the success path were missed, and
        // those are named on the reconciliation task.

        // hours is null, not the pending amount: the class exists, so the hours
        // are correctly spent and there is no exposure to reconcile. The task is
        // raised for the follow-ups that were skipped, not for money.
        //
        // The three revalidatePath calls were skipped too and are
        // deliberately NOT listed: they are cache invalidations no human can
        // action, and every target re-renders per request anyway.
        await raiseReconciliationTask({
          studentId: pending.studentId,
          trainingId: pending.trainingId,
          lessonId: verdict.lessonId,
          hours: null,
          context:
            pending.kind === 'unwind'
              ? 'lesson insert committed but response lost (student reschedule, outer catch)'
              : 'lesson insert committed but response lost (student booking, outer catch)',
          errorDetail: {
            note: 'Hours are correct and the class exists - no reversal owed. The pending report and teacher rate snapshot were written by AFTER INSERT triggers on lessons and need no action. Only the items below did not run.',
            skipped:
              pending.kind === 'unwind'
                ? [
                    'the old lesson row still holds live Teams columns and its Microsoft meeting was not cancelled',
                    'no Google Calendar event for the new class, and the old one was not removed',
                    'no reschedule email to the student or the teacher',
                  ]
                : [
                    'the class_booking hours_log row was not linked to the new lesson, so hours_log.lesson_id is still null',
                    'no Google Calendar event for the new class',
                    'no booking confirmation email to the student or the teacher',
                  ],
          },
        })

        // Same shape as the normal success return. A 500 here would invite a
        // retry that books the student a second real class.
        return NextResponse.json({ success: true, lessonId: verdict.lessonId })
      }

      if (verdict.outcome === 'unresolved') {
        // Neither state is proven, and the dangerous half of the pair is a
        // committed row: unwinding, refunding or cancelling the meeting would
        // each act on a class that may be live. So nothing is written at all and
        // a human decides. Both trackers are retired for that reason - not
        // because either has been dispatched, but so the compensation block and
        // the orphan cancel below cannot run in our place. The meeting is
        // deliberately left ALIVE in Microsoft and named below.
        pendingCompensation = null
        const unresolvedMeetingId = teamsMeetingId
        teamsMeetingId = null

        if (pending.kind === 'unwind') {
          console.error('CRITICAL: lesson insert verdict unresolved (student reschedule, outer catch) - no unwind, no refund, no Teams cancel. Manual check required.', {
            old_lesson_id: pending.oldLessonId,
            training_id: pending.trainingId,
            student_id: pending.studentId,
            scheduled_at: key.scheduledAtIso,
            teams_meeting_id: unresolvedMeetingId,
            old_duration_hours: pending.oldDurationHours,
            new_hours_needed: pending.newDurationHours,
            reason: verdict.reason,
            detail: verdict.detail,
            error: err,
          })
        } else {
          console.error('CRITICAL: lesson insert verdict unresolved (student booking, outer catch) - no refund, no Teams cancel. Manual check required.', {
            training_id: pending.trainingId,
            student_id: pending.studentId,
            scheduled_at: key.scheduledAtIso,
            teams_meeting_id: unresolvedMeetingId,
            hours_needed: pending.hours,
            reason: verdict.reason,
            detail: verdict.detail,
            error: err,
          })
        }

        // hours is deliberately the GROSS new duration on the unwind kind, matching
        // the failed-unwind site above: if the insert did roll back, hours_consumed
        // sits at old + (new - old) = the full new duration with zero lessons held,
        // so gross IS the student's exposure. Do not "correct" this to the net delta
        // - that would report 0.
        //
        // On the refund kind hours is the full deduction this request made, so it is
        // the student's exact exposure if the insert rolled back.
        await raiseReconciliationTask({
          studentId: pending.studentId,
          trainingId: pending.trainingId,
          lessonId: pending.kind === 'unwind' ? pending.oldLessonId : null,
          hours: pending.kind === 'unwind' ? pending.newDurationHours : pending.hours,
          context:
            pending.kind === 'unwind'
              ? 'lesson insert verdict unresolved - manual check required (student reschedule, outer catch)'
              : 'lesson insert verdict unresolved - manual check required (student booking, outer catch)',
          // Field order is load-bearing: raiseReconciliationTask JSON-renders
          // this and hard-truncates at 500 chars. A Graph event id is long,
          // and this is the one path that leaves a meeting alive in
          // Microsoft with no row pointing at it, so it goes FIRST and the
          // open-ended verdict detail goes last where truncation can only
          // eat what the CRITICAL log above already carries in full.
          errorDetail: {
            teamsMeetingId: unresolvedMeetingId,
            reason: verdict.reason,
            scheduledAt: key.scheduledAtIso,
            detail: verdict.detail,
          },
        })

        console.error('Unexpected error in /api/student/book:', err)
        return NextResponse.json({ error: 'An unexpected error occurred. Please try again.' }, { status: 500 })
      }

      // 'not_committed': no row exists, the hours are genuinely owed back, and the compensation below is correct. Fall through unchanged.
    }

    // No lesson row exists. If a money RPC already moved this student's hours
    // and no reversal has been dispatched, reverse it here - otherwise the
    // throw leaves the hours deducted against a class that does not exist, with
    // nothing in the logs naming the training. Every path that dispatches a
    // reversal, and the commit itself, null pendingCompensation first, so this
    // block can never be a second compensation.
    //
    // Its own try/catch, and a fresh service-role client: adminClient is scoped
    // to the try above and may never have been constructed. Whatever happens
    // here, the 500 below is still returned and this catch never throws.
    if (pendingCompensation) {
      const pending = pendingCompensation
      pendingCompensation = null
      try {
        const recoveryClient = createAdminClient()
        if (pending.kind === 'refund') {
          const { data: refundData, error: refundError } = await recoveryClient.rpc('refund_hours_atomic', {
            p_training_id: pending.trainingId,
            p_hours: pending.hours,
          })
          if (refundError) {
            console.error('CRITICAL: refund_hours_atomic failed after an unexpected throw in /api/student/book. Hours are deducted with no lesson - manual reconciliation required.', {
              training_id: pending.trainingId,
              student_id: pending.studentId,
              lesson_id: null,
              hours: pending.hours,
              error: refundError,
            })
            await raiseReconciliationTask({
              studentId: pending.studentId,
              trainingId: pending.trainingId,
              lessonId: null,
              hours: pending.hours,
              context: 'refund_hours_atomic failed after an unexpected throw in /api/student/book',
              errorDetail: refundError,
            })
          } else if (refundData?.success === false) {
            console.error('CRITICAL: refund_hours_atomic reported failure after an unexpected throw in /api/student/book. Hours are deducted with no lesson - manual reconciliation required.', {
              training_id: pending.trainingId,
              student_id: pending.studentId,
              lesson_id: null,
              hours: pending.hours,
              code: refundData.code,
            })
            await raiseReconciliationTask({
              studentId: pending.studentId,
              trainingId: pending.trainingId,
              lessonId: null,
              hours: pending.hours,
              context: 'refund_hours_atomic reported failure after an unexpected throw in /api/student/book',
              errorDetail: refundData.code,
            })
          } else {
            console.error('CRITICAL: hours auto-refunded after an unexpected throw in /api/student/book - no lesson was created.', {
              training_id: pending.trainingId,
              hours: pending.hours,
            })
          }
        } else {
          const { data: unwindRestored, error: unwindError } = await recoveryClient.rpc('unwind_reschedule_atomic', {
            p_old_lesson_id: pending.oldLessonId,
            p_training_id: pending.trainingId,
            p_old_duration_hours: pending.oldDurationHours,
            p_new_duration_hours: pending.newDurationHours,
          })
          if (unwindError) {
            console.error('CRITICAL: unwind_reschedule_atomic failed after an unexpected throw in /api/student/book. Manual reconciliation required.', {
              lesson_id: pending.oldLessonId,
              training_id: pending.trainingId,
              student_id: pending.studentId,
              old_duration_hours: pending.oldDurationHours,
              new_hours_needed: pending.newDurationHours,
              error: unwindError,
            })
            // hours here is deliberately the GROSS new duration, not the net reschedule
            // delta: a failed unwind leaves hours_consumed at old + (new - old) = the
            // full new duration with zero lessons held, so gross IS the student's
            // exposure. Do not "correct" this to the net delta - that would report 0.
            await raiseReconciliationTask({
              studentId: pending.studentId,
              trainingId: pending.trainingId,
              lessonId: pending.oldLessonId,
              hours: pending.newDurationHours,
              context: 'unwind_reschedule_atomic failed after an unexpected throw in /api/student/book',
              errorDetail: unwindError,
            })
          } else if (unwindRestored === false) {
            // Hours are back but the original lesson could not be restored: its
            // freed slot was taken. Same state the 409 in the insert handler
            // reports, except the student is getting a 500 here and will not be
            // told to rebook, so it is logged CRITICAL rather than left silent.
            console.error('CRITICAL: reschedule auto-unwound after an unexpected throw in /api/student/book - hours returned but the original lesson could NOT be restored.', {
              lesson_id: pending.oldLessonId,
              training_id: pending.trainingId,
              old_duration_hours: pending.oldDurationHours,
              new_hours_needed: pending.newDurationHours,
            })
          } else {
            console.error('CRITICAL: reschedule auto-unwound after an unexpected throw in /api/student/book - original lesson restored, no new lesson was created.', {
              lesson_id: pending.oldLessonId,
              training_id: pending.trainingId,
              old_duration_hours: pending.oldDurationHours,
              new_hours_needed: pending.newDurationHours,
            })
          }
        }
      } catch (compensationError) {
        console.error('CRITICAL: compensation threw after an unexpected throw in /api/student/book. Hours may be deducted with no lesson - manual reconciliation required.', {
          kind: pending.kind,
          training_id: pending.trainingId,
          student_id: pending.studentId,
          lesson_id: pending.kind === 'unwind' ? pending.oldLessonId : null,
          hours: pending.kind === 'refund' ? pending.hours : pending.newDurationHours,
          error: compensationError,
        })
        await raiseReconciliationTask({
          studentId: pending.studentId,
          trainingId: pending.trainingId,
          lessonId: pending.kind === 'unwind' ? pending.oldLessonId : null,
          hours: pending.kind === 'refund' ? pending.hours : pending.newDurationHours,
          context: 'compensation threw after an unexpected throw in /api/student/book',
          errorDetail: compensationError,
        })
      }
    }

    // A Teams meeting was created and no lesson row was ever committed, so
    // nothing in the database points at it. Best-effort cancel. Placed after the
    // compensation block so a slow or hanging Graph call can never delay the
    // student's hours reversal, and wrapped in its own try/catch because
    // cancelTeamsMeeting swallows a 404 as success but rethrows every other Graph
    // failure - this catch must not throw, the 500 below is still returned either
    // way.
    if (teamsMeetingId) {
      const orphanMeetingId = teamsMeetingId
      teamsMeetingId = null
      try {
        await cancelTeamsMeeting(orphanMeetingId)
      } catch (cancelError) {
        console.error('CRITICAL: orphan Teams meeting after an unexpected throw in /api/student/book - no lesson row references it:', {
          teams_meeting_id: orphanMeetingId,
          lesson_id: null,
          error: cancelError,
        })
      }
    }

    console.error('Unexpected error in /api/student/book:', err)
    return NextResponse.json({ error: 'An unexpected error occurred. Please try again.' }, { status: 500 })
  }
}
