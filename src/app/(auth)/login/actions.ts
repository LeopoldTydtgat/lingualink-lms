'use server'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { checkRateLimit } from '@/lib/rateLimit'

export async function signIn(formData: FormData) {
  const headersList = await headers()
  const ip = headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const isBlocked = await checkRateLimit(ip, 'teacher')
  if (isBlocked) {
    return { error: 'Too many login attempts. Please wait 10 minutes before trying again.' }
  }
  const email = (formData.get('email') as string)?.trim().toLowerCase()
  const password = formData.get('password') as string
  if (!email || !password) {
    return { error: 'Please enter your email address and password.' }
  }
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    return { error: 'Incorrect email address or password.' }
  }
  return { success: true }
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
