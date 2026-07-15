// src/app/(dashboard)/messages/MessagesClient.tsx
'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import dynamic from 'next/dynamic'
import data from '@emoji-mart/data'
import { createClient } from '@/lib/supabase/client'
import { sanitizeHtml } from '@/lib/sanitize'
import { isEmojiOnly } from '@/lib/messages/isEmojiOnly'
import { messageAttachmentHref } from '@/lib/messages/attachmentHref'
import { EDIT_WINDOW_ERROR, isWithinEditWindow } from '@/lib/messages/editWindow'
import { sendMessage, editMessage, markMessagesAsRead } from './actions'
import { toast } from 'sonner'

const EmojiPicker = dynamic(() => import('@emoji-mart/react'), { ssr: false })

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string
  sender_id: string
  sender_type: string
  receiver_id: string
  receiver_type: string
  content: string
  attachments: any[]
  read_at: string | null
  created_at: string
  edited_at?: string | null
  // Client-only: set on the optimistic fallback row (no real DB id, so it can never
  // be edited). Never persisted; a real DB row never carries it.
  pending?: boolean
}

interface Contact {
  id: string
  type: string
  name: string
  photo_url: string | null
  // NEW346: the counterpart's account status ('current' | 'former' | 'on_hold', or null
  // when it could not be resolved). Anything other than 'current' makes the thread
  // read-only; the thread itself stays fully readable.
  status: string | null
  latestMessage: Message | null
  unreadCount: number
}

interface Student {
  id: string
  full_name: string
  email: string
  photo_url: string | null
}

interface Profile {
  id: string
  full_name: string
  role: string
}

interface MessagesClientProps {
  currentUser: Profile
  contacts: Contact[]
  allStudents: Student[]
  // NEW275: the teacher's currently-assigned student ids (mirrors the send-action gate).
  // A student history thread whose id is absent here is read-only for this teacher.
  assignedStudentIds: string[]
  initialContact?: Contact | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

  function formatTime(isoString: string): string {
    const date = new Date(isoString)
    const now = new Date()
    const isToday = date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear()
    if (isToday) {
      const h = String(date.getHours()).padStart(2, '0')
      const m = String(date.getMinutes()).padStart(2, '0')
      return `${h}:${m}`
    }
    const day = String(date.getDate()).padStart(2, '0')
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${day} ${months[date.getMonth()]}`
  }

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').slice(0, 60)
}

function Avatar({ name, photoUrl, size = 10 }: {
  name: string
  photoUrl: string | null
  size?: number
}) {
  const sizeClass = `w-${size} h-${size}`
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className={`${sizeClass} rounded-full object-cover`} />
  }
  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0`}
      style={{ backgroundColor: '#FF8303', fontSize: size <= 8 ? '11px' : '14px' }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Read ticks ───────────────────────────────────────────────────────────────
// Single tick = sent (grey). Double tick = read (orange).
// Only shown on messages sent by the current user.
function ReadTicks({ readAt }: { readAt: string | null }) {
  if (readAt) {
    // Double tick — message has been read
    return (
      <span className="inline-flex items-center gap-0.5 ml-1" aria-label="Read">
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
          <path d="M1 4L3.5 6.5L9 1" stroke="#FF8303" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M3.5 6.5L9 1" stroke="#FF8303" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style={{ marginLeft: '-4px' }}>
          <path d="M1 4L3.5 6.5L9 1" stroke="#FF8303" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    )
  }
  // Single tick — sent, not yet read
  return (
    <span className="inline-flex items-center ml-1" aria-label="Sent">
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
        <path d="M1 4L3.5 6.5L9 1" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MessagesClient({
  currentUser,
  contacts: initialContacts,
  allStudents,
  assignedStudentIds,
  initialContact = null,
}: MessagesClientProps) {
  const supabase = useMemo(() => createClient(), [])

  const [contacts, setContacts] = useState<Contact[]>(initialContacts)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [newMsgSearch, setNewMsgSearch] = useState('')
  const [, forceUpdate] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ url: string; filename: string; size: number }>>([])
  const [uploading, setUploading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const pendingReadsRef = useRef<Map<string, string>>(new Map())
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ underline: false }),
      Underline,
      Placeholder.configure({ placeholder: 'Write a message...' }),
    ],
    content: '',
    onTransaction: () => forceUpdate(n => n + 1),
  })

  // Separate instance for inline message editing — the main composer keeps its draft.
  const editEditor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ underline: false }),
      Underline,
      Placeholder.configure({ placeholder: 'Edit message...' }),
    ],
    content: '',
    onTransaction: () => forceUpdate(n => n + 1),
  })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const fetchMessages = useCallback(async (contact: Contact) => {
    setLoadingMessages(true)
    const { data } = await supabase
      .from('messages')
      .select('id, sender_id, sender_type, receiver_id, receiver_type, content, attachments, read_at, created_at, edited_at')
      .or(
        `and(sender_id.eq.${currentUser.id},receiver_id.eq.${contact.id}),` +
        `and(sender_id.eq.${contact.id},receiver_id.eq.${currentUser.id}),` +
        `and(sender_type.eq.admin,receiver_id.eq.${currentUser.id})`
      )
      .order('created_at', { ascending: true })

    setMessages(data || [])
    setLoadingMessages(false)
    await markMessagesAsRead(contact.id)
    setContacts(prev => prev.map(c => c.id === contact.id ? { ...c, unreadCount: 0 } : c))
  }, [supabase, currentUser.id])

  const handleSelectContact = useCallback(async (contact: Contact) => {
    setSelectedContact(contact)
    setEditingMessageId(null)
    await fetchMessages(contact)
  }, [fetchMessages])

  // Auto-open initial contact (e.g. arriving from "Message admin" deep-link)
  useEffect(() => {
    if (!initialContact) return
    setContacts(prev => {
      const already = prev.find(c => c.id === initialContact.id)
      if (already) return prev
      return [initialContact, ...prev]
    })
    handleSelectContact(initialContact)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Real-time: mark incoming messages as read and update read_at on sent messages
  useEffect(() => {
    if (!selectedContact) return

    const channel = supabase
      .channel(`inbox-${currentUser.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUser.id}`,
        },
        async (payload) => {
          const newMsg = payload.new as Message
          if (newMsg.sender_id === selectedContact.id) {
            setMessages(prev => [...prev, newMsg])
            await markMessagesAsRead(selectedContact.id)
          }
        }
      )
      .on(
        // When the other person reads our messages, their client calls markMessagesAsRead
        // which updates read_at. We listen for UPDATEs to reflect the double tick. The
        // same events also carry our own edits (content + edited_at) from another
        // session, so patch those too — read_at never regresses to null here because an
        // edit UPDATE on an unread message arrives with read_at still null.
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `sender_id=eq.${currentUser.id}`,
        },
        (payload) => {
          const updated = payload.new as Message
          if (updated.read_at) {
            pendingReadsRef.current.set(updated.id, updated.read_at)
          }
          // Return prev UNCHANGED (same array reference) when no message matches -
          // an UPDATE for another thread must not re-fire the scroll-to-bottom
          // effect, which keys on the messages array identity.
          setMessages(prev => {
            if (!prev.some(m => m.id === updated.id)) return prev
            return prev.map(m => m.id === updated.id
              ? {
                  ...m,
                  read_at: updated.read_at ?? m.read_at,
                  content: updated.content ?? m.content,
                  edited_at: updated.edited_at ?? m.edited_at,
                }
              : m)
          })
        }
      )
      .on(
        // When the contact edits a message they sent to us, patch its content and
        // edited_at live. Guarded on edited_at so our own markMessagesAsRead UPDATEs
        // (which also match receiver_id = us) pass through untouched.
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUser.id}`,
        },
        (payload) => {
          const updated = payload.new as Message
          if (!updated.edited_at) return
          // Same no-match guard as the sender-side handler above: an edit in a
          // thread other than the open one must not re-fire the scroll-to-bottom
          // effect. The contacts patch below stays unconditional - a non-open
          // thread's preview still needs the edit, and it has no scroll effect.
          setMessages(prev => {
            if (!prev.some(m => m.id === updated.id)) return prev
            return prev.map(m => m.id === updated.id
              ? { ...m, content: updated.content ?? m.content, edited_at: updated.edited_at }
              : m)
          })
          // Keep the contact list's preview in step when the edited message is the
          // one shown there (same shape as the own-save patch in handleSaveEdit).
          setContacts(prev =>
            prev.map(c => c.latestMessage?.id === updated.id
              ? { ...c, latestMessage: { ...c.latestMessage, content: updated.content ?? c.latestMessage.content } }
              : c)
          )
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedContact, currentUser.id, supabase])

  const handleSend = async () => {
    if (!editor || !selectedContact || sending) return
    const html = editor.getHTML()
    // Treat tag-only / whitespace-only HTML as empty (emoji-only still counts as content).
    const isEmpty = !html || (html.replace(/<[^>]*>/g, '').trim().length === 0 && !isEmojiOnly(html))
    if (isEmpty && pendingAttachments.length === 0) return
    // Attachment-only send: store clean '' rather than '<p></p>' so the renderer's
    // hasContent guard hides the empty bubble.
    const contentToSend = isEmpty ? '' : html

    setSending(true)
    setSendError(null)
    try {
      const result = await sendMessage(
        selectedContact.id,
        selectedContact.type as 'teacher' | 'admin' | 'student',
        contentToSend,
        pendingAttachments.length > 0 ? pendingAttachments : undefined
      )

      if (result?.error) {
        setSendError('Message failed to send. Please try again.')
        return
      }

      // NEW286: prefer the real inserted row (carries the DB id) so the Realtime
      // read-receipt UPDATE — which matches on that id — can flip this message's
      // read tick. Fall back to an optimistic entry only if the row is missing;
      // the fallback is marked pending so the Edit affordance never targets a
      // row whose id doesn't exist in the DB.
      const sentMsg: Message = (result?.message as Message | undefined) ?? {
        id: crypto.randomUUID(),
        sender_id: currentUser.id,
        sender_type: currentUser.role,
        receiver_id: selectedContact.id,
        receiver_type: selectedContact.type,
        content: contentToSend,
        attachments: pendingAttachments,
        read_at: null,
        created_at: new Date().toISOString(),
        pending: true,
      }

      const pendingReadAt = pendingReadsRef.current.get(sentMsg.id)
      if (pendingReadAt) {
        sentMsg.read_at = pendingReadAt
        pendingReadsRef.current.delete(sentMsg.id)
      }
      setMessages(prev => [...prev, sentMsg])
      setContacts(prev =>
        prev.map(c => c.id === selectedContact.id ? { ...c, latestMessage: sentMsg } : c)
      )
      editor.commands.clearContent()
      setPendingAttachments([])
    } catch (err) {
      console.error('Send failed:', err)
      setSendError('Message failed to send. Please try again.')
    } finally {
      setSending(false)
    }
  }

  const handleStartEdit = (msg: Message) => {
    setEditingMessageId(msg.id)
    editEditor?.commands.setContent(msg.content || '')
    setTimeout(() => editEditor?.commands.focus('end'), 100)
  }

  const handleCancelEdit = () => {
    setEditingMessageId(null)
    editEditor?.commands.clearContent()
  }

  const handleSaveEdit = async () => {
    if (!editEditor || !editingMessageId || savingEdit) return
    const target = messages.find(m => m.id === editingMessageId)
    if (!target) return

    const html = editEditor.getHTML()
    // Same emptiness rule as handleSend; empty is allowed only when the message
    // keeps its attachments (attachment-only messages store '').
    const isEmpty = !html || (html.replace(/<[^>]*>/g, '').trim().length === 0 && !isEmojiOnly(html))
    const hasAttachments = Array.isArray(target.attachments) && target.attachments.length > 0
    if (isEmpty && !hasAttachments) {
      toast.error('Message cannot be empty.', { duration: 6000 })
      return
    }
    const contentToSave = isEmpty ? '' : html

    setSavingEdit(true)
    try {
      const result = await editMessage(editingMessageId, contentToSave)
      if (result?.error || !result?.message) {
        // Surface the window rejection verbatim (retrying can't help there);
        // everything else stays generic.
        toast.error(
          result?.error === EDIT_WINDOW_ERROR ? EDIT_WINDOW_ERROR : 'Edit failed to save. Please try again.',
          { duration: 6000 }
        )
        return
      }
      const updated = result.message as Message
      setMessages(prev =>
        prev.map(m => m.id === updated.id
          ? { ...m, content: updated.content, edited_at: updated.edited_at }
          : m)
      )
      setContacts(prev =>
        prev.map(c => c.latestMessage?.id === updated.id
          ? { ...c, latestMessage: { ...c.latestMessage, content: updated.content } }
          : c)
      )
      setEditingMessageId(null)
      editEditor.commands.clearContent()
    } catch (err) {
      console.error('Edit failed:', err)
      toast.error('Edit failed to save. Please try again.', { duration: 6000 })
    } finally {
      setSavingEdit(false)
    }
  }

  const handleNewConversation = (student: Student) => {
    const existing = contacts.find(c => c.id === student.id)
    if (existing) {
      handleSelectContact(existing)
    } else {
      const newContact: Contact = {
        id: student.id,
        type: 'student',
        name: student.full_name,
        photo_url: student.photo_url,
        // NEW346: the new-message picker's server query already filters
        // status='current' (page.tsx), so anyone reachable here is current by
        // construction. The server send gate re-checks authoritatively regardless.
        status: 'current',
        latestMessage: null,
        unreadCount: 0,
      }
      setContacts(prev => [newContact, ...prev])
      handleSelectContact(newContact)
    }
    setShowNewMessage(false)
    setNewMsgSearch('')
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 10 * 1024 * 1024) {
      toast.error('File must be under 10MB.', { duration: 6000 })
      e.target.value = ''
      return
    }

    setUploading(true)
    const form = new FormData()
    form.append('file', file)

    const res = await fetch('/api/messages/upload', { method: 'POST', body: form })
    const json = await res.json()

    if (!res.ok) {
      toast.error(json.error ?? 'Upload failed.', { duration: 6000 })
    } else {
      setPendingAttachments(prev => [...prev, { url: json.url, filename: json.filename, size: json.size }])
    }

    setUploading(false)
    e.target.value = ''
  }

  const filteredContacts = contacts.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const filteredStudents = allStudents.filter(s =>
    s.full_name.toLowerCase().includes(newMsgSearch.toLowerCase())
  )

  // NEW275 + NEW346: a stale history thread can still be selected (the history contact
  // list is intentionally ungated so past conversations stay readable). The server send
  // gate blocks such a send; reflect that here with a read-only composer instead of
  // letting the send fail. Two independent reasons a thread is read-only:
  //
  //  1. NEW275 assignment — this teacher is no longer assigned to that student. Admins
  //     are ungated here and teacher↔teacher/admin threads are never assignment-gated.
  //  2. NEW346 status — the counterpart account is no longer 'current'. This half
  //     applies to EVERY contact type and to admins too: nobody may message a
  //     locked-out account. Mirrors the server's isCounterpartCurrent gate, including
  //     its deny-by-default (a null/unknown status is not 'current').
  const assignedStudentIdSet = useMemo(() => new Set(assignedStudentIds), [assignedStudentIds])
  const isBlockedContact =
    !!selectedContact &&
    ((currentUser.role !== 'admin' &&
      selectedContact.type === 'student' &&
      !assignedStudentIdSet.has(selectedContact.id)) ||
      selectedContact.status !== 'current')

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="flex bg-white rounded-lg border border-gray-200 overflow-hidden"
      style={{ height: 'calc(100vh - 120px)' }}
    >
      {/* ── Left panel: contacts list ── */}
      <div className="w-72 border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-base font-semibold text-gray-900">Messages</h1>
            <button
              onClick={() => setShowNewMessage(true)}
              className="w-7 h-7 rounded-full flex items-center justify-center text-white text-lg leading-none btn-primary-hover"
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
              style={{ backgroundColor: '#FF8303' }}
              title="New message"
            >
              +
            </button>
          </div>
          <input
            type="text"
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1"
          />
        </div>

        <div className="flex-1 overflow-y-auto thin-scroll">
          {filteredContacts.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">
              {contacts.length === 0
                ? 'No conversations yet.\nClick + to start one.'
                : 'No contacts match your search.'}
            </div>
          ) : (
            filteredContacts.map(contact => (
              <button
                key={contact.id}
                onClick={() => handleSelectContact(contact)}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50"
                style={selectedContact?.id === contact.id ? { backgroundColor: '#FFF3E0' } : {}}
              >
                <div className="relative flex-shrink-0">
                  <Avatar name={contact.name} photoUrl={contact.photo_url} size={10} />
                  {contact.unreadCount > 0 && (
                    <span
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-white text-xs font-bold"
                      style={{ backgroundColor: '#FF8303', fontSize: '10px' }}
                    >
                      {contact.unreadCount > 9 ? '9+' : contact.unreadCount}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-sm truncate ${contact.unreadCount > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                      {contact.name}
                    </span>
                    {contact.latestMessage && (
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {formatTime(contact.latestMessage.created_at)}
                      </span>
                    )}
                  </div>
                  {contact.latestMessage && (
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                      {contact.latestMessage.sender_id === currentUser.id ? 'You: ' : ''}
                      {stripHtml(contact.latestMessage.content)}
                    </p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: conversation ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedContact ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-5xl mb-3">💬</div>
              <p className="text-sm">Select a conversation or start a new one</p>
            </div>
          </div>
        ) : (
          <>
            {/* Contact header */}
            <div className="px-5 py-3.5 border-b border-gray-200 flex items-center gap-3 flex-shrink-0">
              <Avatar name={selectedContact.name} photoUrl={selectedContact.photo_url} size={9} />
              <div>
                <p className="text-sm font-semibold text-gray-900">{selectedContact.name}</p>
                <p className="text-xs text-gray-400 capitalize">{selectedContact.type}</p>
              </div>
            </div>

            {/* Message thread */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 thin-scroll" style={{ backgroundColor: '#FFF9F3' }}>
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">Loading...</div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">No messages yet. Say hello!</div>
              ) : (
                messages.map((msg, index) => {
                  const isFromMe = msg.sender_id === currentUser.id
                  const hasContent = msg.content.replace(/<[^>]*>/g, '').trim().length > 0 || isEmojiOnly(msg.content)
                  const showDate =
                    index === 0 ||
                    new Date(msg.created_at).toDateString() !==
                    new Date(messages[index - 1].created_at).toDateString()

                  return (
                    <div key={msg.id}>
                      {showDate && (
                        <div className="flex items-center gap-3 my-4">
                          <div className="flex-1 h-px bg-gray-100" />
                          <span className="text-xs text-gray-400 flex-shrink-0">
                            {new Date(msg.created_at).toLocaleDateString([], {
                              weekday: 'long', day: 'numeric', month: 'long',
                            })}
                          </span>
                          <div className="flex-1 h-px bg-gray-100" />
                        </div>
                      )}
                      <div className={`flex ${isFromMe ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[72%]">
                          {editingMessageId === msg.id ? (
                            /* Inline edit box replaces the bubble; attachments are never
                               modified by an edit and reappear on save/cancel. */
                            <div className="rounded-2xl border border-gray-200 bg-white px-3 py-2" style={{ minWidth: '220px' }}>
                              <div
                                className="messages-composer text-sm min-h-[40px] max-h-[120px] overflow-y-auto cursor-text"
                                onClick={() => editEditor?.commands.focus()}
                              >
                                <EditorContent editor={editEditor} />
                              </div>
                              <div className="flex items-center justify-end gap-2 mt-2">
                                <button
                                  onClick={handleCancelEdit}
                                  className="px-3 py-1 rounded-lg text-xs font-medium text-gray-600 border border-gray-200 hover:bg-gray-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={handleSaveEdit}
                                  disabled={savingEdit}
                                  className="px-3 py-1 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                                  style={{ backgroundColor: '#FF8303' }}
                                >
                                  {savingEdit ? 'Saving...' : 'Save'}
                                </button>
                              </div>
                            </div>
                          ) : (
                          <>
                          {/* Bubble
                              Sent:     #FF8303 orange, white text
                              Received: #1F2937 dark charcoal, white text
                              Two distinct colours = immediately obvious who said what
                              NEW302: hide the bubble entirely for an attachment-only
                              (empty-content) message so it doesn't render a blank box. */}
                          {hasContent && (
                          <div
                            className="message-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                            style={isEmojiOnly(msg.content)
                              ? { fontSize: '2rem', background: 'none', padding: '4px 8px' }
                              : isFromMe
                                ? { backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }
                                : { backgroundColor: '#ffffff', color: '#1f2937', border: '1px solid #E0DFDC', borderBottomLeftRadius: '4px' }
                            }
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }}
                          />
                          )}
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className={`${hasContent ? 'mt-1' : ''} flex flex-col gap-1`}>
                              {msg.attachments.map((att: { url: string; filename: string; size: number }, i: number) => (
                                <a
                                  key={i}
                                  href={messageAttachmentHref('message', msg.id, i, att.url, msg.pending)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 text-xs underline opacity-80 hover:opacity-100"
                                >
                                  📎 {att.filename}
                                </a>
                              ))}
                            </div>
                          )}
                          </>
                          )}
                          {/* Timestamp + read ticks row */}
                          <div className={`flex items-center gap-1 mt-1 ${isFromMe ? 'justify-end' : 'justify-start'}`}>
                            {/* Edit affordance: own messages only, within the 15-minute
                                window (server re-checks authoritatively), never on a
                                pending optimistic row. Hidden in read-only threads
                                (unassigned student, or non-current counterpart account)
                                to match the disabled composer. */}
                            {isFromMe && !isBlockedContact && editingMessageId !== msg.id &&
                              !msg.pending && isWithinEditWindow(msg.created_at) && (
                              <button
                                onClick={() => handleStartEdit(msg)}
                                className="text-xs text-gray-400 hover:text-gray-600"
                                aria-label="Edit message"
                              >
                                Edit
                              </button>
                            )}
                            {msg.edited_at && (
                              <span className="text-xs text-gray-400 italic">(edited)</span>
                            )}
                            <span className="text-xs text-gray-400">
                              {formatTime(msg.created_at)}
                            </span>
                            {/* Read ticks only on messages I sent */}
                            {isFromMe && <ReadTicks readAt={msg.read_at} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Message composer ──
                The editor sits directly in the footer — no box-within-a-box.
                The style tag below suppresses ProseMirror's own default focus border
                which cannot be removed via Tailwind classes alone.
                NEW275/NEW346: for a stale history thread — one whose student is no longer
                assigned to this teacher, or whose counterpart account is no longer
                current — the composer is replaced by a read-only notice; the thread
                above stays fully readable. The sub-line names the actual reason, since a
                deactivated account and an unassignment need different follow-up. */}
            {isBlockedContact ? (
              <div className="border-t border-gray-200 flex-shrink-0 bg-white px-5 py-4">
                <p className="text-sm font-medium text-gray-600">
                  You can no longer message {selectedContact.name}.
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {selectedContact.status !== 'current'
                    ? 'This account is no longer active. You can still read the conversation above.'
                    : 'This student is not currently assigned to you. Please contact an administrator if you need to reach them.'}
                </p>
              </div>
            ) : (
            <div className="border-t border-gray-200 flex-shrink-0 bg-white">
              <style>{`
                .messages-composer .ProseMirror { outline: none !important; border: none !important; box-shadow: none !important; }
                .messages-composer .ProseMirror:focus { outline: none !important; border: none !important; }
                .messages-composer .ProseMirror p.is-editor-empty:first-child::before { color: #9ca3af; content: attr(data-placeholder); float: left; height: 0; pointer-events: none; }
                .messages-composer .ProseMirror ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
                .messages-composer .ProseMirror ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
                .messages-composer .ProseMirror li { margin: 0.1rem 0; }
                .message-bubble ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
                .message-bubble ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
                .message-bubble li { margin: 0.1rem 0; }
              `}</style>
              {/* Formatting toolbar */}
              <div className="flex items-center gap-1 px-4 pt-3 pb-1">
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
                  className="px-2 py-1 text-xs rounded font-bold text-gray-500 hover:bg-gray-100"
                  style={editor?.isActive('bold') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                >
                  B
                </button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleItalic().run() }}
                  className="px-2 py-1 text-xs rounded italic text-gray-500 hover:bg-gray-100"
                  style={editor?.isActive('italic') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                >
                  I
                </button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleUnderline().run() }}
                  className="px-2 py-1 text-xs rounded underline text-gray-500 hover:bg-gray-100"
                  style={editor?.isActive('underline') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                >
                  U
                </button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBulletList().run() }}
                  className="px-2 py-1 text-xs rounded text-gray-500 hover:bg-gray-100"
                  style={editor?.isActive('bulletList') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                >
                  •≡
                </button>
                <div style={{ position: 'relative', display: 'inline-block' }} ref={emojiPickerRef}>
                  <button onClick={() => setShowEmojiPicker(v => !v)} title="Emoji" style={{ padding: '4px 6px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>😊</button>
                  {showEmojiPicker && (
                    <div style={{ position: 'absolute', bottom: '40px', left: 0, zIndex: 50 }}>
                      <EmojiPicker data={data} onEmojiSelect={(emoji: { native: string }) => { editor?.commands.insertContent(emoji.native); setShowEmojiPicker(false) }} theme="light" />
                    </div>
                  )}
                </div>
              </div>

              {/* Tiptap editor — bordered container shows the typing area clearly.
                  The style tag above removes ProseMirror's OWN inner border so there
                  is one clean box, not a box-within-a-box. */}
              <div
                className="messages-composer mx-4 mb-2 rounded-xl border border-gray-200 px-3 py-2 text-sm min-h-[72px] max-h-[120px] overflow-y-auto cursor-text focus-within:border-orange-300 transition-colors"
                onClick={() => editor?.commands.focus()}
              >
                <EditorContent editor={editor} />
              </div>

              {/* Pending attachments list */}
              {pendingAttachments.length > 0 && (
                <div className="mx-4 mb-2 flex flex-col gap-1">
                  {pendingAttachments.map((att, i) => (
                    <div key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600">
                      <span className="truncate max-w-[200px]">📎 {att.filename}</span>
                      <button
                        onClick={() => setPendingAttachments(prev => prev.filter((_, idx) => idx !== i))}
                        className="ml-2 text-gray-400 hover:text-gray-600 flex-shrink-0"
                        aria-label="Remove attachment"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {sendError && (
                <div style={{ color: '#FD5602', fontSize: '13px', padding: '4px 16px' }}>
                  {sendError}
                </div>
              )}
              {/* Send row */}
              <div className="flex items-center justify-between px-4 pb-3 pt-1">
                <div className="flex items-center gap-2">
                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  {/* Paperclip button */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-50 transition-colors"
                    title="Attach file"
                    aria-label="Attach file"
                  >
                    {uploading ? (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="animate-spin">
                        <circle cx="8" cy="8" r="6" stroke="#9ca3af" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M13.5 7.5L7.5 13.5C6.1 14.9 3.9 14.9 2.5 13.5C1.1 12.1 1.1 9.9 2.5 8.5L8.5 2.5C9.4 1.6 10.9 1.6 11.8 2.5C12.7 3.4 12.7 4.9 11.8 5.8L5.8 11.8C5.3 12.3 4.6 12.3 4.1 11.8C3.6 11.3 3.6 10.6 4.1 10.1L9.5 4.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                </div>
                <button
                  onClick={handleSend}
                  disabled={sending}
                  className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-opacity btn-primary-hover"
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
                  style={{ backgroundColor: '#FF8303' }}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
            )}
          </>
        )}
      </div>

      {/* ── New Message modal ── */}
      {showNewMessage && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-sm font-semibold text-gray-900">New Message</h2>
              <button
                onClick={() => { setShowNewMessage(false); setNewMsgSearch('') }}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="px-5 pt-3 pb-2">
              <input
                type="text"
                placeholder="Search students..."
                value={newMsgSearch}
                onChange={e => setNewMsgSearch(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-400"
                autoFocus
              />
            </div>
            <div className="px-3 pb-4 max-h-72 overflow-y-auto thin-scroll">
              {filteredStudents.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No students found</p>
              ) : (
                filteredStudents.map(student => (
                  <button
                    key={student.id}
                    onClick={() => handleNewConversation(student)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 text-left transition-colors"
                  >
                    <Avatar name={student.full_name} photoUrl={student.photo_url} size={8} />
                    <div>
                      <p className="text-sm font-medium text-gray-900">{student.full_name}</p>
                      <p className="text-xs text-gray-400">{student.email}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
