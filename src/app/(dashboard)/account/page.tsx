import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AccountClient from './AccountClient'

export default async function AccountPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // Do NOT redirect to /login if profile is null — the layout already
  // verified authentication. A missing profile is a data issue, not an auth issue.

  const { data: resources } = await supabase
    .from('resources')
    .select('*')
    .eq('is_active', true)
    .order('display_order')

  const { data: reviews } = await supabase
    .from('reviews')
    .select(`
      id,
      rating,
      review_text,
      is_visible,
      created_at,
      student_id,
      students (
        full_name,
        photo_url
      )
    `)
    .eq('teacher_id', user.id)
    .eq('is_visible', true)
    .order('created_at', { ascending: false })

  const flatReviews = (reviews ?? []).map(r => ({
    ...r,
    students: Array.isArray(r.students) ? r.students[0] : r.students,
  }))

  // Provide sensible defaults if profile is null
  const safeProfile = profile ?? {
    id: user.id,
    full_name: user.email ?? 'Teacher',
    email: user.email ?? '',
    role: 'teacher',
    photo_url: null,
    timezone: 'UTC',
    bio: '',
    teaching_language: '',
    speaking_languages: [],
    title: '',
    gender: '',
    nationality: '',
    phone: '',
    address_street: '',
    address_city: '',
    address_country: '',
    address_postcode: '',
  }

  return (
    <AccountClient
      profile={safeProfile}
      resources={resources ?? []}
      reviews={flatReviews}
      userId={user.id}
    />
  )
}
