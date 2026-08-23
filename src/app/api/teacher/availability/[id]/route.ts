import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { reconcileSpecific } from '@/lib/availability/reconcileSpecific'
import {
  TeacherAvailabilityIdSchema,
  TeacherAvailabilityMoveSchema,
} from '@/lib/validation/schemas'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const admin = createAdminClient()
  const { data: record, error: fetchError } = await admin
    .from('availability')
    .select('teacher_id, source')
    .eq('id', id)
    .maybeSingle()

  if (fetchError) {
    console.error('[DELETE /api/teacher/availability/[id]] fetch', fetchError)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Source gate. Deliberately placed BEFORE the admin-escalation branch and
  // before the delete: Google Calendar owns 'google_sync' rows, so no role may
  // remove them here. An admin bypass would not even be useful - the next sync
  // run restores the row - it would only make the portal lie about what it did.
  //
  // Strict allow-list, not `!== 'google_sync'`: the column is NOT NULL with a
  // CHECK of ('manual','google_sync'), so anything else means the schema moved
  // under this route and the safe answer is to refuse rather than guess.
  if (record.source !== 'manual') {
    if (record.source === 'google_sync') {
      return NextResponse.json(
        { error: 'This block is synced from Google Calendar and cannot be deleted here.' },
        { status: 403 }
      )
    }
    console.error(
      '[DELETE /api/teacher/availability/[id]] unrecognised availability.source, refusing delete:',
      record.source
    )
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  // Admin escalation - see the comment in the sibling POST route for why this is
  // requireAdmin and not requireStaff.
  if (record.teacher_id !== user.id) {
    try {
      const adminUser = await requireAdmin()
      if (!adminUser) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } catch (err) {
      console.error('[DELETE /api/teacher/availability/[id]] admin escalation check failed:', err)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }
  }

  const { error } = await admin.from('availability').delete().eq('id', id)

  if (error) {
    console.error('[DELETE /api/teacher/availability/[id]]', error)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  revalidatePath('/schedule')
  return NextResponse.json({ success: true })
}

// Move or resize an existing MANUAL timed 'specific' block: the row keeps its
// meaning and its owner, only its [start_at, end_at) changes. Implemented as
// supersede -> insert -> remove-the-original rather than an UPDATE, so the new
// position goes through exactly the same reconcile the POST route applies to a
// fresh drag (src/app/api/teacher/availability/route.ts) and a move can no more
// stack invisible duplicates than a create can.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Route param, validated before it is used as a filter value anywhere.
  const { id: rawId } = await params
  const parsedId = TeacherAvailabilityIdSchema.safeParse(rawId)
  if (!parsedId.success) {
    return NextResponse.json({ error: parsedId.error.issues[0].message }, { status: 400 })
  }
  const id = parsedId.data

  // A malformed body throws out of request.json(); catching it keeps that a 400
  // rather than an unhandled 500.
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  // start_at and end_at are the ONLY fields this route reads from the caller.
  // is_available, type and teacher_id are taken from the fetched row below, so
  // no body can flip a block's polarity, change its kind, or move it to another
  // teacher's calendar.
  const parsedBody = TeacherAvailabilityMoveSchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.issues[0].message }, { status: 400 })
  }
  const { start_at, end_at } = parsedBody.data

  // The schema already rejects an unparseable or backwards range; these are the
  // numeric forms the past-start guard, the overlap query and reconcileSpecific
  // all need, re-checked so nothing downstream can be handed a NaN.
  const newStartMs = Date.parse(start_at)
  const newEndMs = Date.parse(end_at)
  if (!Number.isFinite(newStartMs) || !Number.isFinite(newEndMs) || newEndMs <= newStartMs) {
    return NextResponse.json({ error: 'End must be after start' }, { status: 400 })
  }

  // Past-start guard. DayToDay refuses to begin or extend a drag on a past slot
  // (startDrag / extendDrag), but that is a UI convenience and this route is
  // reachable directly, so the server enforces the same rule. Instant vs
  // instant: frame-free, no timezone involved.
  if (newStartMs < Date.now()) {
    return NextResponse.json(
      { error: 'A block cannot be moved into the past.' },
      { status: 400 }
    )
  }

  const admin = createAdminClient()

  // Fetch the target FIRST. Every decision that follows - who owns it, whether
  // it may be moved at all, and what polarity the moved row keeps - is taken
  // from this row and never from anything the caller supplied.
  const { data: record, error: fetchError } = await admin
    .from('availability')
    .select('id, teacher_id, type, source, is_available, start_at, end_at')
    .eq('id', id)
    .maybeSingle()

  if (fetchError) {
    console.error('[PATCH /api/teacher/availability/[id]] fetch', fetchError)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Source gate, in the same position and the same shape as DELETE's above:
  // before the admin-escalation branch and before any write. Google Calendar
  // owns 'google_sync' rows and the busy-sync cron replaces its own generation
  // every run, so a move here would be undone within the quarter hour and would
  // only make the portal lie about what it did. Strict allow-list rather than
  // `!== 'google_sync'`, for the same reason DELETE uses one: anything else
  // means the schema moved under this route.
  if (record.source !== 'manual') {
    if (record.source === 'google_sync') {
      return NextResponse.json(
        { error: 'This block is synced from Google Calendar and cannot be moved here.' },
        { status: 403 }
      )
    }
    console.error(
      '[PATCH /api/teacher/availability/[id]] unrecognised availability.source, refusing move:',
      record.source
    )
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  // Type gate. Only timed day-to-day blocks have a movable [start_at, end_at).
  // A 'general' row is a weekly wall-clock slot keyed on day_of_week /
  // start_time / end_time, which this route leaves untouched, so moving one
  // would produce a row that is neither shape; a 'holiday' row is a span of
  // calendar DATES read by its stored date portion. reconcileSpecific covers
  // neither, and both are edited from their own tabs.
  if (record.type !== 'specific') {
    return NextResponse.json(
      { error: 'Only day-to-day availability blocks can be moved.' },
      { status: 400 }
    )
  }

  // Admin escalation - identical to DELETE's, and gated on the FETCHED row's
  // teacher_id. See the comment in the sibling POST route for why this is
  // requireAdmin and not requireStaff.
  if (record.teacher_id !== user.id) {
    try {
      const adminUser = await requireAdmin()
      if (!adminUser) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } catch (err) {
      console.error('[PATCH /api/teacher/availability/[id]] admin escalation check failed:', err)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }
  }

  // Reconcile candidates: the same query POST's specific branch runs, plus
  // .neq('id', id). That exclusion is load-bearing. Without it the row being
  // moved is its own candidate whenever the new range overlaps the old one -
  // which is every nudge and every resize - so it would be trimmed against its
  // own former position and the move would leave a sliver of itself behind.
  // source='manual' and type='specific' keep google_sync and holiday rows out
  // of the candidate set, and therefore out of the delete below.
  const { data: candidates, error: candidatesError } = await admin
    .from('availability')
    .select('id, start_at, end_at, is_available')
    .eq('teacher_id', record.teacher_id)
    .eq('type', 'specific')
    .eq('source', 'manual')
    .neq('id', id)
    .lt('start_at', end_at)
    .gt('end_at', start_at)

  if (candidatesError) {
    console.error('[PATCH /api/teacher/availability/[id]] overlap lookup failed:', candidatesError)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  const { deleteIds, remainders } = reconcileSpecific(
    { startMs: newStartMs, endMs: newEndMs, isAvailable: record.is_available },
    candidates ?? []
  )

  // WRITE ORDER: supersede -> insert -> remove the original, and the original
  // goes LAST on purpose.
  //
  // These are separate PostgREST round trips with no transaction across them,
  // so any one of them can be the last that lands. Removing the original first
  // would mean a later failure erases the block from the calendar outright.
  // Removing it last means the worst partial outcome is the NEW block and the
  // OLD block both present: the teacher loses nothing, the duplicate is cleaned
  // up by the next reconcile-on-write over either range, and it fails in the
  // over-blocking direction - a doubled 'unavailable' block simply blocks
  // twice, and a doubled 'available' block offers the slots it already offered.
  // google_sync rows are excluded from every query in this handler, so the
  // cron's generational replace can never be corrupted from here.
  if (deleteIds.length > 0) {
    // deleteIds can never contain the target itself: .neq('id', id) kept it out
    // of the candidate set. The teacher/type/source filters are defence in
    // depth, exactly as in POST - these ids already came from a query scoped
    // this way - and are kept so no future edit can widen the delete by
    // widening the select.
    const { error: supersededError } = await admin
      .from('availability')
      .delete()
      .eq('teacher_id', record.teacher_id)
      .eq('type', 'specific')
      .eq('source', 'manual')
      .in('id', deleteIds)

    if (supersededError) {
      console.error('[PATCH /api/teacher/availability/[id]] superseded row delete failed:', supersededError)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }
  }

  // One insert: the moved row plus every remainder fragment, so they land
  // together or not at all. The moved row carries the TARGET row's own
  // is_available - a move changes when a block sits, never what it means - and
  // day_of_week/start_time/end_time stay null (those three belong to weekly
  // 'general' rows).
  const rowsToInsert = [
    {
      teacher_id: record.teacher_id,
      type: 'specific',
      day_of_week: null,
      start_time: null,
      end_time: null,
      start_at,
      end_at,
      is_available: record.is_available,
      source: 'manual',
    },
    ...remainders.map((r) => ({
      teacher_id: record.teacher_id,
      type: 'specific',
      day_of_week: null,
      start_time: null,
      end_time: null,
      start_at: r.start_at,
      end_at: r.end_at,
      is_available: r.is_available,
      source: 'manual',
    })),
  ]

  const { data: inserted, error: insertError } = await admin
    .from('availability')
    .insert(rowsToInsert)
    .select('id, teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available, source')

  if (insertError) {
    console.error('[PATCH /api/teacher/availability/[id]] move insert failed:', insertError)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
  if (!inserted || inserted.length === 0) {
    console.error('[PATCH /api/teacher/availability/[id]] move insert returned no rows')
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  // Same identification as POST: the moved row is the only inserted row holding
  // exactly the requested range, because every remainder lies strictly outside
  // it by construction. Matched on parsed instants rather than string equality
  // because PostgREST returns timestamptz with a '+00:00' offset, not the 'Z'
  // the request sent.
  const moved = inserted.find(
    (r: { start_at: string; end_at: string }) =>
      Date.parse(r.start_at) === newStartMs && Date.parse(r.end_at) === newEndMs
  )

  if (!moved) {
    // Unreachable in practice, and deliberately checked BEFORE the original is
    // removed: bailing here leaves the old block in place, so the calendar
    // still shows something truthful.
    console.error('[PATCH /api/teacher/availability/[id]] inserted rows did not contain the requested range')
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  // Only now is the original removed. Same defence-in-depth filters; the id
  // filter is the one that actually selects it.
  const { error: originalDeleteError } = await admin
    .from('availability')
    .delete()
    .eq('teacher_id', record.teacher_id)
    .eq('type', 'specific')
    .eq('source', 'manual')
    .eq('id', id)

  if (originalDeleteError) {
    // The move itself landed; only the cleanup of the old position failed. 500
    // is still the right answer - the client must not be told the original is
    // gone - and the leftover duplicate is the safe partial outcome above.
    console.error('[PATCH /api/teacher/availability/[id]] original row delete failed:', originalDeleteError)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  revalidatePath('/schedule')
  // The same envelope POST's specific branch returns, so the response parsing
  // already in DayToDay's commit handler applies unchanged: removed_ids carries
  // the superseded rows AND the original id, added carries the remainder
  // fragments, data is the moved row.
  return NextResponse.json({
    data: moved,
    removed_ids: [...deleteIds, id],
    added: inserted.filter((r: unknown) => r !== moved),
  })
}
