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

interface Teacher {
  id: string
  full_name: string
  email: string
  photo_url: string | null
  role: string
}

interface Student {
  id: string
  full_name: string
  email: string
  photo_url: string | null
}

interface Props {
  currentStudent: Student
  contacts: Contact[]
  assignedTeachers: Teacher[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
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

export default function StudentMessagesClient({ currentStudent, contacts: initialContacts, assignedTeachers }: Props) {
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
  const messagesEndRef = useRef<HTMLDivElement>(null)

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
        `and(sender_id.eq.${currentStudent.id},receiver_id.eq.${contact.id}),` +
        `and(sender_id.eq.${contact.id},receiver_id.eq.${currentStudent.id})`
      )
      .order('created_at', { ascending: true })

    setMessages(data || [])
    setLoadingMessages(false)
    await markMessagesAsRead(contact.id)
    setContacts(prev => prev.map(c => c.id === contact.id ? { ...c, unreadCount: 0 } : c))
  }, [supabase, currentStudent.id])

  const handleSelectContact = useCallback(async (contact: Contact) => {
    setSelectedContact(contact)
    await fetchMessages(contact)
  }, [fetchMessages])

  // Real-time: listen for new incoming messages
  useEffect(() => {
    if (!selectedContact) return

    const channel = supabase
      .channel(`student-inbox-${currentStudent.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentStudent.id}`,
        },
        async (payload) => {
          const newMsg = payload.new as Message
          if (newMsg.sender_id === selectedContact.id) {
            setMessages(prev => [...prev, newMsg])
            await markMessagesAsRead(selectedContact.id)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedContact, currentStudent.id, supabase])

  const handleSend = async () => {
    if (!editor || !selectedContact || sending) return
    const html = editor.getHTML()
    if (!html || html === '<p></p>') return

    setSending(true)

    const receiverType = selectedContact.type === 'admin' ? 'admin' : 'teacher'
    const result = await sendMessage(selectedContact.id, receiverType, html)

    if (result?.error) {
      console.error('Send failed:', result.error)
      setSending(false)
      return
    }

    const optimisticMsg: Message = {
      id: crypto.randomUUID(),
      sender_id: currentStudent.id,
      sender_type: 'student',
      receiver_id: selectedContact.id,
      receiver_type: receiverType,
      content: html,
      attachments: [],
      read_at: null,
      created_at: new Date().toISOString(),
    }

    setMessages(prev => [...prev, optimisticMsg])
    setContacts(prev =>
      prev.map(c => c.id === selectedContact.id ? { ...c, latestMessage: optimisticMsg } : c)
    )
    editor.commands.clearContent()
    setSending(false)
  }

  const handleStartConversation = (teacher: Teacher) => {
    const existing = contacts.find(c => c.id === teacher.id)
    if (existing) {
      handleSelectContact(existing)
    } else {
      const newContact: Contact = {
        id: teacher.id,
        type: teacher.role === 'admin' ? 'admin' : 'teacher',
        name: teacher.full_name,
        email: teacher.email,
        photo_url: teacher.photo_url,
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

  const filteredTeachers = assignedTeachers.filter(t =>
    t.full_name.toLowerCase().includes(newMsgSearch.toLowerCase())
  )

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="flex bg-white rounded-lg border border-gray-200 overflow-hidden"
      style={{ height: 'calc(100vh - 120px)' }}
    >
      {/* ── Left panel: contacts ── */}
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
                ? 'No conversations yet.\nClick + to message your teacher.'
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
                      {contact.latestMessage.sender_id === currentStudent.id ? 'You: ' : ''}
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
                <div className="flex items-center justify-center h-full text-sm text-gray-400">
                  No messages yet. Say hello!
                </div>
              ) : (
                messages.map((msg, index) => {
                  const isFromMe = msg.sender_id === currentStudent.id
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
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div className="border-t border-gray-200 p-4 flex-shrink-0">
              <div className="flex items-center gap-1 mb-2">
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
                  className="px-2 py-1 text-xs rounded font-bold text-gray-600 hover:bg-gray-100"
                  style={editor?.isActive('bold') ? { backgroundColor: '#E5E7EB' } : {}}
                >B</button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleItalic().run() }}
                  className="px-2 py-1 text-xs rounded italic text-gray-600 hover:bg-gray-100"
                  style={editor?.isActive('italic') ? { backgroundColor: '#E5E7EB' } : {}}
                >I</button>
                <button
                  onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleUnderline().run() }}
                  className="px-2 py-1 text-xs rounded underline text-gray-600 hover:bg-gray-100"
                  style={editor?.isActive('underline') ? { backgroundColor: '#E5E7EB' } : {}}
                >U</button>
              </div>
              <div
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 min-h-[72px] max-h-[140px] overflow-y-auto focus-within:border-orange-400 cursor-text"
                onClick={() => editor?.commands.focus()}
              >
                <EditorContent editor={editor} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">📎 File attachments — coming soon</span>
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
              <h2 className="text-sm font-semibold text-gray-900">Message Your Teacher</h2>
              <button
                onClick={() => { setShowNewMessage(false); setNewMsgSearch('') }}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
              >×</button>
            </div>
            <div className="px-5 pt-3 pb-2">
              <input
                type="text"
                placeholder="Search teachers..."
                value={newMsgSearch}
                onChange={e => setNewMsgSearch(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-400"
                autoFocus
              />
            </div>
            <div className="px-3 pb-4 max-h-72 overflow-y-auto">
              {filteredTeachers.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No teachers found</p>
              ) : (
                filteredTeachers.map(teacher => (
                  <button
                    key={teacher.id}
                    onClick={() => handleStartConversation(teacher)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 text-left transition-colors"
                  >
                    <Avatar name={teacher.full_name} photoUrl={teacher.photo_url} size={8} />
                    <div>
                      <p className="text-sm font-medium text-gray-900">{teacher.full_name}</p>
                      <p className="text-xs text-gray-400 capitalize">{teacher.role}</p>
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
