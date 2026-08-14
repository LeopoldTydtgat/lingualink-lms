import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { isTeacherProfile } from '@/lib/auth/isTeacherProfile'
import { UpdateTeacherSchema } from '@/lib/validation/schemas'
import { getMonthKeyInTz } from '@/lib/billing/monthRange'

// ─── PATCH — update teacher profile ──────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const parsed = UpdateTeacherSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request data.', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminClient = createAdminClient()

    const { data: current, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, timezone, account_types, status, role, teacher_type, contract_start, orientation_date, observed_lesson_date, date_of_birth, follow_up_date, title, gender, nationality, phone, street_address, area_code, city, paypal_email, iban, bic, vat_required, tax_number, hourly_rate, currency, native_languages, teaching_languages, qualifications, specialties, bio, quote, admin_notes, follow_up_reason, preferred_payment_type')
      .eq('id', id)
      .maybeSingle<Record<string, unknown>>()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    // Only profiles the Teachers section manages may be modified here, under
    // THE canonical teacher rule (src/lib/auth/isTeacherProfile.ts) that the
    // list page and the teachers list API now apply too: account_types overlaps
    // ['teacher','teacher_exam'] OR role 'admin' (so the admin account stays
    // editable). Anything else is
    // off-limits - this route must not be usable against arbitrary profile rows.
    if (!isTeacherProfile(current)) {
      return NextResponse.json({ error: 'Target user is not a teacher.' }, { status: 403 })
    }

    // Self-target guard: an admin must never archive/ban/demote their own
    // account — a status change bans the auth user, locking the admin out.
    // Benign self-edits (bio, timezone, …) stay allowed; only a CHANGE to
    // status or account_types on your own profile is rejected. (role is no
    // longer accepted by UpdateTeacherSchema at all, so it cannot change here.)
    if (id === user.id) {
      const guarded = ['status', 'account_types'] as const
      const selfDemotion = guarded.some(
        (key) =>
          key in parsed.data &&
          JSON.stringify(parsed.data[key]) !== JSON.stringify(current[key])
      )
      if (selfDemotion) {
        return NextResponse.json(
          { error: 'You cannot change your own status, role, or account types. Ask another admin.' },
          { status: 403 }
        )
      }
    }

    // Reprice not-yet-taught lessons when the hourly rate changes.
    //
    // lesson_rate_snapshots is maintained by trg_snapshot_lesson_rate, which
    // fires only on lessons INSERT and on UPDATE OF teacher_id. Nothing fires on
    // a profiles.hourly_rate change, so before this block a raise or a cut never
    // reached lessons that were already booked - they billed at the old rate
    // forever. Every pay surface reads the snapshot (NEW268 D1), so the stale
    // snapshot WAS the stale amount the client reported.
    //
    // Scope is deliberately narrow: status 'scheduled' AND scheduled_at in the
    // future. A past lesson still sitting at 'scheduled' (delivered, awaiting its
    // report) was taught at the old rate and must keep it - which is why the
    // status filter alone would be wrong.
    //
    // Paid months are excluded: a paid invoice freezes its amount by design, so
    // repricing a lesson inside one would leave the invoice header disagreeing
    // with its own itemised detail. Skipping keeps "paid is frozen" true
    // everywhere.
    //
    // WHY THIS RUNS BEFORE THE PROFILE UPDATE. Every failure path here returns
    // before profiles is touched, so a failed reprice leaves the rate unchanged
    // and the admin's retry is a real retry. If this ran after the update, the
    // stored rate would already equal the requested rate, rateChanged would be
    // false on the retry, and the reprice could never be re-attempted - the
    // lessons would stay stale with no way back short of editing the rate twice.
    // The one surviving inconsistency is the reverse order (snapshots written,
    // then the profiles UPDATE below fails): the rate stays old while future
    // lessons hold the new one. That state self-heals, because the retry sees
    // rateChanged still true and the upsert is idempotent.
    //
    // No invoice recompute is triggered here. The teacher widget, right panel and
    // admin billing all price per lesson from the snapshot, so they correct as
    // soon as this lands; invoices.amount_eur is recomputed on every billing page
    // GET already. Calling recompute here would add a failure path for a value
    // that self-corrects.
    const rateChanged =
      'hourly_rate' in parsed.data &&
      Number(parsed.data.hourly_rate ?? 0) !== Number(current.hourly_rate ?? 0)

    // A null rate (the schema permits clearing it) is NOT repriced. Writing null
    // snapshots would blank the pay rate on already-booked future lessons, and
    // the null would then be read as "no usable snapshot" (lessonRates Decision
    // A), silently falling every one of them back to a live rate that is also
    // null, i.e. zero. Leaving the existing snapshots intact is the fail-safe
    // direction. The rate itself still saves.
    const newRate = parsed.data.hourly_rate
    if (rateChanged && newRate == null) {
      console.error('[rate reprice] hourly_rate cleared to null; future lessons keep their existing snapshots', {
        teacher_id: id,
      })
    }

    if (rateChanged && newRate != null) {
      // The timezone may be changing in this same request; the incoming value wins.
      const tz = ('timezone' in parsed.data ? parsed.data.timezone : current.timezone) as
        | string
        | null

      if (!tz) {
        // Without a timezone the paid-month buckets cannot be derived, so a
        // lesson cannot be proven to sit outside a paid month. Fail closed rather
        // than reprice blind. Nothing has been written at this point.
        console.error('[rate reprice] teacher has no timezone; nothing changed', { teacher_id: id })
        return NextResponse.json(
          {
            error:
              'This teacher has no timezone set, so future classes cannot be repriced. Set a timezone first, then change the rate.',
          },
          { status: 422 }
        )
      }

      const nowIso = new Date().toISOString()

      const [futureLessonsRes, paidInvoicesRes] = await Promise.all([
        adminClient
          .from('lessons')
          .select('id, scheduled_at')
          .eq('teacher_id', id)
          .eq('status', 'scheduled')
          .gt('scheduled_at', nowIso),
        adminClient
          .from('invoices')
          .select('billing_month')
          .eq('teacher_id', id)
          .eq('status', 'paid'),
      ])

      // Fail closed on either read. An errored query yields an empty array, which
      // reads as "no future lessons" (reprice nothing) or "no paid months"
      // (reprice into a frozen invoice). Both are silently wrong, so neither is
      // allowed to proceed. Nothing has been written at this point.
      if (futureLessonsRes.error || paidInvoicesRes.error) {
        console.error('[rate reprice] preflight read failed; nothing changed', {
          teacher_id: id,
          lessons_error: futureLessonsRes.error,
          invoices_error: paidInvoicesRes.error,
        })
        return NextResponse.json(
          { error: 'Could not reprice this teacher\'s future classes. Nothing was saved - please try again.' },
          { status: 500 }
        )
      }

      const paidMonths = new Set(
        (paidInvoicesRes.data ?? []).map((inv) => inv.billing_month as string)
      )

      const repriceable = (futureLessonsRes.data ?? []).filter(
        (l) => !paidMonths.has(getMonthKeyInTz(new Date(l.scheduled_at as string), tz))
      )

      if (repriceable.length > 0) {
        // Upsert, not update: a future lesson missing its snapshot row gets one
        // here rather than being skipped. captured_at is stamped to match the
        // trigger's own ON CONFLICT behaviour.
        const { error: snapshotError } = await adminClient
          .from('lesson_rate_snapshots')
          .upsert(
            repriceable.map((l) => ({
              lesson_id: l.id,
              hourly_rate: newRate,
              captured_at: nowIso,
            })),
            { onConflict: 'lesson_id' }
          )

        if (snapshotError) {
          console.error('[rate reprice] snapshot upsert failed; nothing changed', {
            teacher_id: id,
            lesson_count: repriceable.length,
            error: snapshotError,
          })
          return NextResponse.json(
            { error: 'Could not reprice this teacher\'s future classes. Nothing was saved - please try again.' },
            { status: 500 }
          )
        }
      }
    }

    // Build the payload from ONLY the fields present in the request. The
    // schema is all-optional, so a partial request (e.g. Archive sending just
    // { status }) must never touch the other columns — defaulting absent
    // fields to null wipes the rest of the profile. Zod 4 omits absent
    // optional keys from parsed.data and keeps explicit nulls, so `in` is the
    // correct presence check: absent → not written, null → cleared. The
    // explicit field list also keeps unknown keys away from PostgREST — a
    // single unrecognised column aborts the entire update.
    const UPDATABLE_FIELDS = [
      'full_name', 'timezone', 'account_types', 'status', 'teacher_type',
      'contract_start', 'orientation_date', 'observed_lesson_date', 'title',
      'date_of_birth', 'gender', 'nationality', 'phone', 'street_address',
      'area_code', 'city', 'preferred_payment_type', 'paypal_email', 'iban',
      'bic', 'vat_required', 'tax_number', 'hourly_rate', 'currency',
      'native_languages', 'teaching_languages', 'qualifications', 'specialties',
      'bio', 'quote', 'admin_notes', 'follow_up_date', 'follow_up_reason',
    ] as const

    const updatePayload: Record<string, unknown> = {}
    for (const key of UPDATABLE_FIELDS) {
      if (key in parsed.data) updatePayload[key] = parsed.data[key]
    }
    updatePayload.updated_at = new Date().toISOString()

    // History entries derive from the SAME field set being written above —
    // log exactly what changes, nothing more. admin_notes never enters the log.
    const SKIP_FIELDS = [
      'admin_notes',
      'updated_at',
      'created_at',
    ]
    const historyEntries = Object.entries(updatePayload)
      .filter(([key]) => !SKIP_FIELDS.includes(key))
      .filter(([key, newVal]) => {
        const oldVal = current[key]
        return JSON.stringify(oldVal) !== JSON.stringify(newVal)
      })
      .map(([key, newVal]) => ({
        teacher_id: id,
        field_name: key,
        old_value: current[key] != null ? String(current[key]) : null,
        new_value: newVal != null ? String(newVal) : null,
        changed_by: user.id,
        changed_at: new Date().toISOString(),
      }))

    const { error: updateError } = await adminClient
      .from('profiles')
      .update(updatePayload)
      .eq('id', id)

    if (updateError) {
      console.error('Profile update error:', JSON.stringify(updateError, null, 2))
      return NextResponse.json(
        { error: updateError.message || 'Failed to update teacher.' },
        { status: 500 }
      )
    }

    if (historyEntries.length > 0) {
      const { error: historyError } = await adminClient
        .from('teacher_history_log')
        .insert(historyEntries)

      if (historyError) {
        console.error('History log error:', historyError)
      }
    }

    if (parsed.data.status === 'former' || parsed.data.status === 'on_hold') {
      // Archiving must remove ALL access, not just current sessions. signOut
      // alone leaves the password valid, so a former teacher could log straight
      // back in. Ban the auth user first (locks login), then kill live sessions
      // — so sessions die only after the login is already locked. The ban is
      // lifted again when status returns to 'current' below.
      try {
        await adminClient.auth.admin.updateUserById(id, { ban_duration: '876000h' })
      } catch (banError) {
        // The ban is the security-critical half: if it throws, the login is NOT
        // locked. Hard-fail with 500 rather than returning success — otherwise we
        // re-open the exact hole this block closes (a former teacher logging back
        // in). The admin retries; the profile is already 'former' so re-running is
        // idempotent. signOut below is skipped, but is moot until the ban lands.
        console.error('[archive teacher] ban failed:', banError)
        return NextResponse.json(
          { error: 'Failed to revoke teacher access. Please retry.' },
          { status: 500 }
        )
      }
      try {
        await adminClient.auth.admin.signOut(id, 'global')
      } catch (signOutError) {
        console.error('[archive teacher] signOut failed:', signOutError)
      }
    } else if (parsed.data.status === 'current') {
      // Reinstating a teacher must restore login by lifting any prior ban.
      try {
        await adminClient.auth.admin.updateUserById(id, { ban_duration: 'none' })
      } catch (unbanError) {
        console.error('[reactivate teacher] unban failed:', unbanError)
      }
    }

    revalidatePath('/account')
    revalidatePath('/upcoming-classes')
    revalidatePath('/dashboard')

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}

// ─── DELETE — purge only if pristine ──────────────────────────────────────────
//
// Teachers with ANY history are archived (status 'former', via PATCH), never
// purged. Purge exists solely for zero-history accounts (test accounts,
// mistaken creations). Preflight counts every referencing table; a single
// referencing row anywhere blocks the purge with a 409.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const user = await requireAdmin()
    if (!user) return NextResponse.json({ error: 'Unauthorised or Forbidden' }, { status: 401 })

    const adminClient = createAdminClient()

    // 1. Verify teacher exists and is 'former'
    const { data: teacher, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, status')
      .eq('id', id)
      .single()

    if (fetchError || !teacher) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    if (teacher.status !== 'former') {
      return NextResponse.json(
        { error: 'Teacher must be archived (status: former) before purging.' },
        { status: 409 }
      )
    }

    // 2. Preflight — exact row counts in every table that references this
    // teacher. The select column is the filtered column itself (never '*') so
    // no column-level REVOKE is ever touched. head:true returns no row data.
    const countBy = (table: string, column: string) =>
      adminClient.from(table).select(column, { count: 'exact', head: true }).eq(column, id)

    // teacher_history_log: only changed_by (this user as ACTOR) blocks;
    // teacher_id rows ABOUT this teacher CASCADE on the profile delete.
    const preflight = [
      { table: 'lessons',                 query: countBy('lessons', 'teacher_id') },
      { table: 'reports',                 query: countBy('reports', 'teacher_id') },
      { table: 'trainings',               query: countBy('trainings', 'teacher_id') },
      { table: 'invoices',                query: countBy('invoices', 'teacher_id') },
      { table: 'reviews',                 query: countBy('reviews', 'teacher_id') },
      { table: 'student_reviews',         query: countBy('student_reviews', 'teacher_id') },
      { table: 'study_sheets',            query: countBy('study_sheets', 'owner_id') },
      { table: 'training_teachers',       query: countBy('training_teachers', 'teacher_id') },
      {
        table: 'messages',
        query: adminClient
          .from('messages')
          .select('sender_id', { count: 'exact', head: true })
          .or(`sender_id.eq.${id},receiver_id.eq.${id}`),
      },
      { table: 'support_messages',        query: countBy('support_messages', 'participant_auth_id') },
      { table: 'assignments',             query: countBy('assignments', 'assigned_by') },
      { table: 'hours_log',               query: countBy('hours_log', 'created_by') },
      { table: 'announcements',           query: countBy('announcements', 'created_by') },
      {
        table: 'admin_tasks',
        query: adminClient
          .from('admin_tasks')
          .select('created_by', { count: 'exact', head: true })
          .or(`created_by.eq.${id},assigned_to.eq.${id}`),
      },
      { table: 'export_log',              query: countBy('export_log', 'exported_by') },
      { table: 'teacher_history_log',     query: countBy('teacher_history_log', 'changed_by') },
      { table: 'students',                query: countBy('students', 'academic_advisor_id') },
      { table: 'lesson_join_clicks',      query: countBy('lesson_join_clicks', 'user_id') },
      { table: 'user_action_attempts',    query: countBy('user_action_attempts', 'user_id') },
      { table: 'announcement_dismissals', query: countBy('announcement_dismissals', 'user_id') },
      { table: 'activity_attempts',       query: countBy('activity_attempts', 'reviewed_by') },
    ]

    const results = await Promise.all(preflight.map((p) => p.query))

    const blocking: { table: string; count: number }[] = []
    for (let i = 0; i < results.length; i++) {
      const { count, error } = results[i]
      // Fail closed: an errored (or null) count is unknown, never zero.
      if (error || count === null) {
        console.error(
          `[purge teacher] preflight count failed for ${preflight[i].table}:`,
          error
        )
        return NextResponse.json(
          { error: 'Failed to verify teacher history. Purge aborted; nothing was deleted.' },
          { status: 500 }
        )
      }
      if (count > 0) blocking.push({ table: preflight[i].table, count })
    }

    if (blocking.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot purge: this teacher has history. Archive instead.',
          blocking,
        },
        { status: 409 }
      )
    }

    // 3. Purge - the account is pristine. DB CASCADEs on the profile delete
    // handle availability, availability_overrides, availability_templates,
    // teacher_history_log.teacher_id, and whats_new_dismissals; nothing else
    // references this user. study_sheets.owner_id rows are blocked by the
    // preflight above, so none exist at purge time;
    // activity_attempts.reviewed_by is likewise blocked by the preflight above.

    // 3a. Kill every live session first. Non-fatal: on a retry after a partial
    // failure the auth user may already be gone, which makes this throw.
    try {
      await adminClient.auth.admin.signOut(id, 'global')
    } catch (signOutError) {
      console.error('[purge teacher] signOut failed (non-fatal):', signOutError)
    }

    // 3b. Delete the auth user. Tolerate ONLY user-not-found so a retry after
    // a partial failure (auth gone, profile row left) is idempotent; any other
    // error aborts with the profile row untouched.
    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(id)
    if (authDeleteError) {
      const isUserNotFound =
        authDeleteError.status === 404 || authDeleteError.code === 'user_not_found'
      if (!isUserNotFound) {
        console.error('[purge teacher] auth user delete failed:', authDeleteError)
        return NextResponse.json(
          { error: 'Failed to delete the login account. Purge aborted; nothing was deleted.' },
          { status: 500 }
        )
      }
    }

    // 3c. Delete the profile row (CASCADEs fire here).
    const { error: profileDeleteError } = await adminClient
      .from('profiles')
      .delete()
      .eq('id', id)

    if (profileDeleteError) {
      console.error('[purge teacher] profile delete failed:', profileDeleteError)
      return NextResponse.json(
        {
          error:
            'The login account was deleted but the profile row could not be removed. Retry the purge to finish cleanup.',
        },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
