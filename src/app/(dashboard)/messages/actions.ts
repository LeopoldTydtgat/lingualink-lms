'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, newMessageEmailContent } from '@/lib/email/templates'

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

  // ── Send email notification to the recipient ────────────────────────────────
  // Look up the recipient's name and email from the correct table
  let recipientName = ''
  let recipientEmail = ''

  if (receiverType === 'student') {
    const { data: student } = await supabase
      .from('students')
      .select('full_name, email')
      .eq('id', receiverId)
      .single()

    if (student) {
      recipientName = student.full_name
      recipientEmail = student.email
    }
  } else {
    // teacher or admin — both live in profiles
    const { data: recipientProfile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', receiverId)
      .single()

    if (recipientProfile) {
      recipientName = recipientProfile.full_name
      recipientEmail = recipientProfile.email
    }
  }

  // Only send if we found a valid email address
  if (recipientEmail) {
    const subject = `Lingualink Online — New message from ${profile.full_name}`

    await resend.emails.send({
      from: 'Lingualink Online <no-reply@lingualinkonline.com>',
      to: recipientEmail,
      subject,
      html: buildEmailTemplate({
        recipientName,
        subject,
        bodyHtml: newMessageEmailContent(profile.full_name),
        contactEmail: receiverType === 'student' ? 'support@lingualinkonline.com' : 'teachers@lingualinkonline.com',
      }),
    })
  }

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
