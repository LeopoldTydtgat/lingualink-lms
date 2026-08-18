import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TeacherAvailabilitySchema } from '@/lib/validation/schemas'
import { requireAdmin } from '@/lib/auth/requireAdmin'

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
