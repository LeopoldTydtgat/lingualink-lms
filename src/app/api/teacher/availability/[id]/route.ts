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
    .select('teacher_id')
    .eq('id', id)
    .maybeSingle()

  if (fetchError) {
    console.error('[DELETE /api/teacher/availability/[id]] fetch', fetchError)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
