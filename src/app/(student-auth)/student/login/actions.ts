'use server'

import { redirect } from 'next/navigation'
import { headers, cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, clearRateLimit } from '@/lib/rateLimit'

export async function studentLoginAction(formData: FormData) {
  // ── Rate limit check ────────────────────────────────────────────────────────
  const headersList = await headers()
  const ip = headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rateLimit = await checkRateLimit(ip, 'student')
  if (rateLimit.blocked) {
    return {
      error: 'Too many login attempts. Please wait before trying again.',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    }
  }

  const email = (formData.get('email') as string)?.trim().toLowerCase()
  const password = formData.get('password') as string

  if (!email || !password) {
    return { error: 'Please enter your email address and password.' }
  }

  const supabase = await createClient()
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (authError || !authData.user) {
    // Return a generic message — don't leak whether the email exists
    return { error: 'Incorrect email address or password.' }
  }

  // ── Verify the user has a student account ───────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id, status')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle()

  if (studentError || !student) {
    await supabase.auth.signOut()
    // Don't record this as a brute-force attempt — credentials were valid
    return { error: 'No student account found for this email address. If you are a teacher, please log in at the teacher portal.' }
  }

  if (student.status === 'former' || student.status === 'on_hold') {
    await supabase.auth.signOut()
    const cookieStore = await cookies()
    cookieStore.delete('ll_status_checked_at')
    return { error: 'Your account is not active. Please contact admin.' }
  }

  await clearRateLimit(ip, 'student')
  const returnUrl = (formData.get('returnUrl') as string) ?? ''
  redirect(returnUrl.startsWith('/') ? returnUrl : '/student/my-classes')
}
