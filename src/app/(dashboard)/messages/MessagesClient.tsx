'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Formats a timestamp into a human-readable short string
function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

// Strips HTML tags for the contact list preview snippet
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').slice(0, 60)
}

// Returns initials avatar background — same orange as brand
function Avatar({ name, photoUrl, size = 10 }: { name: string; photoUrl: string | null; size?: number }) {
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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MessagesClient({ currentUser, contacts: initialContacts, allStudents }: MessagesClientProps) {
  const supabase = useMemo(() => createClient(), [])

  const [contacts, setContacts] = useState<Contact[]>(initialContacts)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sending, setSending] = useState(false)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [newMsgSearch, setNewMsgSearch] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Tiptap rich text editor
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Write a message...' }),
    ],
    content: '',
  })

  // Auto-scroll to the bottom whenever messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fetches the full conversation between current user and a contact
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

    // Mark incoming messages from this contact as read
    await markMessagesAsRead(contact.id)

    // Clear the unread badge locally
    setContacts(prev =>
      prev.map(c => c.id === contact.id ? { ...c, unreadCount: 0 } : c)
    )
  }, [supabase, currentUser.id])

  // Handles clicking a contact in the list
  const handleSelectContact = useCallback(async (contact: Contact) => {
    setSelectedContact(contact)
    await fetchMessages(contact)
  }, [fetchMessages])

  // Realtime subscription: listen for new incoming messages
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
          // Only append if the new message belongs to the open conversation
          if (newMsg.sender_id === selectedContact.id) {
            setMessages(prev => [...prev, newMsg])
            await markMessagesAsRead(selectedContact.id)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedContact, currentUser.id, supabase])

  // Sends the composed message
  const handleSend = async () => {
    if (!editor || !selectedContact || sending) return
    const html = editor.getHTML()
    if (!html || html === '<p></p>') return

    setSending(true)

    const result = await sendMessage(
      selectedContact.id,
      selectedContact.type as 'teacher' | 'admin' | 'student',
      html
    )

    if (result?.error) {
      console.error('Send failed:', result.error)
      setSending(false)
      return
    }

    // Optimistically add the sent message to the thread
    const optimisticMsg: Message = {
      id: crypto.randomUUID(),
      sender_id: currentUser.id,
      sender_type: currentUser.role,
      receiver_id: selectedContact.id,
      receiver_type: selectedContact.type,
      content: html,
      attachments: [],
      read_at: null,
      created_at: new Date().toISOString(),
    }

    setMessages(prev => [...prev, optimisticMsg])
    setContacts(prev =>
      prev.map(c =>
        c.id === selectedContact.id ? { ...c, latestMessage: optimisticMsg } : c
      )
    )

    editor.commands.clearContent()
    setSending(false)
  }

  // Starts a new conversation from the picker modal
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

  const filteredContacts = contacts.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const filteredStudents = allStudents.filter(s =>
    s.full_name.toLowerCase().includes(newMsgSearch.toLowerCase())
  )

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex bg-white rounded-lg border border-gray-200 overflow-hidden"
      style={{ height: 'calc(100vh - 120px)' }}>

      {/* ── Left panel: contacts list ── */}
      <div className="w-72 border-r border-gray-200 flex flex-col flex-shrink-0">

        {/* Header */}
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
            style={{ ['--tw-ring-color' as any]: '#FF8303' }}
          />
        </div>

        {/* Contacts */}
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
                {/* Avatar with unread badge */}
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

                {/* Name + preview */}
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
          /* Empty state */
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
                <div className="flex items-center justify-center h-full text-sm text-gray-400">
                  Loading...
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">
                  No messages yet. Say hello!
                </div>
              ) : (
                messages.map((msg, index) => {
                  const isFromMe = msg.sender_id === currentUser.id

                  // Show a date separator when the date changes between messages
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
                              weekday: 'long', day: 'numeric', month: 'long'
                            })}
                          </span>
                          <div className="flex-1 h-px bg-gray-100" />
                        </div>
                      )}

                      <div className={`flex ${isFromMe ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[72%]">
                          <div
                            className="px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                            style={isFromMe ? {
                              backgroundColor: '#FF8303',
                              color: 'white',
                              borderBottomRightRadius: '4px',
                            } : {
                              backgroundColor: '#F3F4F6',
                              color: '#111827',
                              borderBottomLeftRadius: '4px',
                            }}
                            // Safe: content comes from our own Tiptap editor
                            dangerouslySetInnerHTML={{ __html: msg.content }}
                          />
                          <p className={`text-xs text-gray-400 mt-1 ${isFromMe ? 'text-right' : 'text-left'}`}>
                            {formatTime(msg.created_at)}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              {/* Invisible div at the bottom — we scroll to this */}
              <div ref={messagesEndRef} />
            </div>

            {/* Message composer */}
            <div className="border-t border-gray-200 p-4 flex-shrink-0">
              {/* Toolbar */}
              <div className="flex items-center gap-1 mb-2">
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
                  className="px-2 py-1 text-xs rounded font-bold text-gray-600 hover:bg-gray-100"
                  style={editor?.isActive('bold') ? { backgroundColor: '#E5E7EB' } : {}}
                >
                  B
                </button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleItalic().run() }}
                  className="px-2 py-1 text-xs rounded italic text-gray-600 hover:bg-gray-100"
                  style={editor?.isActive('italic') ? { backgroundColor: '#E5E7EB' } : {}}
                >
                  I
                </button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBulletList().run() }}
                  className="px-2 py-1 text-xs rounded text-gray-600 hover:bg-gray-100"
                  style={editor?.isActive('bulletList') ? { backgroundColor: '#E5E7EB' } : {}}
                >
                  • List
                </button>
              </div>

              {/* Editor box */}
              {/* Editor box */}
<div
  className="border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 min-h-[72px] max-h-[140px] overflow-y-auto focus-within:border-orange-400 cursor-text"
  onClick={() => editor?.commands.focus()}
>
  <EditorContent editor={editor} />
</div>

              {/* Send row */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">
                  📎 File attachments — coming soon
                </span>
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