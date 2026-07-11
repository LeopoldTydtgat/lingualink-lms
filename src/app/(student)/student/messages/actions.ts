'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, newMessageEmailContent } from '@/lib/email/templates'
import { sanitizeHtml } from '@/lib/sanitize-server'
import { getAssignedTeacherIds } from '@/lib/access/trainingAssignment'
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

  // Student sender — look up from students table
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) return { error: 'Student not found' }

  // NEW275: server-side sender→receiver relationship gate via the SHARED training-
  // assignment helper. The messages RLS insert policy only checks sender identity, so
  // without this any authenticated student could message any teacher (or another student)
  // by POSTing an arbitrary receiverId. This is the SAME training_teachers rule the
  // student messages page uses to build the contact list, so send permission exactly
  // matches it; it also implicitly blocks student→student sends (a students.id never
  // matches a teacher_id). Fail closed — a query error throws (→ "Could not verify
  // access"), and an empty set (no assignments) denies an unassigned/unknown receiver.
  const accessDb = createAdminClient()
  let assignedTeacherIds: Set<string>
  try {
    assignedTeacherIds = await getAssignedTeacherIds(accessDb, student.id)
  } catch {
    return { error: 'Could not verify access. Please try again.' }
  }
  if (!assignedTeacherIds.has(receiverId)) {
    return { error: 'You can only message teachers assigned to your training.' }
  }

  // NEW299: pin/strip attachment URLs (phishing vector) — the RLS insert policy checks
  // only sender identity, so an arbitrary attachment URL would otherwise persist unchecked.
  const validation = validateAttachments(attachments)
  if (!validation.ok) return { error: 'Invalid attachments.' }

  const safeContent = sanitizeHtml(content)

  // Return the inserted row (real DB id) so the client renders THIS row instead of an
  // optimistic crypto.randomUUID() entry — otherwise the Realtime read-receipt UPDATE
  // (which carries the real id) never matches the optimistic row and the read tick never
  // flips (NEW286). The sender may select their own row under the existing messages RLS
  // (sender_id resolves via students.auth_user_id).
  const { data, error } = await supabase
    .from('messages')
    .insert({
      sender_id: student.id,
      sender_type: 'student',
      receiver_id: receiverId,
      receiver_type: receiverType,
      content: safeContent,
      attachments: validation.attachments,
    })
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at')
    .single()

  if (error) return { error: error.message }

  if (receiverType === 'teacher') {
    try {
      const adminDb = createAdminClient()
      const { data: teacher } = await adminDb
        .from('profiles')
        .select('full_name, email')
        .eq('id', receiverId)
        .single()

      if (teacher?.email) {
        const subject = `Lingualink Online — New message from ${student.full_name}`
        await resend.emails.send({
          from: 'Lingualink Online <no-reply@lingualinkonline.com>',
          to: teacher.email,
          subject,
          html: buildEmailTemplate({
            recipientName: teacher.full_name,
            recipientFallback: 'Teacher',
            subject,
            bodyHtml: newMessageEmailContent(student.full_name),
            contactEmail: 'teachers@lingualinkonline.com',
          }),
        })
      }
    } catch {
      // non-blocking
    }
  }

  revalidatePath('/student/messages')
  return { success: true, message: data }
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
