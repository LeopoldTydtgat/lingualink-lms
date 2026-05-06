'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, clearRateLimit } from '@/lib/rateLimit'

export async function forgotPasswordAction(formData: FormData) {
  // Rate-limit on the same bucket as student login: a forgot-password endpoint
  // is just as enumerable, and unrestricted sends would let an attacker spam
  // password-reset emails or rate-limit the Resend API for everyone else.
  const headersList = await headers()
  const ip = headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rateLimit = await checkRateLimit(ip, 'student')
  if (rateLimit.blocked) {
    return {
      error: 'Too many attempts. Please wait before trying again.',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    }
  }

  const email = formData.get('email') as string

  if (!email) {
    return { error: 'Please enter your email address.' }
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_STUDENT_URL}/student/reset-password`,
  })

  if (error) {
    return { error: 'Something went wrong. Please try again.' }
  }

  await clearRateLimit(ip, 'student')
  return { success: true }
}
