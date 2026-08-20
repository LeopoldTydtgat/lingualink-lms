import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import StudentsListClient from './StudentsListClient'

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  // Stat-card deep link (/admin/students?filter=low_hours) seeds the Low Hours
  // toggle. Any other value leaves the toggle off.
  const { filter } = await searchParams
  const initialLowHoursOnly = filter === 'low_hours'

  // Service-role client, matching students/[id]/page.tsx. The admin gate above
  // has already run; RLS is not what authorises this page.
  const supabase = createAdminClient()

  // Fetch all students with their company, active training, and assigned teachers
  const { data: students, error } = await supabase
    .from('students')
    .select(`
      id,
      full_name,
      email,
      photo_url,
      status,
      is_private,
      company_id,
      email_bounced_at,
      email_bounce_reason,
      companies (
        id,
        name
      ),
      trainings (
        id,
        total_hours,
        hours_consumed,
        status,
        created_at,
        training_teachers (
          teacher_id,
          profiles:teacher_id (
            id,
            full_name
          )
        )
      )
    `)
    .order('full_name', { ascending: true })

  if (error) {
    console.error('Error fetching students:', error)
  }

  // A failed read must not render as an empty list — the client shows an error
  // state instead of "No students yet."
  const loadError = Boolean(error)

  // Flatten nested Supabase arrays and compute derived values
  const studentsFlattened = (students || []).map((s) => {
    // Flatten company (Supabase returns joins as arrays)
    const company = Array.isArray(s.companies) ? s.companies[0] : s.companies

    // Find the active training — fall back to the most recent if none is active
    // Deterministic pick - newest first, then prefer 'active' (same fix as
    // students/[id]/page.tsx; display-only here).
    const trainingsArr = (Array.isArray(s.trainings) ? s.trainings : [])
      .slice()
      .sort((a, b) => ((b.created_at ?? '') as string).localeCompare((a.created_at ?? '') as string))
    const activeTrain = trainingsArr.find((t) => t.status === 'active') ?? trainingsArr[0] ?? null

    // Compute hours remaining from the active training
    const hoursRemaining = activeTrain
      ? Number(activeTrain.total_hours) - Number(activeTrain.hours_consumed)
      : null

    // Package size, so the list can show remaining hours against the total.
    const totalHours = activeTrain ? Number(activeTrain.total_hours) : null

    // Collect assigned teachers from training_teachers join rows
    const teachers: { id: string; full_name: string }[] = []
    if (activeTrain) {
      const ttArr = Array.isArray(activeTrain.training_teachers)
        ? activeTrain.training_teachers
        : []
      for (const tt of ttArr) {
        // profiles join also comes back as array
        const profile = Array.isArray(tt.profiles) ? tt.profiles[0] : tt.profiles
        if (profile?.id && profile?.full_name) {
          // Avoid duplicates
          if (!teachers.find((t) => t.id === profile.id)) {
            teachers.push({ id: profile.id, full_name: profile.full_name })
          }
        }
      }
    }

    return {
      id: s.id,
      full_name: s.full_name,
      email: s.email,
      photo_url: s.photo_url ?? null,
      status: s.status ?? null,
      is_private: s.is_private ?? true,
      company_id: s.company_id ?? null,
      company_name: company?.name ?? null,
      email_bounced_at: s.email_bounced_at ?? null,
      email_bounce_reason: s.email_bounce_reason ?? null,
      hours_remaining: hoursRemaining,
      total_hours: totalHours,
      teachers,
    }
  })

  return (
    <StudentsListClient
      students={studentsFlattened}
      initialLowHoursOnly={initialLowHoursOnly}
      loadError={loadError}
    />
  )
}
