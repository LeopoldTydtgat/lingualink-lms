'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { checkRateLimit, recordFailedAttempt, clearAttempts, getClientIp } from '@/lib/rate-limit'

export async function signIn(formData: FormData) {
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
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // Only count actual credential failures — not network/server errors
    if (error.status === 400) {
      recordFailedAttempt(ip)
    }
    // Return a generic message — don't leak whether the email exists
    return { error: 'Incorrect email address or password.' }
  }

  // Success — clear any accumulated attempt count for this IP
  clearAttempts(ip)
  redirect('/dashboard')
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
