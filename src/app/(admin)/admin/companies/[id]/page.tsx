import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import CompanyDetailClient from './CompanyDetailClient'

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    }
  )

  const { data: company, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !company) notFound()

  // Fetch students belonging to this company with their active training hours
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
        end_date
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
    const trainingsArr = Array.isArray(s.trainings) ? s.trainings : []
    const active = trainingsArr.find((t) => t.status === 'active') ?? trainingsArr[0] ?? null
    const hoursRemaining = active
      ? Number(active.total_hours) - Number(active.hours_consumed)
      : null

    // Get assigned teacher names via training_teachers
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
