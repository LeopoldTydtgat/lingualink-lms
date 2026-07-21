'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { sanitizeHtml } from '@/lib/sanitize'
import { isEmojiOnly } from '@/lib/messages/isEmojiOnly'
import { messageAttachmentHref } from '@/lib/messages/attachmentHref'
import ReadTicks from '@/components/messages/ReadTicks'
import { getAdminThreadMessages, markAdminThreadRead } from './actions'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminMessage {
  id: string
  sender_id: string
  sender_type: string
  receiver_id: string
  receiver_type: string
  content: string
  attachments: Array<{ url: string; filename: string; size: number }>
  read_at: string | null
  admin_read_at: string | null
  created_at: string
  edited_at?: string | null
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

// Sizing is inline, not `w-${size}` Tailwind classes: Tailwind v4 never emits CSS for
// a dynamically constructed class name, so the interpolated version renders unsized
// avatars. Same pattern as AdminSupportClient. The font-size tiers stay because this
// page renders avatars as small as size 5 in the overlapping pair.
function Avatar({ name, photoUrl, size = 10 }: {
  name: string
  photoUrl: string | null
  size?: number
}) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size * 4, height: size * 4 }}
      />
    )
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0"
      style={{
        width: size * 4,
        height: size * 4,
        backgroundColor: '#FF8303',
        fontSize: size <= 6 ? '9px' : size <= 8 ? '11px' : '14px',
      }}
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
  const [messagesError, setMessagesError] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchMessages = useCallback(async (conv: AdminConversation) => {
    setLoadingMessages(true)
    setMessagesError(false)
    let loadedOk = false
    try {
      const data = await getAdminThreadMessages(conv.teacherSideId, conv.studentId)
      setMessages(data as AdminMessage[])
      loadedOk = true
    } catch {
      setMessages([])
      setMessagesError(true)
    } finally {
      setLoadingMessages(false)
    }

    if (!loadedOk) return

    // Read-marking is best-effort bookkeeping; if it fails the messages that
    // already loaded successfully must stay on screen, so the failure is
    // tolerated silently rather than surfaced.
    try {
      await markAdminThreadRead(conv.teacherSideId, conv.studentId)
      setConversations(prev =>
        prev.map(c => c.key === conv.key ? { ...c, unreadCount: 0 } : c)
      )
    } catch {}
  }, [])

  const handleSelectConv = useCallback(async (conv: AdminConversation) => {
    setSelectedConv(conv)
    setMessages([])
    await fetchMessages(conv)
  }, [fetchMessages])

  // Realtime: listen for new INSERTs on messages, scoped to the current thread.
  // Two server-side filters cover both directions of the direct exchange; the third
  // (sender_type=eq.admin) now has no in-app producer and is retained defensively.
  // The client-side check below is kept as defense-in-depth.
  useEffect(() => {
    if (!selectedConv) return

    const parties = new Set([selectedConv.teacherSideId, selectedConv.studentId])

    const handleInsert = (payload: { new: { [key: string]: any } }) => {
      const newMsg = payload.new as AdminMessage
      const isDirectExchange =
        parties.has(newMsg.sender_id) && parties.has(newMsg.receiver_id)
      // Defensive only: no in-app producer inserts sender_type='admin' any more
      // (/admin/messages is view-only). Historical admin rows reach the thread via
      // getAdminThreadMessages, not this branch — an INSERT event never fires for
      // rows that already exist. Kept to catch an out-of-band insert.
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

    // UPDATE carries two things this read-only viewer cares about: the counterpart's
    // read receipt (read_at → double tick) and an in-window edit (content + edited_at).
    // Filters mirror the INSERT subscriptions so an UPDATE in some unrelated thread
    // never reaches this handler.
    const handleUpdate = (payload: { new: AdminMessage }) => {
      const updated = payload.new
      // Return prev UNCHANGED (same array reference) when no message matches — an
      // UPDATE outside the open thread must not re-fire the scroll-to-bottom effect,
      // which keys on the messages array identity.
      setMessages(prev => {
        if (!prev.some(m => m.id === updated.id)) return prev
        // Non-regressing merge: a payload that omits a field (or arrives before the
        // other field is set — e.g. an edit UPDATE on a still-unread message) must
        // never null out what is already on screen. admin_read_at is deliberately not
        // merged: the browser role holds no column grant on it, so it never arrives.
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

    const channel = supabase
      .channel(`admin-thread-${selectedConv.teacherSideId}-${selectedConv.studentId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${selectedConv.teacherSideId}` },
        handleInsert
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${selectedConv.studentId}` },
        handleInsert
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: 'sender_type=eq.admin' },
        handleInsert
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${selectedConv.teacherSideId}` },
        handleUpdate
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${selectedConv.studentId}` },
        handleUpdate
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'sender_type=eq.admin' },
        handleUpdate
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedConv, supabase])

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
      {/* Bubble list styling. The teacher inbox carries these rules on its composer
          block; this viewer has no composer, so they mount unconditionally here or
          bulleted/numbered message content renders unstyled. */}
      <style>{`
        .message-bubble ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
        .message-bubble ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
        .message-bubble li { margin: 0.1rem 0; }
      `}</style>

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

        <div className="flex-1 overflow-y-auto thin-scroll">
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
                disabled={loadingMessages}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
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

      {/* ── Right panel: thread (read-only) ── */}
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
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 thin-scroll" style={{ backgroundColor: '#FFF9F3' }}>
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">
                  Loading...
                </div>
              ) : messagesError ? (
                <div className="flex items-center justify-center h-full">
                  <div
                    className="text-sm text-center px-4 py-3 rounded-lg"
                    style={{ borderLeft: '3px solid #FD5602', backgroundColor: '#FFEEE6', color: '#FD5602' }}
                  >
                    Couldn&apos;t load messages for this conversation. Try selecting it again.
                  </div>
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
                  const emojiOnly = isEmojiOnly(msg.content)
                  const hasContent = msg.content.replace(/<[^>]*>/g, '').trim().length > 0 || emojiOnly
                  // Right-aligned, non-emoji, non-empty messages carry their read ticks
                  // inside the bubble (WhatsApp pattern) instead of the metadata row.
                  const isBubbleTicked = isRight && hasContent && !emojiOnly

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
                          {/* Three-way sender mapping (the admin views someone else's thread,
                              so "sent" here means the student side, not the viewer):
                                teacher = LEFT,  received style — #ffffff fill, #1f2937 text,
                                                 1px solid #f3f4f6 border, 4px bottom-left radius
                                student = RIGHT, sent style — #1f2937 fill, #f9fafb text,
                                                 4px bottom-right radius
                                admin   = RIGHT, same sent style, distinguished by the small
                                                 "Admin" label above the bubble
                              NEW302: hide the bubble entirely for an attachment-only
                              (empty-content) message so it doesn't render a blank box. */}
                          {isAdmin && (
                            <div className="text-[10px] text-gray-400 text-right mb-0.5">Admin</div>
                          )}
                          {hasContent && (
                          isBubbleTicked ? (
                            <div
                              className="message-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed inline-flex items-end"
                              style={{ backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }}
                            >
                              <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }} />
                              <ReadTicks readAt={msg.read_at} variant="bubble" className="self-end ml-1" />
                            </div>
                          ) : (
                            <div
                              className="message-bubble px-4 py-2.5 rounded-2xl text-sm leading-relaxed"
                              style={emojiOnly
                                ? { fontSize: '2rem', background: 'none', padding: '4px 8px' }
                                : isRight
                                ? { backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }
                                : { backgroundColor: '#ffffff', color: '#1f2937', border: '1px solid #f3f4f6', borderBottomLeftRadius: '4px' }
                              }
                              dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }}
                            />
                          )
                          )}
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className={`${hasContent ? 'mt-1' : ''} flex flex-col gap-1`}>
                              {msg.attachments.map((att, i) => (
                                <a
                                  key={i}
                                  href={messageAttachmentHref('message', msg.id, i, att.url)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 text-xs underline opacity-80 hover:opacity-100"
                                  style={{ color: '#4b5563' }}
                                >
                                  📎 {att.filename}
                                </a>
                              ))}
                            </div>
                          )}
                          {/* Timestamp + read ticks row. Ticks render for every message,
                              not just admin ones — the admin is an observer, so both
                              sides' read state is information they need. */}
                          <div className={`flex items-center gap-1 mt-0.5 ${isRight ? 'justify-end' : 'justify-start'}`}>
                            {msg.edited_at && (
                              <span className="text-gray-400 italic" style={{ fontSize: '11px' }}>(edited)</span>
                            )}
                            <span className="text-gray-400" style={{ fontSize: '11px' }}>
                              {formatTime(msg.created_at)}
                            </span>
                            {!isBubbleTicked && <ReadTicks readAt={msg.read_at} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Read-only footer (no composer by design) ── */}
            <div style={{
              padding: '16px',
              textAlign: 'center',
              color: '#9ca3af',
              fontSize: '13px',
              borderTop: '1px solid #e5e7eb',
              backgroundColor: '#f9fafb'
            }}>
              This is a read-only view of the conversation between {selectedConv.teacherSideName} and {selectedConv.studentName}.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
