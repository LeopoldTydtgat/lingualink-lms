import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MessagesClient from './MessagesClient'

export default async function MessagesPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  // Fetch all messages involving this user, newest first
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
    .order('created_at', { ascending: false })

  // Build a map of unique contacts from the message history
  // The "contact" in each message is whoever is NOT the current user
  const contactMap = new Map<string, {
    id: string
    type: string
    latestMessage: any
    unreadCount: number
  }>()

  for (const msg of (messages || [])) {
    const isFromMe = msg.sender_id === user.id
    const contactId = isFromMe ? msg.receiver_id : msg.sender_id
    const contactType = isFromMe ? msg.receiver_type : msg.sender_type

    if (!contactMap.has(contactId)) {
      // First message found = latest (since we ordered desc)
      contactMap.set(contactId, {
        id: contactId,
        type: contactType,
        latestMessage: msg,
        unreadCount: 0,
      })
    }

    // Count messages sent TO me that have not been read
    if (!isFromMe && !msg.read_at) {
      contactMap.get(contactId)!.unreadCount++
    }
  }

  // Separate contacts by type so we can look them up in the right table
  const studentContactIds: string[] = []
  const profileContactIds: string[] = []

  for (const [id, contact] of contactMap) {
    if (contact.type === 'student') studentContactIds.push(id)
    else profileContactIds.push(id)
  }

  // Fetch student details for student contacts
  const { data: studentDetails } = studentContactIds.length > 0
    ? await supabase
        .from('students')
        .select('id, full_name, email, photo_url')
        .in('id', studentContactIds)
    : { data: [] }

  // Fetch profile details for teacher/admin contacts
  const { data: profileDetails } = profileContactIds.length > 0
    ? await supabase
        .from('profiles')
        .select('id, full_name, role, photo_url')
        .in('id', profileContactIds)
    : { data: [] }

  // Combine contact map with display details
  const contacts = Array.from(contactMap.values()).map(contact => {
    const details = contact.type === 'student'
      ? (studentDetails || []).find((s: any) => s.id === contact.id)
      : (profileDetails || []).find((p: any) => p.id === contact.id)

    return {
      ...contact,
      name: details?.full_name || 'Unknown',
      email: details?.email || '',
      photo_url: details?.photo_url || null,
    }
  })

  // Sort by latest message time
  contacts.sort((a, b) =>
    new Date(b.latestMessage.created_at).getTime() -
    new Date(a.latestMessage.created_at).getTime()
  )

  // All active students — used for the "New Message" picker
  const { data: allStudents } = await supabase
    .from('students')
    .select('id, full_name, email, photo_url')
    .eq('is_active', true)
    .order('full_name')

  return (
    <MessagesClient
      currentUser={profile}
      contacts={contacts}
      allStudents={allStudents || []}
    />
  )
}