'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function sendMessage(
  receiverId: string,
  receiverType: 'teacher' | 'admin' | 'student',
  content: string,
  attachments?: Array<{ url: string; filename: string; size: number }>
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Student sender — look up from students table
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) return { error: 'Student not found' }

  const { error } = await supabase.from('messages').insert({
    sender_id: student.id,
    sender_type: 'student',
    receiver_id: receiverId,
    receiver_type: receiverType,
    content,
    attachments: attachments ?? [],
  })

  if (error) return { error: error.message }

  revalidatePath('/student/messages')
  return { success: true }
}

export async function markMessagesAsRead(contactId: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  // Get the student's own ID (messages use student.id, not auth user id)
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) return

  await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('receiver_id', student.id)
    .eq('sender_id', contactId)
    .is('read_at', null)
}
