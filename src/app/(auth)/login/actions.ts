'use server'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers, cookies } from 'next/headers'
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
  const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    return { error: 'Incorrect email address or password.' }
  }
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('status')
    .eq('id', authData.user.id)
    .maybeSingle()

  if (profileError || !profile) {
    // Valid auth credentials but no business record — reject explicitly
    await supabase.auth.signOut()
    const cookieStore = await cookies()
    cookieStore.delete('ll_status_checked_at')
    return { error: 'No teacher account found for this email address. If you are a student, please log in at the student portal.' }
  }

  if (profile.status === 'former' || profile.status === 'on_hold') {
    await supabase.auth.signOut()
    const cookieStore = await cookies()
    cookieStore.delete('ll_status_checked_at')
    return { error: 'This account is not active. Please contact admin.' }
  }

  return { success: true }
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
