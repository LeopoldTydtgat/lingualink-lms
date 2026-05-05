import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

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
    .single()

  if (fetchError || !record) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (record.teacher_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { error } = await admin.from('availability').delete().eq('id', id)

  if (error) {
    console.error('[DELETE /api/teacher/availability/[id]]', error)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  revalidatePath('/schedule')
  return NextResponse.json({ success: true })
}
