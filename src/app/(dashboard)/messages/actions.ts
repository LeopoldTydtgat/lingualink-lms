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

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  if (!profile) return { error: 'Profile not found' }

  const senderType = profile.role === 'admin' ? 'admin' : 'teacher'

  // Save the message to the database
  const { error } = await supabase.from('messages').insert({
    sender_id: user.id,
    sender_type: senderType,
    receiver_id: receiverId,
    receiver_type: receiverType,
    content,
    attachments: attachments ?? [],
  })

  if (error) return { error: error.message }

  revalidatePath('/messages')
  return { success: true }
}

export async function markMessagesAsRead(contactId: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('receiver_id', user.id)
    .eq('sender_id', contactId)
    .is('read_at', null)
}
