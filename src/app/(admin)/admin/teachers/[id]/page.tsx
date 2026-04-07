import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import TeacherDetailClient from './TeacherDetailClient'

export default async function TeacherDetailPage({
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

  // Fetch teacher profile
  const { data: teacher, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !teacher) notFound()

  // Fetch teacher's classes (most recent 50)
  const { data: lessons } = await supabase
    .from('lessons')
    .select(`
      id,
      scheduled_at,
      duration_minutes,
      status,
      students (
        full_name
      )
    `)
    .eq('teacher_id', id)
    .order('scheduled_at', { ascending: false })
    .limit(50)

  // Fetch teacher's invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, month, total_amount, status, created_at')
    .eq('teacher_id', id)
    .order('created_at', { ascending: false })

  // Fetch history log
  const { data: history } = await supabase
    .from('teacher_history_log')
    .select('id, field_name, old_value, new_value, changed_by, changed_at')
    .eq('teacher_id', id)
    .order('changed_at', { ascending: false })
    .limit(50)

  // Flatten nested student names on lessons
  const flatLessons = (lessons || []).map((l) => ({
    ...l,
    student_name: Array.isArray(l.students)
      ? (l.students[0] as { full_name: string } | undefined)?.full_name ?? '—'
      : (l.students as { full_name: string } | null)?.full_name ?? '—',
  }))

  return (
    <TeacherDetailClient
      teacher={teacher}
      lessons={flatLessons}
      invoices={invoices || []}
      history={history || []}
    />
  )
}