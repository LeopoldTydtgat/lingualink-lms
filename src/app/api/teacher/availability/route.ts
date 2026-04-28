import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available } = body

  if (teacher_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('availability')
    .upsert(
      { teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available },
      { onConflict: 'teacher_id,day_of_week,start_time,end_time', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle()

  if (error) {
    console.error('[POST /api/teacher/availability]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  revalidatePath('/schedule')
  return NextResponse.json(data)
}
