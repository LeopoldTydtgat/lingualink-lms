'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function studentLoginAction(formData: FormData) {
  const email = formData.get('email') as string
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
    return { error: 'Incorrect email address or password.' }
  }

  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id, is_active')
    .eq('auth_user_id', authData.user.id)
    .single()

  if (studentError || !student) {
    await supabase.auth.signOut()
    return { error: 'No student account found for this email address. If you are a teacher, please log in at the teacher portal.' }
  }

  if (!student.is_active) {
    await supabase.auth.signOut()
    return { error: 'Your account has been deactivated. Please contact admin.' }
  }

  redirect('/student/my-classes')
}