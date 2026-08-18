import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import TeacherScheduleAdminClient from './TeacherScheduleAdminClient'
import type { AvailabilityRecord } from '@/app/(dashboard)/schedule/ScheduleClient'

// Admin mirror of the teacher Schedule page. The (admin) layout gates on
// requireStaff, which is weaker than this page needs: every RLS policy backing
// the calendar (lessons, students, availability) grants is_admin() only, so a
// staff viewer would render an empty grid. Hence the explicit requireAdmin here.
export default async function AdminTeacherSchedulePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  const { id } = await params
  const supabase = createAdminClient()

  const { data: teacher, error: teacherError } = await supabase
    .from('profiles')
    .select('id, full_name, role, timezone, profile_completed')
    .eq('id', id)
    .maybeSingle()

  // A failed read and a genuinely absent teacher are different things and must
  // not collapse into the same message.
  if (teacherError) {
    console.error('[admin teacher schedule] profile read failed:', teacherError)
    return (
      <div className="p-8 text-gray-500">
        Could not load this teacher. Please refresh the page.
      </div>
    )
  }
  if (!teacher) {
    return (
      <div className="p-8 text-gray-500">Teacher not found.</div>
    )
  }

  const { data: availability, error: availabilityError } = await supabase
    .from('availability')
    .select('id, teacher_id, type, day_of_week, start_time, end_time, start_at, end_at, is_available')
    .eq('teacher_id', id)
    .order('start_at', { ascending: true })

  // Fail SAFE and LOUD. Rendering an empty grid on a query error is the
  // dangerous path: it is indistinguishable from "no availability set", and she
  // would add blocks on top of rows that already exist.
  if (availabilityError) {
    console.error('[admin teacher schedule] availability read failed:', availabilityError)
    return (
      <div className="p-8 text-gray-500">
        Could not load this teacher&apos;s availability. Please refresh the page.
      </div>
    )
  }

  // maybeSingle, not single: a missing settings row is a normal state and must
  // not throw. The explicit null check matters because Number(null) is 0, not
  // NaN - a row holding a null value would otherwise become a target of zero.
  const { data: minHoursRow } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'min_available_hours')
    .maybeSingle()
  const parsedMinHours = Number(minHoursRow?.value)
  const minAvailableHours =
    minHoursRow?.value == null || Number.isNaN(parsedMinHours) ? null : parsedMinHours

  return (
    <TeacherScheduleAdminClient
      teacher={{
        id: teacher.id,
        full_name: teacher.full_name,
        role: teacher.role,
        timezone: teacher.timezone,
      }}
      initialAvailability={(availability ?? []) as AvailabilityRecord[]}
      minAvailableHours={minAvailableHours}
      timezoneUnconfirmed={teacher.profile_completed !== true}
    />
  )
}
