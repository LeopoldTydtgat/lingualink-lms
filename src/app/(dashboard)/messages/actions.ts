'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentNewMessageEmailContent } from '@/lib/email/templates'
import { sanitizeHtml } from '@/lib/sanitize-server'
import { getAssignedStudentIds } from '@/lib/access/trainingAssignment'
import { validateAttachments } from '@/lib/messages/validateAttachments'

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

  // NEW275: server-side sender→receiver relationship gate. The messages RLS insert policy
  // only checks sender identity, so without this any authenticated teacher could message
  // any student/teacher/admin by POSTing an arbitrary receiverId. teacher→student reuses
  // the SAME shared training-assignment set (getAssignedStudentIds) that builds the new-
  // message picker, so send permission exactly matches the list: a teacher may message a
  // student iff assigned to one of their trainings (bookings are irrelevant). Admin sender
  // is ungated (may message anyone). Fail closed — any verification lookup error returns
  // rather than falling through to the insert.
  if (senderType === 'teacher') {
    const accessDb = createAdminClient()
    if (receiverType === 'student') {
      let assignedStudentIds: Set<string>
      try {
        assignedStudentIds = await getAssignedStudentIds(accessDb, user.id)
      } catch {
        return { error: 'Could not verify access. Please try again.' }
      }
      if (!assignedStudentIds.has(receiverId)) {
        return { error: 'You can only message students assigned to you.' }
      }
    } else {
      // receiverType is 'teacher' or 'admin'. Confirm the recipient profile exists and
      // its role matches the claim: role 'admin' for receiverType 'admin', any non-admin
      // profile role for receiverType 'teacher'. This closes the hole where a teacher
      // passes receiverType 'teacher' with a student id to bypass the student check above.
      const { data: recipientProfile, error: recipientError } = await accessDb
        .from('profiles')
        .select('id, role')
        .eq('id', receiverId)
        .maybeSingle()
      if (recipientError) {
        return { error: 'Could not verify access. Please try again.' }
      }
      const roleMatches =
        receiverType === 'admin'
          ? recipientProfile?.role === 'admin'
          : !!recipientProfile && recipientProfile.role !== 'admin'
      if (!recipientProfile || !roleMatches) {
        return { error: 'Invalid recipient.' }
      }
    }
  }

  // NEW299: pin/strip attachment URLs (phishing vector) — the RLS insert policy checks
  // only sender identity, so an arbitrary attachment URL would otherwise persist unchecked.
  const validation = validateAttachments(attachments)
  if (!validation.ok) return { error: 'Invalid attachments.' }

  const safeContent = sanitizeHtml(content)

  // Save the message to the database. Return the inserted row (real DB id) so the
  // client can render THIS row instead of an optimistic crypto.randomUUID() entry —
  // otherwise the Realtime UPDATE read-receipt (which carries the real id) never
  // matches the optimistic row and the read tick never flips (NEW286). The sender
  // may select their own row under the existing messages RLS (sender_id = auth.uid()).
  const { data, error } = await supabase
    .from('messages')
    .insert({
      sender_id: user.id,
      sender_type: senderType,
      receiver_id: receiverId,
      receiver_type: receiverType,
      content: safeContent,
      attachments: validation.attachments,
    })
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at')
    .single()

  if (error) return { error: error.message }

  if (receiverType === 'student') {
    try {
      const adminDb = createAdminClient()
      const { data: student } = await adminDb
        .from('students')
        .select('full_name, email')
        .eq('id', receiverId)
        .single()

      if (student?.email) {
        const subject = `Lingualink Online - New message from ${profile.full_name}`
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: student.email,
          subject,
          html: buildEmailTemplate({
            recipientName: student.full_name,
            recipientFallback: 'Student',
            subject,
            bodyHtml: studentNewMessageEmailContent(profile.full_name),
            contactEmail: 'support@lingualinkonline.com',
          }),
        })
      }
    } catch {
      // non-blocking
    }
  }

  revalidatePath('/messages')
  return { success: true, message: data }
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
