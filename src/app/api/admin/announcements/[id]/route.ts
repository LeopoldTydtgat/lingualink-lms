import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import {
  UpdateAnnouncementSchema,
  audienceNeedsTarget,
} from '@/lib/validation/announcements'

const idParam = z.string().uuid()

// The columns this route may write. An unknown key would abort the whole
// PostgREST update, and the list keeps created_by/created_at out of reach —
// editing an announcement must never reassign its authorship.
const UPDATABLE_FIELDS = [
  'title',
  'message',
  'target_audience',
  'target_id',
  'is_dismissable',
  'is_active',
  'start_date',
  'end_date',
] as const

// ─── PATCH — edit an announcement, or flip is_active ──────────────────────────
//
// Serves both the full edit form and the list page's activate/deactivate toggle.
// Only the fields present in the request are written: a { is_active } toggle must
// not blank out the message, targeting, or dates.
//
// Reactivating clears dismissals: reusing an announcement means it is brand new
// for everyone, so an inactive → active flip wipes announcement_dismissals for
// that announcement and every user sees the banner again.

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!idParam.safeParse(id).success) {
      return NextResponse.json({ error: 'Announcement not found.' }, { status: 404 })
    }

    const body = await req.json().catch(() => null)

    const parsed = UpdateAnnouncementSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? 'Invalid announcement data.',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      )
    }

    // Zod 4 omits absent optional keys and keeps explicit nulls, so `in` is the
    // correct presence check: absent → not written, null → cleared.
    const updatePayload: Record<string, unknown> = {}
    for (const key of UPDATABLE_FIELDS) {
      if (key in parsed.data && parsed.data[key] !== undefined) {
        updatePayload[key] = parsed.data[key]
      }
    }

    // Same rule as create: a broadcast audience carries no target_id. Applied
    // only when the audience is part of this request — a lone toggle leaves
    // targeting untouched. announcements has no updated_at column to stamp.
    if (
      parsed.data.target_audience &&
      !audienceNeedsTarget(parsed.data.target_audience)
    ) {
      updatePayload.target_id = null
    }

    const adminClient = createAdminClient()

    // The update itself cannot report what is_active WAS, and the reactivation
    // rule needs exactly that, so the previous value is read first.
    const { data: existing, error: existingError } = await adminClient
      .from('announcements')
      .select('id, is_active')
      .eq('id', id)
      .maybeSingle()

    if (existingError) {
      console.error('[admin announcements] pre-update lookup failed:', id, existingError)
      return NextResponse.json(
        { error: 'Could not save the announcement.' },
        { status: 500 }
      )
    }

    // Confirmed-empty read — the id does not exist. Same answer the post-update
    // zero-rows check gives, just reached before anything is written.
    if (!existing) {
      return NextResponse.json({ error: 'Announcement not found.' }, { status: 404 })
    }

    // Only a genuine not-active → active flip in THIS request clears dismissals.
    // An absent is_active, an active → inactive deactivation, and a no-op
    // active → active save all leave them alone. `!== true` rather than
    // `=== false` so a legacy null counts as "was off": both portals select on
    // .eq('is_active', true), so a null row was never on screen either.
    const isReactivation =
      updatePayload.is_active === true && existing.is_active !== true

    const { data: updated, error } = await adminClient
      .from('announcements')
      .update(updatePayload)
      .eq('id', id)
      .select('id')

    if (error) {
      console.error('[admin announcements] update failed:', id, error)
      return NextResponse.json(
        { error: 'Could not save the announcement.' },
        { status: 500 }
      )
    }

    // Zero affected rows means the id does not exist. Returning success here
    // would tell the admin their change landed when nothing was written.
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'Announcement not found.' }, { status: 404 })
    }

    // Runs only after the update is confirmed written — clearing dismissals for
    // a save that failed would un-dismiss a banner nobody reactivated.
    if (isReactivation) {
      const { error: clearError } = await adminClient
        .from('announcement_dismissals')
        .delete()
        .eq('announcement_id', id)

      // The announcement IS active now, so the save is not rolled back or
      // reported as failed. The warning rides along so the partial outcome is
      // not silent: users who dismissed the earlier run will not see it again.
      if (clearError) {
        console.error('[admin announcements] dismissal clear failed:', id, clearError)
        return NextResponse.json({
          success: true,
          warning:
            'The announcement was activated, but earlier dismissals could not be cleared — users who dismissed it before will not see it again.',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[admin announcements] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}

// ─── DELETE — remove an announcement ──────────────────────────────────────────
//
// announcement_dismissals.announcement_id is ON DELETE CASCADE, so the per-user
// dismissal rows go with it. Nothing else references an announcement.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!idParam.safeParse(id).success) {
      return NextResponse.json({ error: 'Announcement not found.' }, { status: 404 })
    }

    const adminClient = createAdminClient()

    const { data: deleted, error } = await adminClient
      .from('announcements')
      .delete()
      .eq('id', id)
      .select('id')

    if (error) {
      console.error('[admin announcements] delete failed:', id, error)
      return NextResponse.json(
        { error: 'Could not delete the announcement.' },
        { status: 500 }
      )
    }

    if (!deleted || deleted.length === 0) {
      return NextResponse.json({ error: 'Announcement not found.' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[admin announcements] DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
