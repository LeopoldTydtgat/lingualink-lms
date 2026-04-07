import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import StudentsListClient from './StudentsListClient'

export default async function StudentsPage() {
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
      companies (
        id,
        name
      ),
      trainings (
        id,
        total_hours,
        hours_consumed,
        status,
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

  // Flatten nested Supabase arrays and compute derived values
  const studentsFlattened = (students || []).map((s) => {
    // Flatten company (Supabase returns joins as arrays)
    const company = Array.isArray(s.companies) ? s.companies[0] : s.companies

    // Find the active training — fall back to the most recent if none is active
    const trainingsArr = Array.isArray(s.trainings) ? s.trainings : []
    const activeTrain = trainingsArr.find((t) => t.status === 'active') ?? trainingsArr[0] ?? null

    // Compute hours remaining from the active training
    const hoursRemaining = activeTrain
      ? Number(activeTrain.total_hours) - Number(activeTrain.hours_consumed)
      : null

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
      hours_remaining: hoursRemaining,
      teachers,
    }
  })

  return <StudentsListClient students={studentsFlattened} />
}
