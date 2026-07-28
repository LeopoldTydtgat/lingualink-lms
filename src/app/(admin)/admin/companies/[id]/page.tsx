import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import CompanyDetailClient from './CompanyDetailClient'

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  const { id } = await params
  const supabase = createAdminClient()

  const { data: company, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !company) notFound()

  // Fetch students belonging to this company with their active training hours
  // cancellation_policy is included here — admin-only view of company billing terms
  const { data: students } = await supabase
    .from('students')
    .select(`
      id,
      full_name,
      email,
      status,
      cancellation_policy,
      trainings (
        id,
        total_hours,
        hours_consumed,
        status,
        end_date,
        created_at
      ),
      training_teachers (
        profiles:teacher_id (
          full_name
        )
      )
    `)
    .eq('company_id', id)
    .order('full_name')

  // Flatten students — get active training hours remaining + teacher names
  const flatStudents = (students ?? []).map((s) => {
    // Deterministic pick - newest first, then prefer 'active' (same fix as
    // students/[id]/page.tsx; display-only here).
    const trainingsArr = (Array.isArray(s.trainings) ? s.trainings : [])
      .slice()
      .sort((a, b) => ((b.created_at ?? '') as string).localeCompare((a.created_at ?? '') as string))
    const active = trainingsArr.find((t) => t.status === 'active') ?? trainingsArr[0] ?? null
    const hoursRemaining = active
      ? Number(active.total_hours) - Number(active.hours_consumed)
      : null

    const ttArr = Array.isArray(s.training_teachers) ? s.training_teachers : []
    const teacherNames = ttArr
      .map((tt) => {
        const p = Array.isArray(tt.profiles) ? tt.profiles[0] : tt.profiles
        return p?.full_name ?? null
      })
      .filter(Boolean)

    return {
      id: s.id,
      full_name: s.full_name,
      email: s.email,
      status: s.status,
      cancellation_policy: s.cancellation_policy,
      hours_remaining: hoursRemaining,
      end_date: active?.end_date ?? null,
      teacher_names: teacherNames as string[],
    }
  })

  return (
    <CompanyDetailClient
      company={company}
      students={flatStudents}
    />
  )
}
