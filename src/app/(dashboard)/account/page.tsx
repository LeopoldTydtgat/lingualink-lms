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

  if (!profile) redirect('/login')

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

  return (
    <AccountClient
      profile={profile}
      resources={resources ?? []}
      reviews={flatReviews}
      userId={user.id}
    />
  )
}
