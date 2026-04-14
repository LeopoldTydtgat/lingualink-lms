// src/app/(dashboard)/messages/MessagesClient.tsx
'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import { createClient } from '@/lib/supabase/client'
import { sendMessage, markMessagesAsRead } from './actions'

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
}

interface Contact {
  id: string
  type: string
  name: string
  email: string
  photo_url: string | null
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
  initialContact?: Contact | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) {
    const h = date.getHours().toString().padStart(2, '0')
    const m = date.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
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
  initialContact = null,
}: MessagesClientProps) {
  const supabase = useMemo(() => createClient(), [])

  const [contacts, setContacts] = useState<Contact[]>(initialContacts)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sending, setSending] = useState(false)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [newMsgSearch, setNewMsgSearch] = useState('')
  const [, forceUpdate] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ url: string; filename: string; size: number }>>([])
  const [uploading, setUploading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchMessages = useCallback(async (contact: Contact) => {
    setLoadingMessages(true)
    const { data } = await supabase
      .from('messages')
      .select('*')
      .or(
        `and(sender_id.eq.${currentUser.id},receiver_id.eq.${contact.id}),` +
        `and(sender_id.eq.${contact.id},receiver_id.eq.${currentUser.id})`
      )
      .order('created_at', { ascending: true })

    setMessages(data || [])
    setLoadingMessages(false)
    await markMessagesAsRead(contact.id)
    setContacts(prev => prev.map(c => c.id === contact.id ? { ...c, unreadCount: 0 } : c))
  }, [supabase, currentUser.id])

  const handleSelectContact = useCallback(async (contact: Contact) => {
    setSelectedContact(contact)
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
        // which updates read_at. We listen for UPDATEs to reflect the double tick.
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
            setMessages(prev =>
              prev.map(m => m.id === updated.id ? { ...m, read_at: updated.read_at } : m)
            )
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedContact, currentUser.id, supabase])

  const handleSend = async () => {
    if (!editor || !selectedContact || sending) return
    const html = editor.getHTML()
    if (!html || html === '<p></p>') return

    setSending(true)

    const result = await sendMessage(
      selectedContact.id,
      selectedContact.type as 'teacher' | 'admin' | 'student',
      html,
      pendingAttachments.length > 0 ? pendingAttachments : undefined
    )

    if (result?.error) {
      console.error('Send failed:', result.error)
      setSending(false)
      return
    }

    const optimisticMsg: Message = {
      id: crypto.randomUUID(),
      sender_id: currentUser.id,
      sender_type: currentUser.role,
      receiver_id: selectedContact.id,
      receiver_type: selectedContact.type,
      content: html,
      attachments: pendingAttachments,
      read_at: null,
      created_at: new Date().toISOString(),
    }

    setMessages(prev => [...prev, optimisticMsg])
    setContacts(prev =>
      prev.map(c => c.id === selectedContact.id ? { ...c, latestMessage: optimisticMsg } : c)
    )
    editor.commands.clearContent()
    setPendingAttachments([])
    setSending(false)
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
        email: student.email,
        photo_url: student.photo_url,
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
      alert('File must be under 10MB.')
      e.target.value = ''
      return
    }

    setUploading(true)
    const form = new FormData()
    form.append('file', file)

    const res = await fetch('/api/messages/upload', { method: 'POST', body: form })
    const json = await res.json()

    if (!res.ok) {
      alert(json.error ?? 'Upload failed.')
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
              className="w-7 h-7 rounded-full flex items-center justify-center text-white text-lg leading-none"
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

        <div className="flex-1 overflow-y-auto">
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
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">Loading...</div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">No messages yet. Say hello!</div>
              ) : (
                messages.map((msg, index) => {
                  const isFromMe = msg.sender_id === currentUser.id
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
                          {/* Bubble
                              Sent:     #FF8303 orange, white text
                              Received: #1F2937 dark charcoal, white text
                              Two distinct colours = immediately obvious who said what */}
                          <div
                            className="message-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                            style={isFromMe
                              ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                              : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                            }
                            dangerouslySetInnerHTML={{ __html: msg.content }}
                          />
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className="mt-1 flex flex-col gap-1">
                              {msg.attachments.map((att: { url: string; filename: string; size: number }, i: number) => (
                                <a
                                  key={i}
                                  href={att.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 text-xs underline opacity-80 hover:opacity-100"
                                >
                                  📎 {att.filename}
                                </a>
                              ))}
                            </div>
                          )}
                          {/* Timestamp + read ticks row */}
                          <div className={`flex items-center gap-1 mt-1 ${isFromMe ? 'justify-end' : 'justify-start'}`}>
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
                which cannot be removed via Tailwind classes alone. */}
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
                  className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
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
            <div className="px-3 pb-4 max-h-72 overflow-y-auto">
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
