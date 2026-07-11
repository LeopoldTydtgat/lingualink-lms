'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import { createClient } from '@/lib/supabase/client'
import { X, Send, ChevronDown, ChevronUp, MessageSquare, HelpCircle } from 'lucide-react'
import dynamic from 'next/dynamic'
import data from '@emoji-mart/data'
import { sanitizeHtml } from '@/lib/sanitize'

const EmojiPicker = dynamic(() => import('@emoji-mart/react'), { ssr: false })

// ── Types ─────────────────────────────────────────────────────────────────────

interface SupportMessage {
  id: string
  sender_role: 'user' | 'admin'
  content: string
  created_at: string
  read_at: string | null
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

function isEmojiOnly(html: string): boolean {
  const stripped = html.replace(/<[^>]*>/g, '').trim()
  const emojiRegex = /^[\p{Emoji}\s]+$/u
  return emojiRegex.test(stripped) && stripped.length <= 8
}

function Avatar({ name, photoUrl, size = 10 }: {
  name: string
  photoUrl?: string | null
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
  adminName = 'Shannon',
  adminPhotoUrl = null,
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
  const [, forceUpdate] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ bottom: number; right: number } | null>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)

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

  // Load support messages for this participant
  const loadMessages = useCallback(async () => {
    if (messagesLoaded) return
    const { data } = await supabase
      .from('support_messages')
      .select('id, sender_role, content, created_at, read_at')
      .eq('participant_auth_id', participantAuthId)
      .order('created_at', { ascending: true })
    setMessages((data as SupportMessage[]) || [])
    setMessagesLoaded(true)

    // Mark admin messages as read now that the teacher has opened the widget
    await supabase
      .from('support_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('participant_auth_id', participantAuthId)
      .eq('sender_role', 'admin')
      .is('read_at', null)

    // Clear the unread badge
    setUnreadCount(0)
  }, [supabase, participantAuthId, messagesLoaded])

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
      setTimeout(() => editor?.commands.focus(), 100)
    }
    if (activeTab === 'faq') {
      loadFaqs()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeTab, loadMessages, loadFaqs])

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
    if (!isOpen) return
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
          // Update read_at on the matching message so ticks flip live
          setMessages(prev =>
            prev.map(m => m.id === updated.id ? { ...m, read_at: updated.read_at } : m)
          )
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [isOpen, participantAuthId, supabase])

  const handleSend = async () => {
    if (!editor || sending) return
    const html = editor.getHTML()
    if (!html || html === '<p></p>') return
    editor.commands.clearContent()
    setSending(true)

    // Optimistic update
    const tempId = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id: tempId,
      sender_role: 'user',
      content: html,
      created_at: new Date().toISOString(),
      read_at: null,
    }])

    const res = await fetch('/api/support/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId,
        participantType,
        participantAuthId,
        content: html,
      }),
    })

    if (!res.ok) {
      // Roll back optimistic update on failure
      setMessages(prev => prev.filter(m => m.id !== tempId))
    } else {
      // Replace temp message with real DB message so read_at updates work
      const data = await res.json()
      if (data.message) {
        setMessages(prev =>
          prev.map(m => m.id === tempId ? { ...data.message, read_at: null } : m)
        )
      }
    }

    setSending(false)
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
      ? { backgroundColor: 'rgba(255,255,255,0.25)', color: 'white', borderRadius: '6px' }
      : { color: 'rgba(255,255,255,0.65)' }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">

      {isOpen && (
        <div
          className="bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          style={{ width: '360px', height: '520px' }}
        >
          {/* Header */}
          <div className="px-4 pt-4 pb-0 flex-shrink-0" style={{ backgroundColor: '#FF8303' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Avatar name={adminName} photoUrl={adminPhotoUrl} size={9} />
                <span className="w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-white -ml-4 mt-4 flex-shrink-0" />
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-white/80 hover:text-white transition-colors"
                aria-label="Close chat"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-white font-semibold text-sm mb-0.5">Questions? Chat with us.</p>
            <p className="text-white/75 text-xs mb-3">We typically reply within an hour.</p>
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
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isFromMe ? 'justify-end' : 'justify-start'} items-end gap-2`}
                      >
                        {!isFromMe && (
                          <Avatar name={adminName} photoUrl={adminPhotoUrl} size={7} />
                        )}
                        <div className="max-w-[75%]">
                          <div
                            className="widget-bubble px-3 py-2 rounded-2xl text-sm leading-relaxed"
                            style={isEmojiOnly(msg.content)
                              ? { fontSize: '2rem', background: 'none', padding: '4px 8px' }
                              : isFromMe
                              ? { backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }
                              : { backgroundColor: '#ffffff', color: '#1f2937', border: '1px solid #E0DFDC', borderBottomLeftRadius: '4px' }
                            }
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }}
                          />
                          <div className={`flex items-center gap-1 mt-0.5 ${isFromMe ? 'justify-end' : 'justify-start'}`}>
                            <span className="text-xs text-gray-400">{formatTime(msg.created_at)}</span>
                            {isFromMe && (
                              <span
                                className="text-xs font-bold leading-none"
                                style={{ color: msg.read_at ? '#FF8303' : '#9ca3af' }}
                                title={msg.read_at ? 'Read' : 'Sent'}
                              >
                                {msg.read_at ? '✓✓' : '✓'}
                              </span>
                            )}
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
                </div>
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
          onClick={() => setIsOpen(prev => !prev)}
          className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95"
          style={{ backgroundColor: isOpen ? '#e06e00' : '#FF8303' }}
          aria-label={isOpen ? 'Close chat' : 'Open chat'}
        >
          {isOpen ? (
            <X size={22} className="text-white" />
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M21 15C21 15.5304 20.7893 16.0391 20.4142 16.4142C20.0391 16.7893 19.5304 17 19 17H7L3 21V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V15Z"
                stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
