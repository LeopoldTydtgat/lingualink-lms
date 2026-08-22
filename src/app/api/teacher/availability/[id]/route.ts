import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'

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
