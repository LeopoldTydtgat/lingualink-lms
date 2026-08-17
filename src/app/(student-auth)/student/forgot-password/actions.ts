'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'

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

  // Deliberately NO clearRateLimit here (SEC-C1): resetPasswordForEmail
  // succeeds even for unknown addresses, so clearing on "success" let any
  // forgot-password POST wipe the shared login brute-force counter. The
  // counter now only expires with its 10-minute window; a successful LOGIN
  // still clears it in the login action.
  return { success: true }
}
