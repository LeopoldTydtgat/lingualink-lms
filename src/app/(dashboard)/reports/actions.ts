'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function reopenReport(reportId: string) {
  const supabase = await createClient()

  // Only admins can reopen reports — check the role first
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') return { error: 'Not authorised' }

  const { error } = await supabase
    .from('reports')
    .update({
      status: 'reopened',
      flagged_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', reportId)

  if (error) return { error: error.message }

  // Refresh the reports page so the list updates immediately
  revalidatePath('/reports')
  return { success: true }
}