export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AccountClient from './AccountClient'

export default async function AccountPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Use the admin client to bypass RLS — the user's identity has already been
  // verified above. The regular server client cannot reliably read the profiles
  // row (column-level REVOKEs on admin-only fields cause PostgREST to deny the
  // wildcard, returning null data).
  const admin = createAdminClient()

  const { data: profileRow } = await admin
    .from('profiles')
    .select('id, full_name, role, photo_url, timezone, bio, teaching_languages, speaking_languages, preferred_payment_type, paypal_email, iban, bic, tax_number, street_address, area_code, city, hourly_rate, currency')
    .eq('id', user.id)
    .single()

  // Do NOT redirect to /login if profile is null — the layout already
  // verified authentication. A missing profile is a data issue, not an auth issue.

  const { data: resources } = await supabase
    .from('resources')
    .select('*')
    .eq('is_active', true)
    .order('display_order')

  // Live review data lives in student_reviews (the `reviews` table is orphaned).
  // Read it through the admin client (RLS on student_reviews has no teacher SELECT
  // policy). The .eq('teacher_id', user.id) filter below is the security boundary
  // because the admin client bypasses RLS — it is mandatory.
  const { data: reviews } = await admin
    .from('student_reviews')
    .select(`
      id,
      rating,
      review_text,
      admin_edited_text,
      submitted_at,
      student_id,
      students (
        full_name,
        photo_url
      )
    `)
    .eq('teacher_id', user.id)
    .order('submitted_at', { ascending: false })

  const flatReviews = (reviews ?? []).map(r => {
    const student = Array.isArray(r.students) ? r.students[0] : r.students
    return {
      id: r.id,
      rating: r.rating,
      // Admins may edit the student's original text; show the edited version when present.
      review_text: r.admin_edited_text ?? r.review_text,
      submitted_at: r.submitted_at,
      student_id: r.student_id,
      students: student ?? null,
    }
  })

  // Provide sensible defaults if profile is null; always overlay email from
  // auth.users since it is not stored in the profiles table.
  const safeProfile = {
    id: user.id,
    email: user.email ?? '',
    full_name: profileRow?.full_name ?? null,
    role: profileRow?.role ?? 'teacher',
    photo_url: profileRow?.photo_url ?? null,
    timezone: profileRow?.timezone ?? null,
    bio: profileRow?.bio ?? null,
    teaching_languages: profileRow?.teaching_languages ?? [],
    speaking_languages: profileRow?.speaking_languages ?? [],
    preferred_payment_type: profileRow?.preferred_payment_type ?? null,
    paypal_email: profileRow?.paypal_email ?? null,
    iban: profileRow?.iban ?? null,
    bic: profileRow?.bic ?? null,
    tax_number: profileRow?.tax_number ?? null,
    street_address: profileRow?.street_address ?? null,
    area_code: profileRow?.area_code ?? null,
    city: profileRow?.city ?? null,
    hourly_rate: profileRow?.hourly_rate ?? null,
    currency: profileRow?.currency ?? null,
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
