'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import { createClient } from '@/lib/supabase/client'
import { X, Send, ChevronDown, ChevronUp, MessageSquare, HelpCircle, Paperclip } from 'lucide-react'
import dynamic from 'next/dynamic'
import data from '@emoji-mart/data'
import { sanitizeHtml } from '@/lib/sanitize'
import { isEmojiOnly } from '@/lib/messages/isEmojiOnly'
import { messageAttachmentHref } from '@/lib/messages/attachmentHref'
import { EDIT_WINDOW_ERROR, isWithinEditWindow } from '@/lib/messages/editWindow'
import ReadTicks from '@/components/messages/ReadTicks'
import { toast } from 'sonner'

const EmojiPicker = dynamic(() => import('@emoji-mart/react'), { ssr: false })

// ── Types ─────────────────────────────────────────────────────────────────────

interface SupportMessage {
  id: string
  sender_role: 'user' | 'admin'
  content: string
  attachments: Array<{ url: string; filename: string; size: number }>
  created_at: string
  read_at: string | null
  edited_at?: string | null
  // Client-only: set on the optimistic temp row until the temp-to-real swap in
  // handleSend replaces it. Never persisted; a real DB row never carries it.
  pending?: boolean
}

interface FaqItem {
  id: string
  question: string
  answer: string
}

interface ChatWidgetProps {
  // The logged-in user's profile/student ID (used as participant_id)
  participantId: string
  // Whether this is the teacher or student portal
  participantType: 'teacher' | 'student'
  // The auth.uid() of the logged-in user — used for RLS filtering
  participantAuthId: string
  adminName?: string
  adminPhotoUrl?: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  return `${h}:${m}`
}

// Brand icon used as the default support avatar. Avatar gates its special
// contain/padding treatment on this exact path so real photos keep object-cover.
const BRAND_CHAT_ICON = '/lingualink-chat-icon.svg'

function Avatar({ name, photoUrl, size = 10 }: {
  name: string
  photoUrl?: string | null
  size?: number
}) {
  if (photoUrl) {
    const isBrandIcon = photoUrl === BRAND_CHAT_ICON
    return (
      <img
        src={photoUrl}
        alt={name}
        className={`rounded-full flex-shrink-0 ${isBrandIcon ? 'object-contain' : 'object-cover'}`}
        style={{
          width: size * 4,
          height: size * 4,
          ...(isBrandIcon ? { padding: size <= 8 ? 3 : 4, backgroundColor: '#FF8303' } : {}),
        }}
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
        fontSize: size <= 8 ? '11px' : '13px',
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function FaqAccordion({ faqs }: { faqs: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  return (
    <div className="divide-y divide-gray-100">
      {faqs.map((faq, index) => (
        <div key={faq.id}>
          <button
            onClick={() => setOpenIndex(openIndex === index ? null : index)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
          >
            <span className="text-sm font-medium text-gray-800 pr-3 leading-snug">
              {faq.question}
            </span>
            {openIndex === index
              ? <ChevronUp size={15} className="text-gray-400 flex-shrink-0" />
              : <ChevronDown size={15} className="text-gray-400 flex-shrink-0" />
            }
          </button>
          {openIndex === index && (
            <div className="px-4 pb-3">
              <p className="text-sm text-gray-500 leading-relaxed">{faq.answer}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ChatWidget({
  participantId,
  participantType,
  participantAuthId,
  adminName = 'LinguaLink Support',
  adminPhotoUrl = BRAND_CHAT_ICON,
}: ChatWidgetProps) {
  const supabase = useMemo(() => createClient(), [])

  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'messages' | 'faq'>('faq')
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [faqs, setFaqs] = useState<FaqItem[]>([])
  const [sending, setSending] = useState(false)
  const [messagesLoaded, setMessagesLoaded] = useState(false)
  const [faqsLoaded, setFaqsLoaded] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ url: string; filename: string; size: number }>>([])
  const [uploading, setUploading] = useState(false)
  const [, forceUpdate] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ bottom: number; right: number } | null>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  // NEW300: buffers read_at values that arrive via Realtime UPDATE before handleSend has
  // swapped the temp message for the real DB row, so the read tick isn't stomped back to null.
  const pendingReadsRef = useRef<Map<string, string>>(new Map())
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ underline: false }),
      Underline,
      Placeholder.configure({ placeholder: 'Type a message...' }),
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

  // On mount: check for unread admin messages to show badge on bubble
  useEffect(() => {
    const checkUnread = async () => {
      const { count } = await supabase
        .from('support_messages')
        .select('*', { count: 'exact', head: true })
        .eq('participant_auth_id', participantAuthId)
        .eq('sender_role', 'admin')
        .is('read_at', null)
      setUnreadCount(count ?? 0)
    }
    checkUnread()
  }, [supabase, participantAuthId])

  // FAQ is the default landing tab, but unread admin replies take priority:
  // land on Messages so they are seen and marked read.
  useEffect(() => {
    if (isOpen && unreadCount > 0) {
      setActiveTab('messages')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // NEW300: mark all inbound admin messages read. Reusable so it can fire both on load and
  // when an admin reply arrives live (previously reads only happened inside loadMessages, so
  // a live-arriving reply never flipped the admin's tick because no UPDATE ever fired).
  const markAdminMessagesRead = useCallback(async () => {
    await supabase
      .from('support_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('participant_auth_id', participantAuthId)
      .eq('sender_role', 'admin')
      .is('read_at', null)
    setUnreadCount(0)
  }, [supabase, participantAuthId])

  // Load support messages for this participant
  const loadMessages = useCallback(async () => {
    if (messagesLoaded) return
    const { data } = await supabase
      .from('support_messages')
      .select('id, sender_role, content, attachments, created_at, read_at, edited_at')
      .eq('participant_auth_id', participantAuthId)
      .order('created_at', { ascending: true })
    setMessages((data as SupportMessage[]) || [])
    setMessagesLoaded(true)
    setEditingMessageId(null)

    // Mark admin messages as read now that the teacher has opened the widget
    await markAdminMessagesRead()
  }, [supabase, participantAuthId, messagesLoaded, markAdminMessagesRead])

  // Load FAQs for this portal type
  const loadFaqs = useCallback(async () => {
    if (faqsLoaded) return
    const { data } = await supabase
      .from('faqs')
      .select('id, question, answer, display_order')
      .in('target_audience', [participantType, 'both'])
      .eq('is_active', true)
      .order('display_order', { ascending: true })
    setFaqs((data as FaqItem[]) || [])
    setFaqsLoaded(true)
  }, [supabase, participantType, faqsLoaded])

  useEffect(() => {
    if (!isOpen) return
    if (activeTab === 'messages') {
      loadMessages()
      // NEW300: loadMessages early-returns once loaded, so unread admin replies that arrived
      // while on the FAQ tab would never be marked. Mark unconditionally on entering Messages.
      markAdminMessagesRead()
      setTimeout(() => editor?.commands.focus(), 100)
    }
    if (activeTab === 'faq') {
      loadFaqs()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeTab, loadMessages, loadFaqs, markAdminMessagesRead])

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

  // Real-time: new messages on this participant's thread
  useEffect(() => {
    const channel = supabase
      .channel(`support-${participantAuthId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'support_messages',
          filter: `participant_auth_id=eq.${participantAuthId}`,
        },
        (payload) => {
          const msg = payload.new as SupportMessage
          setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev
            return [...prev, msg]
          })
          // NEW300: an admin reply arriving live must be marked read so its tick flips for the
          // admin — but only if the user is actually looking at the Messages tab. On the FAQ
          // tab, leave it unread and bump the badge instead.
          if (msg.sender_role === 'admin') {
            if (isOpen && activeTab === 'messages') {
              markAdminMessagesRead()
            } else {
              setUnreadCount(c => c + 1)
            }
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'support_messages',
          filter: `participant_auth_id=eq.${participantAuthId}`,
        },
        (payload) => {
          const updated = payload.new as SupportMessage
          // Update read_at on the matching message so ticks flip live. Buffer the read_at first
          // (NEW300) so a temp→real swap in handleSend can carry it over instead of losing it.
          // The same events also carry edits (content + edited_at) from either side, so patch
          // those too — read_at never regresses to null here because an edit UPDATE on an
          // unread message arrives with read_at still null.
          if (updated.read_at) {
            pendingReadsRef.current.set(updated.id, updated.read_at)
          }
          // Return prev UNCHANGED (same array reference) when no message matches
          // (e.g. the temp row hasn't been swapped for the real id yet - the
          // buffered read above still covers that) so an unrelated UPDATE doesn't
          // re-fire the scroll-to-bottom effect, which keys on array identity.
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
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [isOpen, participantAuthId, supabase, activeTab, markAdminMessagesRead])

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

  const handleSend = async () => {
    if (!editor || sending) return
    const html = editor.getHTML()
    // Treat tag-only / whitespace-only HTML as empty (emoji-only still counts as content).
    const isEmpty = !html || (html.replace(/<[^>]*>/g, '').trim().length === 0 && !isEmojiOnly(html))
    if (isEmpty && pendingAttachments.length === 0) return
    const attachmentsToSend = pendingAttachments
    // Attachment-only send: store clean '' rather than '<p></p>'.
    const contentToSend = isEmpty ? '' : html
    editor.commands.clearContent()
    setPendingAttachments([])
    setSending(true)

    // Optimistic update - pending until the temp-to-real swap below, so the Edit
    // affordance never targets a row whose id doesn't exist in the DB.
    const tempId = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id: tempId,
      sender_role: 'user',
      content: contentToSend,
      attachments: attachmentsToSend,
      created_at: new Date().toISOString(),
      read_at: null,
      pending: true,
    }])

    const res = await fetch('/api/support/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId,
        participantType,
        participantAuthId,
        content: contentToSend,
        attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
      }),
    })

    if (!res.ok) {
      // Roll back optimistic update on failure. Restore the pending attachments so a
      // failed send doesn't silently discard the user's already-uploaded file, and
      // surface an error instead of failing quietly.
      setMessages(prev => prev.filter(m => m.id !== tempId))
      setPendingAttachments(attachmentsToSend)
      toast.error('Message failed to send. Please try again.', { duration: 6000 })
    } else {
      // Replace temp message with real DB message so read_at updates work
      const data = await res.json()
      if (data.message) {
        // NEW300: if the admin already read this message before the real row landed, the
        // Realtime UPDATE buffered its read_at here — carry it over instead of hardcoding null
        // (which stomped the read tick). Otherwise honour the DB row's own read_at.
        const real = data.message as SupportMessage
        const bufferedRead = pendingReadsRef.current.get(real.id)
        if (bufferedRead) {
          real.read_at = bufferedRead
          pendingReadsRef.current.delete(real.id)
        }
        setMessages(prev =>
          prev.map(m => m.id === tempId ? real : m)
        )
      }
    }

    setSending(false)
  }

  const handleStartEdit = (msg: SupportMessage) => {
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
    const res = await fetch('/api/support/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: editingMessageId, content: contentToSave }),
    })

    if (!res.ok) {
      // Surface the window rejection verbatim (retrying can't help there);
      // everything else stays generic.
      const json = await res.json().catch(() => null)
      toast.error(
        json?.error === EDIT_WINDOW_ERROR ? EDIT_WINDOW_ERROR : 'Edit failed to save. Please try again.',
        { duration: 6000 }
      )
    } else {
      const json = await res.json()
      if (json.message) {
        const updated = json.message as SupportMessage
        setMessages(prev =>
          prev.map(m => m.id === updated.id
            ? { ...m, content: updated.content, edited_at: updated.edited_at }
            : m)
        )
      }
      setEditingMessageId(null)
      editEditor.commands.clearContent()
    }
    setSavingEdit(false)
  }

  const handleEmojiButtonClick = () => {
    if (!showEmojiPicker && emojiButtonRef.current) {
      const rect = emojiButtonRef.current.getBoundingClientRect()
      setEmojiPickerPos({
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
      })
    }
    setShowEmojiPicker(v => !v)
  }

  const tabStyle = (tab: 'messages' | 'faq') =>
    activeTab === tab
      ? { backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FFD9A8', borderRadius: '6px' }
      : { color: '#6b7280', border: '1px solid transparent', borderRadius: '6px' }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">

      {isOpen && (
        <div
          className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          style={{ width: '360px', height: '520px', border: '1px solid #f3f4f6' }}
        >
          {/* Header */}
          <div className="px-4 pt-4 pb-0 flex-shrink-0" style={{ backgroundColor: '#ffffff', borderTop: '3px solid #FF8303', borderBottom: '1px solid #E0DFDC' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Avatar name={adminName} photoUrl={adminPhotoUrl} size={9} />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-white -ml-4 mt-4 flex-shrink-0" />
              </div>
              <button
                onClick={() => { setIsOpen(false); setMessagesLoaded(false) }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Close chat"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-gray-900 font-semibold text-sm mb-0.5">Questions? Chat with us.</p>
            <p className="text-gray-500 text-xs mb-3">We typically reply within an hour.</p>
            <div className="flex gap-1 pb-3">
              <button
                onClick={() => setActiveTab('faq')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all"
                style={tabStyle('faq')}
              >
                <HelpCircle size={13} />
                FAQ
              </button>
              <button
                onClick={() => setActiveTab('messages')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all"
                style={tabStyle('messages')}
              >
                <MessageSquare size={13} />
                Messages
              </button>
            </div>
          </div>

          {/* Messages tab */}
          {activeTab === 'messages' && (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 thin-scroll" style={{ backgroundColor: '#FFF9F3' }}>
                {!messagesLoaded ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-xs text-gray-400">Loading...</p>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-4">
                    <p className="text-sm font-medium text-gray-700 mb-1">How can we help?</p>
                    <p className="text-xs text-gray-400">Send a message and we&apos;ll get back to you shortly.</p>
                  </div>
                ) : (
                  messages.map(msg => {
                    const isFromMe = msg.sender_role === 'user'
                    const hasContent = msg.content.replace(/<[^>]*>/g, '').trim().length > 0 || isEmojiOnly(msg.content)
                    const isBubbleTicked = isFromMe && hasContent && !isEmojiOnly(msg.content)
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isFromMe ? 'justify-end' : 'justify-start'} items-end gap-2`}
                      >
                        {!isFromMe && (
                          <Avatar name={adminName} photoUrl={adminPhotoUrl} size={7} />
                        )}
                        <div className="max-w-[75%]">
                          {editingMessageId === msg.id ? (
                            /* Inline edit box replaces the bubble; attachments are never
                               modified by an edit and reappear on save/cancel. */
                            <div className="rounded-2xl border border-gray-200 bg-white px-3 py-2" style={{ minWidth: '180px' }}>
                              <div
                                className="widget-composer text-sm min-h-[32px] max-h-[80px] overflow-y-auto cursor-text"
                                onClick={() => editEditor?.commands.focus()}
                              >
                                <EditorContent editor={editEditor} />
                              </div>
                              <div className="flex items-center justify-end gap-2 mt-2">
                                <button
                                  onClick={handleCancelEdit}
                                  className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-600 border border-gray-200 hover:bg-gray-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={handleSaveEdit}
                                  disabled={savingEdit}
                                  className="px-2.5 py-1 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                                  style={{ backgroundColor: '#FF8303' }}
                                >
                                  {savingEdit ? 'Saving...' : 'Save'}
                                </button>
                              </div>
                            </div>
                          ) : (
                          <>
                          {hasContent && (
                            isBubbleTicked ? (
                              <div
                                className="widget-bubble px-3 py-2 rounded-2xl text-sm leading-relaxed inline-flex items-end"
                                style={{ backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }}
                              >
                                <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }} />
                                <ReadTicks readAt={msg.read_at} variant="bubble" className="self-end ml-1" />
                              </div>
                            ) : (
                              <div
                                className="widget-bubble px-3 py-2 rounded-2xl text-sm leading-relaxed"
                                style={isEmojiOnly(msg.content)
                                  ? { fontSize: '2rem', background: 'none', padding: '4px 8px' }
                                  : isFromMe
                                  ? { backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }
                                  : { backgroundColor: '#ffffff', color: '#1f2937', border: '1px solid #f3f4f6', borderBottomLeftRadius: '4px' }
                                }
                                dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }}
                              />
                            )
                          )}
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className={`flex flex-col gap-0.5 ${hasContent ? 'mt-1' : ''} ${isFromMe ? 'items-end' : 'items-start'}`}>
                              {msg.attachments.map((att, i) => (
                                <a
                                  key={i}
                                  href={messageAttachmentHref('support', msg.id, i, att.url, msg.pending)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-xs underline max-w-full"
                                  style={{ color: '#4b5563' }}
                                >
                                  <span className="truncate">📎 {att.filename}</span>
                                </a>
                              ))}
                            </div>
                          )}
                          </>
                          )}
                          <div className={`flex items-center gap-1 mt-0.5 ${isFromMe ? 'justify-end' : 'justify-start'}`}>
                            {/* Edit affordance: own messages only, within the 15-minute
                                window (server re-checks authoritatively), never on a
                                pending optimistic row. */}
                            {isFromMe && editingMessageId !== msg.id &&
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
                            <span className="text-xs text-gray-400">{formatTime(msg.created_at)}</span>
                            {isFromMe && !isBubbleTicked && <ReadTicks readAt={msg.read_at} />}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="border-t border-gray-200 flex-shrink-0 bg-white">
                <style>{`
                  .widget-composer .ProseMirror { outline: none !important; border: none !important; box-shadow: none !important; }
                  .widget-composer .ProseMirror:focus { outline: none !important; border: none !important; }
                  .widget-composer .ProseMirror p.is-editor-empty:first-child::before { color: #9ca3af; content: attr(data-placeholder); float: left; height: 0; pointer-events: none; }
                  .widget-composer .ProseMirror ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
                  .widget-composer .ProseMirror ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
                  .widget-composer .ProseMirror li { margin: 0.1rem 0; }
                  .widget-bubble ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
                  .widget-bubble ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
                  .widget-bubble li { margin: 0.1rem 0; }
                `}</style>
                <div className="flex items-center gap-1 px-3 pt-2 pb-1">
                  <button
                    onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
                    className="px-2 py-0.5 text-xs rounded font-bold text-gray-500 hover:bg-gray-100"
                    style={editor?.isActive('bold') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                  >B</button>
                  <button
                    onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleItalic().run() }}
                    className="px-2 py-0.5 text-xs rounded italic text-gray-500 hover:bg-gray-100"
                    style={editor?.isActive('italic') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                  >I</button>
                  <button
                    onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleUnderline().run() }}
                    className="px-2 py-0.5 text-xs rounded underline text-gray-500 hover:bg-gray-100"
                    style={editor?.isActive('underline') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                  >U</button>
                  <button
                    onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBulletList().run() }}
                    className="px-2 py-0.5 text-xs rounded text-gray-500 hover:bg-gray-100"
                    style={editor?.isActive('bulletList') ? { backgroundColor: '#E5E7EB', color: '#111827' } : {}}
                  >•≡</button>
                  <div style={{ position: 'relative', display: 'inline-block' }} ref={emojiPickerRef}>
                    <button ref={emojiButtonRef} onClick={handleEmojiButtonClick} title="Emoji" style={{ padding: '2px 6px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>😊</button>
                    {showEmojiPicker && emojiPickerPos && (
                      <div style={{ position: 'fixed', bottom: emojiPickerPos.bottom, right: emojiPickerPos.right, zIndex: 9999 }}>
                        <EmojiPicker data={data} onEmojiSelect={(emoji: { native: string }) => { editor?.commands.insertContent(emoji.native); setShowEmojiPicker(false) }} theme="light" />
                      </div>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title="Attach file"
                    aria-label="Attach file"
                    className="px-2 py-0.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                  >
                    <Paperclip size={15} className={uploading ? 'animate-pulse' : ''} />
                  </button>
                </div>
                {pendingAttachments.length > 0 && (
                  <div className="px-3 pb-1 flex flex-col gap-1">
                    {pendingAttachments.map((att, i) => (
                      <div key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-600">
                        <span className="truncate max-w-[240px]">📎 {att.filename}</span>
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
                <div className="flex items-center gap-2 px-3 pb-3">
                  <div
                    className="widget-composer flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus-within:border-orange-400 bg-gray-50 min-h-[36px] max-h-[80px] overflow-y-auto cursor-text transition-colors"
                    onClick={() => editor?.commands.focus()}
                  >
                    <EditorContent editor={editor} />
                  </div>
                  <button
                    onClick={handleSend}
                    disabled={sending}
                    className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-opacity disabled:opacity-40"
                    style={{ backgroundColor: '#FF8303' }}
                    aria-label="Send message"
                  >
                    <Send size={15} className="text-white" />
                  </button>
                </div>
              </div>
            </>
          )}

          {/* FAQ tab */}
          {activeTab === 'faq' && (
            <div className="flex-1 overflow-y-auto bg-white thin-scroll">
              {!faqsLoaded ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-xs text-gray-400">Loading...</p>
                </div>
              ) : faqs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                  <HelpCircle size={32} className="text-gray-200 mb-3" />
                  <p className="text-sm font-medium text-gray-600 mb-1">FAQs coming soon</p>
                  <p className="text-xs text-gray-400">In the meantime, send us a message.</p>
                  <button
                    onClick={() => setActiveTab('messages')}
                    className="mt-3 text-xs font-medium transition-opacity hover:opacity-80"
                    style={{ color: '#FF8303' }}
                  >
                    Go to Messages →
                  </button>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Frequently Asked Questions
                    </p>
                  </div>
                  <FaqAccordion faqs={faqs} />
                  <div className="px-4 py-4 border-t border-gray-100 text-center">
                    <p className="text-xs text-gray-400 mb-1">Still have a question?</p>
                    <button
                      onClick={() => setActiveTab('messages')}
                      className="text-xs font-medium transition-opacity hover:opacity-80"
                      style={{ color: '#FF8303' }}
                    >
                      Message us →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bubble trigger */}
      <div className="relative">
        {!isOpen && unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center text-white z-10"
            style={{ backgroundColor: '#FD5602', fontSize: '10px', fontWeight: 700 }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
        <button
          onClick={() => {
            // NEW300: closing resets messagesLoaded so the next open refetches and re-marks reads.
            if (isOpen) setMessagesLoaded(false)
            setIsOpen(!isOpen)
          }}
          className="rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
          style={{ width: '52px', height: '52px', backgroundColor: isOpen ? '#e06e00' : '#FF8303', boxShadow: '0 4px 12px rgba(255,131,3,0.4)' }}
          aria-label={isOpen ? 'Close chat' : 'Open chat'}
        >
          {isOpen ? (
            <X size={22} className="text-white" />
          ) : (
            <img src="/lingualink-chat-icon.svg" alt="LinguaLink chat" width={32} height={32} />
          )}
        </button>
      </div>
    </div>
  )
}
