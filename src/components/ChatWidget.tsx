// src/components/ChatWidget.tsx
// Fixed-position floating chat widget — sits bottom-right on every page.
// Portal-agnostic: teacher and student layouts pass their own server actions as props
// so this component never imports from a portal-specific path.
'use client'

import Image from 'next/image'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X, Send, ChevronDown, ChevronUp, MessageSquare, HelpCircle } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string
  sender_id: string
  content: string
  created_at: string
}

export interface FaqItem {
  question: string
  answer: string
}

interface ChatWidgetProps {
  currentUserId: string
  currentUserName: string
  adminProfileId: string | null
  adminName?: string
  adminPhotoUrl?: string | null
  faqs?: FaqItem[]
  // Server actions passed in from the layout — keeps this component portal-agnostic.
  // Teacher layout passes teacher actions; student layout passes student actions.
  sendMessageAction: (
    receiverId: string,
    receiverType: 'teacher' | 'admin' | 'student',
    content: string
  ) => Promise<{ error?: string; success?: boolean } | undefined>
  markAsReadAction: (contactId: string) => Promise<void>
}

// ── FAQ content ───────────────────────────────────────────────────────────────
// Edit these arrays when Shannon supplies the final wording.
// Teacher FAQs are passed from (dashboard)/layout.tsx
// Student FAQs are passed from (student)/student/layout.tsx

export const TEACHER_FAQS: FaqItem[] = [
  {
    question: 'When do I need to submit my class report?',
    answer: 'You have 12 hours from the end of the class to complete your report. After 12 hours the report is automatically flagged and payment for that class may be withheld.',
  },
  {
    question: 'When can I upload my monthly invoice?',
    answer: 'Invoices can be uploaded between the 1st and 10th of each month. Invoices uploaded after the 10th will be processed the following month.',
  },
  {
    question: 'How is my monthly amount calculated?',
    answer: 'Your earnings are calculated automatically: (class duration in minutes ÷ 60) × your hourly rate. This applies to completed classes and student no-shows. Classes you missed are not paid.',
  },
  {
    question: "What happens if a student doesn't show up?",
    answer: 'You are still paid for student no-shows as long as you were present and ready. You must complete the class report and select "Student no-show" to confirm you were there.',
  },
  {
    question: 'How do I reschedule a class?',
    answer: 'You can reschedule a class from the Upcoming Classes page as long as it is more than 24 hours before the class start time. Within 24 hours, rescheduling is not available.',
  },
  {
    question: 'How do I update my billing information?',
    answer: 'Your billing information (IBAN, PayPal, tax number etc.) can only be updated by the admin. Please send a message using the Messages tab above and Shannon will update it for you.',
  },
]

export const STUDENT_FAQS: FaqItem[] = [
  {
    question: 'How do I book a class?',
    answer: 'Go to My Classes and click the "+ Book a Class" button. Select your teacher, choose a duration (30, 60, or 90 minutes), then pick an available slot on the calendar.',
  },
  {
    question: 'What happens to my hours if I cancel?',
    answer: 'If you cancel more than 24 hours before the class, your hours are fully refunded. If you cancel within 24 hours, the hours are not refunded.',
  },
  {
    question: 'How do I join my class?',
    answer: 'The "Join Class" button appears 15 minutes before your class starts — in the right panel and on your My Classes page. It links directly to your Microsoft Teams meeting.',
  },
  {
    question: 'How do I check my remaining hours?',
    answer: 'Your hours balance is always visible in the right panel on every page. You can also see the full breakdown on your Progress page and in My Account.',
  },
  {
    question: 'How do I get more hours?',
    answer: 'Purchase additional hours on our website (lingualinkonline.com). Once your payment is confirmed, Shannon will add the hours to your account within one business day.',
  },
  {
    question: 'Can I change my teacher?',
    answer: "Teacher assignments are managed by the admin. If you'd like to request a change, send a message using the Messages tab above and Shannon will discuss your options.",
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  return `${h}:${m}`
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '')
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

// ── FAQ Accordion ─────────────────────────────────────────────────────────────

function FaqAccordion({ faqs }: { faqs: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <div className="divide-y divide-gray-100">
      {faqs.map((faq, index) => (
        <div key={index}>
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
  currentUserId,
  adminProfileId,
  adminName = 'Admin',
  adminPhotoUrl = null,
  faqs = [],
  sendMessageAction,
  markAsReadAction,
}: ChatWidgetProps) {
  const supabase = useMemo(() => createClient(), [])

  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'messages' | 'faq'>('messages')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const loadMessages = useCallback(async () => {
    if (!adminProfileId || loaded) return

    const { data } = await supabase
      .from('messages')
      .select('id, sender_id, content, created_at')
      .or(
        `and(sender_id.eq.${currentUserId},receiver_id.eq.${adminProfileId}),` +
        `and(sender_id.eq.${adminProfileId},receiver_id.eq.${currentUserId})`
      )
      .order('created_at', { ascending: true })

    setMessages(data || [])
    setLoaded(true)
    await markAsReadAction(adminProfileId)
  }, [supabase, currentUserId, adminProfileId, loaded, markAsReadAction])

  useEffect(() => {
    if (isOpen && activeTab === 'messages') {
      loadMessages()
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen, activeTab, loadMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Real-time: incoming messages from admin
  useEffect(() => {
    if (!isOpen || !adminProfileId) return

    const channel = supabase
      .channel(`widget-inbox-${currentUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUserId}`,
        },
        async (payload) => {
          const newMsg = payload.new as Message
          if (newMsg.sender_id === adminProfileId) {
            setMessages(prev => [...prev, newMsg])
            await markAsReadAction(adminProfileId)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [isOpen, adminProfileId, currentUserId, supabase, markAsReadAction])

  const handleSend = async () => {
    if (!adminProfileId || !input.trim() || sending) return

    const text = input.trim()
    setInput('')
    setSending(true)

    const html = `<p>${text}</p>`
    const result = await sendMessageAction(adminProfileId, 'admin', html)

    if (!result?.error) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        sender_id: currentUserId,
        content: html,
        created_at: new Date().toISOString(),
      }])
    }

    setSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const tabStyle = (tab: 'messages' | 'faq') =>
    activeTab === tab
      ? { backgroundColor: 'rgba(255,255,255,0.25)', color: 'white', borderRadius: '6px' }
      : { color: 'rgba(255,255,255,0.65)' }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">

      {/* ── Chat panel ── */}
      {isOpen && (
        <div
          className="bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          style={{ width: '360px', height: '520px' }}
        >
          {/* Header with tabs */}
          <div
            className="px-4 pt-4 pb-0 flex-shrink-0"
            style={{ backgroundColor: '#FF8303' }}
          >
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
                onClick={() => setActiveTab('messages')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all"
                style={tabStyle('messages')}
              >
                <MessageSquare size={13} />
                Messages
              </button>
              <button
                onClick={() => setActiveTab('faq')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all"
                style={tabStyle('faq')}
              >
                <HelpCircle size={13} />
                FAQ
              </button>
            </div>
          </div>

          {/* ── Messages tab ── */}
          {activeTab === 'messages' && (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-gray-50">
                {!loaded ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-xs text-gray-400">Loading...</p>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-4">
                    <p className="text-sm font-medium text-gray-700 mb-1">How can we help?</p>
                    <p className="text-xs text-gray-400">
                      Send a message and we&apos;ll get back to you shortly.
                    </p>
                  </div>
                ) : (
                  messages.map(msg => {
                    const isFromMe = msg.sender_id === currentUserId
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
                            className="px-3 py-2 rounded-2xl text-sm leading-relaxed"
                            style={
                              isFromMe
                                ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                                : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                            }
                          >
                            {stripHtml(msg.content)}
                          </div>
                          <p className={`text-xs text-gray-400 mt-0.5 ${isFromMe ? 'text-right' : 'text-left'}`}>
                            {formatTime(msg.created_at)}
                          </p>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-gray-200 px-4 py-3 bg-white flex-shrink-0">
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 bg-gray-50"
                    disabled={sending}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
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

          {/* ── FAQ tab ── */}
          {activeTab === 'faq' && (
            <div className="flex-1 overflow-y-auto bg-white">
              {faqs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                  <HelpCircle size={32} className="text-gray-200 mb-3" />
                  <p className="text-sm font-medium text-gray-600 mb-1">FAQs coming soon</p>
                  <p className="text-xs text-gray-400">
                    In the meantime, send us a message and we&apos;ll help you out.
                  </p>
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

      {/* ── Bubble trigger ──
          TODO: Replace the SVG path inside with Shannon's custom icon.
          Button wrapper, size, and colour stay exactly as-is. */}
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ backgroundColor: isOpen ? '#e06e00' : '#FF8303' }}
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
      >
        {isOpen ? (
          <X size={22} className="text-white" />
        ) : (
          // ── SWAP THIS SVG FOR SHANNON'S ICON ──
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M21 15C21 15.5304 20.7893 16.0391 20.4142 16.4142C20.0391 16.7893 19.5304 17 19 17H7L3 21V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V15Z"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  )
}


