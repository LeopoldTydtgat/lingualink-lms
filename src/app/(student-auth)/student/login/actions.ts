'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, recordFailedAttempt, clearAttempts, getClientIp } from '@/lib/rate-limit'

export async function studentLoginAction(formData: FormData) {
  // ── Rate limit check ────────────────────────────────────────────────────────
  const headersList = await headers()
  const ip = getClientIp(headersList)
  const rateLimitError = checkRateLimit(ip)
  if (rateLimitError) {
    return { error: rateLimitError }
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
    // Only count actual credential failures — not network/server errors
    if (!authError || authError.status === 400) {
      recordFailedAttempt(ip)
    }
    // Return a generic message — don't leak whether the email exists
    return { error: 'Incorrect email address or password.' }
  }

  // ── Verify the user has a student account ───────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id, is_active')
    .eq('auth_user_id', authData.user.id)
    .single()

  if (studentError || !student) {
    await supabase.auth.signOut()
    // Don't record this as a brute-force attempt — credentials were valid
    return { error: 'No student account found for this email address. If you are a teacher, please log in at the teacher portal.' }
  }

  if (!student.is_active) {
    await supabase.auth.signOut()
    return { error: 'Your account has been deactivated. Please contact admin.' }
  }

  // Success — clear any accumulated attempt count for this IP
  clearAttempts(ip)
  redirect('/student/my-classes')
}
