import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TeacherAvailabilitySchema } from '@/lib/validation/schemas'

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

  if (teacher_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admin = createAdminClient()
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
