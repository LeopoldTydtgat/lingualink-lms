'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAdminThreadMessages, sendAdminMessage, markAdminThreadRead } from './actions'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminMessage {
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

interface AdminConversation {
  key: string
  teacherSideId: string
  teacherSideName: string
  teacherSidePhotoUrl: string | null
  studentId: string
  studentName: string
  studentPhotoUrl: string | null
  latestMessage: AdminMessage
  unreadCount: number
}

interface AdminProfile {
  id: string
  full_name: string
  photo_url: string | null
}

interface Props {
  currentAdmin: AdminProfile
  conversations: AdminConversation[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now  = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dateStart  = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays   = Math.round((todayStart - dateStart) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
  if (diffDays < 7) return DAYS[date.getDay()]
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
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
    return <img src={photoUrl} alt={name} className={`${sizeClass} rounded-full object-cover flex-shrink-0`} />
  }
  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0`}
      style={{ backgroundColor: '#FF8303', fontSize: size <= 6 ? '9px' : size <= 8 ? '11px' : '14px' }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminMessagesClient({
  currentAdmin,
  conversations: initialConversations,
}: Props) {
  const supabase = useMemo(() => createClient(), [])

  const [conversations, setConversations] = useState<AdminConversation[]>(initialConversations)
  const [selectedConv, setSelectedConv] = useState<AdminConversation | null>(null)
  const [messages, setMessages] = useState<AdminMessage[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [sending, setSending] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchMessages = useCallback(async (conv: AdminConversation) => {
    setLoadingMessages(true)
    const data = await getAdminThreadMessages(conv.teacherSideId, conv.studentId)
    setMessages(data as AdminMessage[])
    setLoadingMessages(false)
    await markAdminThreadRead(conv.teacherSideId, conv.studentId)
    setConversations(prev =>
      prev.map(c => c.key === conv.key ? { ...c, unreadCount: 0 } : c)
    )
  }, [])

  const handleSelectConv = useCallback(async (conv: AdminConversation) => {
    setSelectedConv(conv)
    setMessages([])
    setComposerText('')
    await fetchMessages(conv)
  }, [fetchMessages])

  // Realtime: listen for new INSERTs on messages, filter to current thread
  useEffect(() => {
    if (!selectedConv) return

    const channel = supabase
      .channel(`admin-thread-${selectedConv.teacherSideId}-${selectedConv.studentId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const newMsg = payload.new as AdminMessage
          const parties = new Set([selectedConv.teacherSideId, selectedConv.studentId])
          const isDirectExchange =
            parties.has(newMsg.sender_id) && parties.has(newMsg.receiver_id)
          const isAdminInterjection =
            newMsg.sender_type === 'admin' &&
            (newMsg.receiver_id === selectedConv.studentId ||
             newMsg.receiver_id === selectedConv.teacherSideId)

          if (isDirectExchange || isAdminInterjection) {
            setMessages(prev => {
              if (prev.some(m => m.id === newMsg.id)) return prev
              return [...prev, newMsg]
            })
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedConv, supabase])

  const handleSend = async () => {
    if (!selectedConv || !composerText.trim() || sending) return
    setSending(true)

    const result = await sendAdminMessage(
      selectedConv.teacherSideId,
      selectedConv.studentId,
      composerText.trim()
    )

    if (result?.error) {
      console.error('Send failed:', result.error)
      setSending(false)
      return
    }

    // Optimistic message — content will be overwritten by realtime with proper HTML
    const htmlContent = composerText
      .trim()
      .split('\n')
      .map(line => `<p>${line || '<br>'}</p>`)
      .join('')

    const optimistic: AdminMessage = {
      id: crypto.randomUUID(),
      sender_id: currentAdmin.id,
      sender_type: 'admin',
      receiver_id: selectedConv.studentId,
      receiver_type: 'student',
      content: htmlContent,
      attachments: [],
      read_at: null,
      created_at: new Date().toISOString(),
    }

    setMessages(prev => [...prev, optimistic])
    setConversations(prev =>
      prev.map(c => c.key === selectedConv.key
        ? { ...c, latestMessage: optimistic }
        : c
      )
    )
    setComposerText('')
    setSending(false)
    textareaRef.current?.focus()
  }

  const filteredConversations = conversations.filter(conv =>
    conv.teacherSideName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    conv.studentName.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="flex bg-white rounded-lg border border-gray-200 overflow-hidden"
      style={{ height: 'calc(100vh - 120px)' }}
    >
      {/* ── Left panel: conversation list ── */}
      <div className="w-72 border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-base font-semibold text-gray-900 mb-3">Messages</h1>
          <input
            type="text"
            placeholder="Search by teacher or student..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">
              {conversations.length === 0
                ? 'No conversations yet.'
                : 'No conversations match your search.'}
            </div>
          ) : (
            filteredConversations.map(conv => (
              <button
                key={conv.key}
                onClick={() => handleSelectConv(conv)}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50"
                style={selectedConv?.key === conv.key ? { backgroundColor: '#FFF3E0' } : {}}
              >
                {/* Overlapping avatars */}
                <div className="relative flex-shrink-0" style={{ width: '40px', height: '40px' }}>
                  <div className="absolute top-0 left-0">
                    <Avatar name={conv.teacherSideName} photoUrl={conv.teacherSidePhotoUrl} size={8} />
                  </div>
                  <div className="absolute bottom-0 right-0 ring-2 ring-white rounded-full">
                    <Avatar name={conv.studentName} photoUrl={conv.studentPhotoUrl} size={5} />
                  </div>
                  {conv.unreadCount > 0 && (
                    <span
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-white font-bold"
                      style={{ backgroundColor: '#FF8303', fontSize: '10px' }}
                    >
                      {conv.unreadCount > 9 ? '9+' : conv.unreadCount}
                    </span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className="text-sm truncate"
                      style={{ fontWeight: conv.unreadCount > 0 ? 600 : 500, color: conv.unreadCount > 0 ? '#111827' : '#374151' }}
                    >
                      {conv.teacherSideName} → {conv.studentName}
                    </span>
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {formatTime(conv.latestMessage.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {stripHtml(conv.latestMessage.content)}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: thread + composer ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-5xl mb-3">💬</div>
              <p className="text-sm">Select a conversation to view messages</p>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="px-5 py-3.5 border-b border-gray-200 flex items-center gap-3 flex-shrink-0">
              <Avatar name={selectedConv.teacherSideName} photoUrl={selectedConv.teacherSidePhotoUrl} size={9} />
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                style={{ backgroundColor: '#d1d5db', color: '#374151' }}
              >
                →
              </div>
              <Avatar name={selectedConv.studentName} photoUrl={selectedConv.studentPhotoUrl} size={9} />
              <div className="ml-1">
                <p className="text-sm font-semibold text-gray-900">
                  {selectedConv.teacherSideName} → {selectedConv.studentName}
                </p>
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
                  No messages in this thread yet.
                </div>
              ) : (
                messages.map((msg, index) => {
                  const isStudent = msg.sender_type === 'student'
                  const isAdmin   = msg.sender_type === 'admin'
                  const isRight   = isStudent || isAdmin

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

                      <div className={`flex ${isRight ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[72%]">
                          {/* Colour key:
                              teacher = dark charcoal (#1F2937), left-aligned
                              student = orange (#FF8303), right-aligned
                              admin   = slate (#374151), right-aligned */}
                          <div
                            className="px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                            style={
                              isStudent
                                ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                                : isAdmin
                                ? { backgroundColor: '#374151', color: 'white', borderBottomRightRadius: '4px' }
                                : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                            }
                            dangerouslySetInnerHTML={{ __html: msg.content }}
                          />
                          <div className={`flex items-center gap-1 mt-1 ${isRight ? 'justify-end' : 'justify-start'}`}>
                            <span className="text-xs text-gray-400">
                              {formatTime(msg.created_at)}
                            </span>
                            {isAdmin && (
                              <span className="text-xs text-gray-400">· Admin</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Composer ── */}
            <div className="border-t border-gray-200 p-4 flex-shrink-0 bg-white">
              <div className="flex gap-3 items-end">
                <textarea
                  ref={textareaRef}
                  value={composerText}
                  onChange={e => setComposerText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  placeholder="Write a message… (Enter to send, Shift+Enter for new line)"
                  rows={2}
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:border-orange-300 transition-colors"
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !composerText.trim()}
                  className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-opacity flex-shrink-0"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
