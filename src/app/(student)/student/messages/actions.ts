'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import resend from '@/lib/email/client'
import { buildEmailTemplate, newMessageEmailContent } from '@/lib/email/templates'
import { sanitizeHtml } from '@/lib/sanitize-server'
import { getAssignedTeacherIds } from '@/lib/access/trainingAssignment'
import { ACCOUNT_INACTIVE_ERROR, isCounterpartCurrent } from '@/lib/access/accountStatus'
import { validateAttachments } from '@/lib/messages/validateAttachments'
import { EDIT_WINDOW_ERROR, isWithinEditWindow } from '@/lib/messages/editWindow'

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

  // NEW349: receiver_type is client-supplied and was previously written to the row
  // unvalidated. The NEW275 gate above only constrains receiverId (always a profiles.id
  // of an assigned teacher) — it says nothing about the TYPE claim, so a hostile client
  // could persist receiver_type 'student' alongside a teacher auth uuid. That mismatch
  // row is unreadable downstream: the message-file proxy resolves the counterpart by
  // receiver_type and 403s its attachments. Mirrors the dashboard action's recipient
  // role-match block: the claim is now server-verified against the recipient's ACTUAL
  // profile role, so no client-supplied mismatch can reach the insert.
  //   - 'student' is never legitimate from a student sender (the assignment gate only
  //     passes teacher profile ids), so reject it outright.
  //   - 'admin' requires recipientProfile.role === 'admin'.
  //   - 'teacher' requires an existing profile row whose role is not 'admin'.
  // Fail closed: a lookup error or a missing row denies rather than falling through.
  if (receiverType === 'student') {
    return { error: 'Invalid recipient.' }
  }
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

  // NEW346: the counterpart account must still be current. The assignment gate above
  // only proves a training_teachers row exists — a FORMER teacher keeps that row, so
  // without this the send succeeds and the new-message email below fires to an account
  // proxy.ts will not let log in. The counterpart here is always a teacher or an admin,
  // both of which live in profiles. Fail closed: the helper denies by default on a
  // missing row or a query error.
  const counterpartCurrent = await isCounterpartCurrent(accessDb, receiverId, 'teacher')
  if (!counterpartCurrent) {
    return { error: ACCOUNT_INACTIVE_ERROR }
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
        const subject = `Lingualink Online - New message from ${student.full_name}`
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

export async function editMessage(messageId: string, content: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  // Messages use students.id, not the auth user id — resolve the indirection first.
  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (studentError) return { error: 'Could not verify access. Please try again.' }
  if (!student) return { error: 'Student not found' }

  // Edit gate: authenticated has no UPDATE grant on messages.content, so the edit
  // runs through the admin client after an explicit ownership check (NEW275 pattern:
  // RLS stays thin, the gate lives server-side). Fail closed on any lookup error.
  const adminDb = createAdminClient()
  const { data: message, error: fetchError } = await adminDb
    .from('messages')
    .select('id, sender_id, sender_type, receiver_id, receiver_type, attachments, created_at')
    .eq('id', messageId)
    .maybeSingle()

  if (fetchError) return { error: 'Could not verify access. Please try again.' }
  if (!message) return { error: 'Message not found.' }
  if (message.sender_id !== student.id || message.sender_type !== 'student') {
    return { error: 'You can only edit your own messages.' }
  }

  // 15-minute edit window, checked against the DB row's created_at (never a
  // client-supplied timestamp). The client hides the Edit button past the window,
  // but a stale open thread can still submit - this is the authoritative check.
  if (!isWithinEditWindow(message.created_at)) {
    return { error: EDIT_WINDOW_ERROR }
  }

  // An edit pushes new content into the thread, so it must clear the SAME NEW275
  // relationship gate as sendMessage above - otherwise a student whose teacher was
  // unassigned could keep injecting content into the blocked thread by editing old
  // messages. Mirrors sendMessage exactly: the receiver must be a currently-assigned
  // teacher (shared getAssignedTeacherIds helper), fail closed on lookup error.
  let assignedTeacherIds: Set<string>
  try {
    assignedTeacherIds = await getAssignedTeacherIds(adminDb, student.id)
  } catch {
    return { error: 'Could not verify access. Please try again.' }
  }
  if (!assignedTeacherIds.has(message.receiver_id)) {
    return { error: 'You can only message teachers assigned to your training.' }
  }

  // NEW346: an edit pushes new content into the thread, so it must clear the same
  // counterpart-status gate as sendMessage. Keyed on the STORED row's receiver, never a
  // client-supplied id; always a profiles lookup (teacher or admin).
  const editCounterpartCurrent = await isCounterpartCurrent(adminDb, message.receiver_id, 'teacher')
  if (!editCounterpartCurrent) {
    return { error: ACCOUNT_INACTIVE_ERROR }
  }

  // Content may be empty only when the message carries attachments (attachment-only
  // messages store '', mirroring api/support/send). Attachments are never modified
  // by an edit.
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0
  if (!content?.trim() && !hasAttachments) {
    return { error: 'Message cannot be empty.' }
  }

  const safeContent = sanitizeHtml(content ?? '')

  const { data, error } = await adminDb
    .from('messages')
    .update({ content: safeContent, edited_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('sender_id', student.id)
    .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at, edited_at')
    .single()

  if (error) return { error: 'Could not save your edit. Please try again.' }

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
