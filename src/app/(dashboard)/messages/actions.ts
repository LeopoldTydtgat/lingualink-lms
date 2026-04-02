'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

// Sends a message from the current user to a contact
export async function sendMessage(
  receiverId: string,
  receiverType: 'teacher' | 'admin' | 'student',
  content: string
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile) return { error: 'Profile not found' }

  const senderType = profile.role === 'admin' ? 'admin' : 'teacher'

  const { error } = await supabase.from('messages').insert({
    sender_id: user.id,
    sender_type: senderType,
    receiver_id: receiverId,
    receiver_type: receiverType,
    content,
    attachments: [],
  })

  if (error) return { error: error.message }

  revalidatePath('/messages')
  return { success: true }
}

// Marks all unread messages from a contact as read
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