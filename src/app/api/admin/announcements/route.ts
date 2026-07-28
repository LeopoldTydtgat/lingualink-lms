import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import {
  CreateAnnouncementSchema,
  audienceNeedsTarget,
} from '@/lib/validation/announcements'

// ─── POST — create an announcement ────────────────────────────────────────────
//
// The admin Announcements UI used to insert straight from the browser with the
// anon client, leaving RLS as the only gate and the payload unvalidated. Every
// write now lands here: requireAdmin first, Zod second, service-role client third.

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // A body that is not JSON at all must fail validation, not throw.
    const body = await req.json().catch(() => null)

    const parsed = CreateAnnouncementSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? 'Invalid announcement data.',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      )
    }
    const data = parsed.data

    const adminClient = createAdminClient()

    const { data: created, error } = await adminClient
      .from('announcements')
      .insert({
        title: data.title,
        message: data.message,
        target_audience: data.target_audience,
        // A person-scoped id is meaningless for a broadcast audience; never let
        // a leftover selection persist next to 'everyone'/'all_*'.
        target_id: audienceNeedsTarget(data.target_audience)
          ? data.target_id ?? null
          : null,
        is_dismissable: data.is_dismissable,
        is_active: data.is_active,
        start_date: data.start_date ?? null,
        end_date: data.end_date ?? null,
        // Authorship comes from the verified session, never from the request
        // body — the browser no longer decides who created a row.
        created_by: user.id,
      })
      .select('id')
      .single()

    if (error || !created) {
      console.error('[admin announcements] create failed:', error)
      return NextResponse.json(
        { error: 'Could not create the announcement.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, id: created.id }, { status: 201 })
  } catch (err) {
    // requireAdmin throws when the profiles lookup itself fails — that says
    // nothing about the caller's role, so it fails closed here rather than
    // reaching the write.
    console.error('[admin announcements] POST error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
