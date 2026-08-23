import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TeacherAvailabilitySchema } from '@/lib/validation/schemas'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { reconcileSpecific } from '@/lib/availability/reconcileSpecific'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  const parsed = TeacherAvailabilitySchema.safeParse(body)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return NextResponse.json({ error: firstError.message }, { status: 400 })
  }
  const { teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available } = parsed.data

  // Writing to another teacher's calendar is an admin-only escalation, added so the
  // client can maintain a teacher's schedule on their behalf.
  //
  // requireAdmin() and NOT requireStaff(), even though requireStaff's docstring
  // lists availability as staff scope - that line is aspirational. The live RLS
  // policies on lessons, students and availability grant is_admin() only, with no
  // staff clause, so a staff caller would pass this gate and then read an empty
  // calendar in the browser. The gate and the policies have to widen together.
  //
  // The check runs ONLY on the mismatch branch, so a teacher editing their own
  // calendar costs no extra queries. Same conditional-escalation shape as
  // src/app/api/teacher/material-assignments/[id]/route.ts.
  if (teacher_id !== user.id) {
    try {
      const adminUser = await requireAdmin()
      if (!adminUser) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } catch (err) {
      // requireAdmin throws when the profiles lookup itself fails - that says
      // nothing about the caller's role, so it fails closed here rather than
      // falling through and reading as a deliberate refusal.
      console.error('[POST /api/teacher/availability] admin escalation check failed:', err)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }
  }

  const admin = createAdminClient()

  // ---- Timed 'specific' rows: reconcile before writing ----------------------
  //
  // ONLY this branch is new. type 'general' and type 'holiday' fall through to
  // the original upsert at the bottom and keep their exact request AND response
  // contract (a bare row object), which GeneralAvailability.tsx:290 and
  // Holidays.tsx:95 both read directly.
  //
  // Why 'specific' needs it: the upsert's conflict target is
  // 'teacher_id,day_of_week,start_time,end_time' and all three of those columns
  // are NULL on a specific row, so under a plain UNIQUE the conflict arm is
  // unreachable and every drag inserted another row. Overlapping duplicates then
  // stack invisibly - see the header of src/lib/availability/reconcileSpecific.ts.
  //
  // The guard is deliberately narrow. A 'specific' row with a missing or
  // inverted range cannot be reconciled (there is no window to compare against)
  // and falls through to the original path, byte-identical to today. No UI
  // produces that shape - DayToDay always sends a forward range - and such a row
  // is inert in every reader anyway (expandSpecificBlocks, slotEngine's
  // overrideRecords and isSlotAvailable all require both instants).
  if (type === 'specific' && start_at && end_at) {
    const newStartMs = Date.parse(start_at)
    const newEndMs = Date.parse(end_at)

    if (Number.isFinite(newStartMs) && Number.isFinite(newEndMs) && newEndMs > newStartMs) {
      // (a) Candidates: this teacher's MANUAL timed rows overlapping the new range.
      //
      // source='manual' is load-bearing, not cosmetic. google_sync rows are owned
      // by the busy-sync cron, which writes them directly with the admin client
      // and generationally replaces its own rows each run; the DELETE route
      // refuses them outright. Excluding them HERE is what guarantees they can
      // never be trimmed or deleted below - the delete only ever receives ids
      // this query returned. type='specific' likewise keeps 'holiday' rows out:
      // those are whole calendar-date spans and are reconciled by nothing.
      //
      // Half-open overlap, strict on both bounds, so a row that merely touches
      // the new range at an endpoint is not a candidate. This mirrors
      // reconcileSpecific's comparisons exactly; the two must stay in step.
      const { data: candidates, error: candidatesError } = await admin
        .from('availability')
        .select('id, start_at, end_at, is_available')
        .eq('teacher_id', teacher_id)
        .eq('type', 'specific')
        .eq('source', 'manual')
        .lt('start_at', end_at)
        .gt('end_at', start_at)

      if (candidatesError) {
        console.error('[POST /api/teacher/availability] specific overlap lookup failed:', candidatesError)
        return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
      }

      const { deleteIds, remainders } = reconcileSpecific(
        { startMs: newStartMs, endMs: newEndMs, isAvailable: is_available },
        candidates ?? []
      )

      // (b) Remove the rows the new range supersedes.
      //
      // NON-ATOMIC WINDOW, ACKNOWLEDGED AND ACCEPTED: select -> delete -> insert
      // are three separate PostgREST round trips with no transaction across
      // them. A failure after the delete but before the insert leaves a GAP
      // where the old rows were. That is the fail-safe direction: a lost
      // 'available' row means the slot simply stops being bookable (an unbooked
      // slot beats a double booking), and a lost 'unavailable' row is one the
      // teacher redraws, having just seen the save fail. google_sync rows are
      // excluded from every step above and below, so the cron's generational
      // replace can never be corrupted from here. The insert in (c) is a SINGLE
      // statement, so the remainders and the new row land together or not at all.
      if (deleteIds.length > 0) {
        // The teacher/type/source filters are defence in depth only - the ids
        // came from the query above, which was already scoped this way - and are
        // kept so no future edit can widen the delete by widening the select.
        const { error: deleteError } = await admin
          .from('availability')
          .delete()
          .eq('teacher_id', teacher_id)
          .eq('type', 'specific')
          .eq('source', 'manual')
          .in('id', deleteIds)

        if (deleteError) {
          console.error('[POST /api/teacher/availability] superseded row delete failed:', deleteError)
          return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
        }
      }

      // (c) One insert: the new row plus every remainder fragment. Plain
      // .insert(), not the upsert below - the conflict target is all-NULL for
      // these rows so it could never fire, and an INSERT states the intent
      // plainly. day_of_week/start_time/end_time stay null (those three belong
      // to weekly 'general' rows) and source is written explicitly as 'manual',
      // matching the column's NOT NULL default and its
      // availability_source_check.
      const rowsToInsert = [
        {
          teacher_id,
          type,
          day_of_week: null,
          start_time: null,
          end_time: null,
          start_at,
          end_at,
          is_available,
          source: 'manual',
        },
        ...remainders.map((r) => ({
          teacher_id,
          type,
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
        console.error('[POST /api/teacher/availability] specific insert failed:', insertError)
        return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
      }
      if (!inserted || inserted.length === 0) {
        console.error('[POST /api/teacher/availability] specific insert returned no rows')
        return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
      }

      // The new row is the ONLY inserted row carrying exactly the requested
      // range: every remainder lies strictly outside [start, end) by
      // construction, so none of them can hold both bounds. Matched on parsed
      // instants rather than string equality because PostgREST returns
      // timestamptz with a '+00:00' offset, not the 'Z' the request sent.
      const created = inserted.find(
        (r: { start_at: string; end_at: string }) =>
          Date.parse(r.start_at) === newStartMs && Date.parse(r.end_at) === newEndMs
      )

      if (!created) {
        // Unreachable in practice. Failing closed is still correct: the rows ARE
        // written, the client keeps its pre-drag state and shows an error, and
        // either the next focus refresh or a retry (which reconciles the row we
        // just wrote) converges on the truth. Returning a wrong row would not.
        console.error('[POST /api/teacher/availability] inserted rows did not contain the requested range')
        return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
      }

      revalidatePath('/schedule')
      // Specific-branch response shape. The client applies all three parts in
      // one state update; DayToDay also still accepts the bare-row shape below.
      return NextResponse.json({
        data: created,
        removed_ids: deleteIds,
        added: inserted.filter((r: unknown) => r !== created),
      })
    }
  }

  // ---- Weekly 'general' and 'holiday' rows: unchanged -----------------------
  const { data, error } = await admin
    .from('availability')
    .upsert(
      { teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available },
      { onConflict: 'teacher_id,day_of_week,start_time,end_time' }
    )
    .select('id, teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .maybeSingle()

  if (error) {
    console.error('[POST /api/teacher/availability]', error)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  if (!data) {
    console.error('[POST /api/teacher/availability] upsert returned no row')
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  revalidatePath('/schedule')
  return NextResponse.json(data)
}
