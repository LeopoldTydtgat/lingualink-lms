'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { MessageSquare, HelpCircle, Send, Plus, Trash2, Edit2, Check, X } from 'lucide-react'

interface Conversation {
  participantId: string
  participantType: 'teacher' | 'student'
  participantAuthId: string
  participantName: string
  participantPhotoUrl: string | null
  latestMessage: { content: string; created_at: string; sender_role: string }
  unreadCount: number
}

interface SupportMessage {
  id: string
  sender_role: 'user' | 'admin'
  content: string
  created_at: string
  read_at: string | null
}

interface Faq {
  id: string
  question: string
  answer: string
  target_audience: 'teacher' | 'student' | 'both'
  display_order: number
  is_active: boolean
}

interface AdminProfile {
  id: string
  full_name: string
  photo_url: string | null
}

interface Props {
  adminProfile: AdminProfile
  conversations: Conversation[]
  initialFaqs: Faq[]
}

function formatTime(dateStr: string) {
  const date = new Date(dateStr)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

function Avatar({ name, photoUrl, size = 9 }: { name: string; photoUrl?: string | null; size?: number }) {
  if (photoUrl) {
    return (
      <img src={photoUrl} alt={name} className="rounded-full object-cover flex-shrink-0"
        style={{ width: size * 4, height: size * 4 }} />
    )
  }
  return (
    <div className="rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0"
      style={{ width: size * 4, height: size * 4, backgroundColor: '#FF8303', fontSize: '12px' }}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

export default function AdminSupportClient({ adminProfile, conversations: initialConversations, initialFaqs }: Props) {
  const supabase = useMemo(() => createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  ), [])

  const [activeTab, setActiveTab] = useState<'conversations' | 'faqs'>('conversations')
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [messagesLoaded, setMessagesLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [faqs, setFaqs] = useState<Faq[]>(initialFaqs)
  const [newQuestion, setNewQuestion] = useState('')
  const [newAnswer, setNewAnswer] = useState('')
  const [newAudience, setNewAudience] = useState<'teacher' | 'student' | 'both'>('teacher')
  const [addingFaq, setAddingFaq] = useState(false)
  const [savingFaq, setSavingFaq] = useState(false)
  const [editingFaqId, setEditingFaqId] = useState<string | null>(null)
  const [editQuestion, setEditQuestion] = useState('')
  const [editAnswer, setEditAnswer] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback(async (conv: Conversation) => {
    setMessagesLoaded(false)
    const { data } = await supabase
      .from('support_messages')
      .select('id, sender_role, content, created_at, read_at')
      .eq('participant_auth_id', conv.participantAuthId)
      .order('created_at', { ascending: true })
    setMessages((data as SupportMessage[]) || [])
    setMessagesLoaded(true)

    // Mark all unread user messages as read now that Shannon has opened this conversation
    await supabase
      .from('support_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('participant_auth_id', conv.participantAuthId)
      .eq('sender_role', 'user')
      .is('read_at', null)

    // Clear the unread badge on this conversation in the list
    setConversations(prev =>
      prev.map(c => c.participantId === conv.participantId ? { ...c, unreadCount: 0 } : c)
    )
  }, [supabase])

  useEffect(() => {
    if (selectedConv) loadMessages(selectedConv)
  }, [selectedConv, loadMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Real-time for open conversation
  useEffect(() => {
    if (!selectedConv) return
    const channel = supabase
      .channel(`admin-support-${selectedConv.participantAuthId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'support_messages',
        filter: `participant_auth_id=eq.${selectedConv.participantAuthId}`,
      }, (payload) => {
        const msg = payload.new as SupportMessage
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg])
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'support_messages',
        filter: `participant_auth_id=eq.${selectedConv.participantAuthId}`,
      }, (payload) => {
        const updated = payload.new as SupportMessage
        setMessages(prev =>
          prev.map(m => m.id === updated.id ? { ...m, read_at: updated.read_at } : m)
        )
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [selectedConv, supabase])

  const handleSend = async () => {
    if (!selectedConv || !input.trim() || sending) return
    const text = input.trim()
    setInput('')
    setSending(true)

    const tempId = crypto.randomUUID()
    setMessages(prev => [...prev, { id: tempId, sender_role: 'admin', content: text, created_at: new Date().toISOString() }])

    const res = await fetch('/api/support/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: selectedConv.participantId,
        participantType: selectedConv.participantType,
        participantAuthId: selectedConv.participantAuthId,
        content: text,
      }),
    })

    if (!res.ok) {
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

  const handleAddFaq = async () => {
    if (!newQuestion.trim() || !newAnswer.trim()) return
    setSavingFaq(true)
    const { data, error } = await supabase
      .from('faqs')
      .insert({ question: newQuestion.trim(), answer: newAnswer.trim(), target_audience: newAudience, display_order: faqs.length })
      .select('id, question, answer, target_audience, display_order, is_active')
      .single()
    if (!error && data) {
      setFaqs(prev => [...prev, data as Faq])
      setNewQuestion('')
      setNewAnswer('')
      setAddingFaq(false)
    }
    setSavingFaq(false)
  }

  const handleDeleteFaq = async (id: string) => {
    await supabase.from('faqs').delete().eq('id', id)
    setFaqs(prev => prev.filter(f => f.id !== id))
  }

  const handleToggleFaq = async (faq: Faq) => {
    await supabase.from('faqs').update({ is_active: !faq.is_active }).eq('id', faq.id)
    setFaqs(prev => prev.map(f => f.id === faq.id ? { ...f, is_active: !f.is_active } : f))
  }

  const handleSaveEdit = async (faq: Faq) => {
    await supabase.from('faqs').update({ question: editQuestion, answer: editAnswer }).eq('id', faq.id)
    setFaqs(prev => prev.map(f => f.id === faq.id ? { ...f, question: editQuestion, answer: editAnswer } : f))
    setEditingFaqId(null)
  }

  const tabStyle = (tab: 'conversations' | 'faqs') =>
    activeTab === tab
      ? { borderBottom: '2px solid #FF8303', color: '#FF8303' }
      : { borderBottom: '2px solid transparent', color: '#6b7280' }

  return (
    <div style={{ padding: '24px' }}>
      <h1 className="text-xl font-bold text-gray-900 mb-6">Support</h1>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('conversations')}
          className="pb-3 text-sm font-medium transition-colors"
          style={tabStyle('conversations')}
        >
          Conversations {initialConversations.some(c => c.unreadCount > 0) && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs text-white" style={{ backgroundColor: '#FF8303' }}>
              {initialConversations.reduce((acc, c) => acc + c.unreadCount, 0)}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('faqs')}
          className="pb-3 text-sm font-medium transition-colors"
          style={tabStyle('faqs')}
        >
          FAQs
        </button>
      </div>

      {/* Conversations tab */}
      {activeTab === 'conversations' && (
        <div className="flex gap-4" style={{ height: '600px' }}>
          {/* Conversation list */}
          <div className="w-72 flex-shrink-0 border border-gray-200 rounded-lg overflow-y-auto bg-white">
            {initialConversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <MessageSquare size={32} className="text-gray-200 mb-3" />
                <p className="text-sm text-gray-500">No support messages yet</p>
              </div>
            ) : (
              conversations.map(conv => (
                <button
                  key={conv.participantId}
                  onClick={() => setSelectedConv(conv)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors border-b border-gray-100"
                  style={selectedConv?.participantId === conv.participantId ? { backgroundColor: '#fff7ed' } : {}}
                >
                  <Avatar name={conv.participantName} photoUrl={conv.participantPhotoUrl} size={9} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 truncate">{conv.participantName}</p>
                      <span className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: '#f3f4f6', color: '#6b7280' }}>
                        {conv.participantType}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 truncate mt-0.5">{conv.latestMessage.content}</p>
                  </div>
                  {conv.unreadCount > 0 && (
                    <span className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: '#FF8303' }}>
                      {conv.unreadCount}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Message thread */}
          <div className="flex-1 border border-gray-200 rounded-lg flex flex-col bg-white">
            {!selectedConv ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <MessageSquare size={32} className="text-gray-200 mb-3" />
                <p className="text-sm text-gray-500">Select a conversation</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200">
                  <Avatar name={selectedConv.participantName} photoUrl={selectedConv.participantPhotoUrl} size={9} />
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{selectedConv.participantName}</p>
                    <p className="text-xs text-gray-400 capitalize">{selectedConv.participantType}</p>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-gray-50">
                  {!messagesLoaded ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-xs text-gray-400">Loading...</p>
                    </div>
                  ) : messages.map(msg => {
                    const isAdmin = msg.sender_role === 'admin'
                    return (
                      <div key={msg.id} className={`flex ${isAdmin ? 'justify-end' : 'justify-start'} items-end gap-2`}>
                        {!isAdmin && <Avatar name={selectedConv.participantName} photoUrl={selectedConv.participantPhotoUrl} size={7} />}
                        <div className="max-w-[75%]">
                          <div className="px-3 py-2 rounded-2xl text-sm"
                            style={isAdmin
                              ? { backgroundColor: '#FF8303', color: 'white', borderBottomRightRadius: '4px' }
                              : { backgroundColor: '#1F2937', color: 'white', borderBottomLeftRadius: '4px' }
                            }>
                            {msg.content}
                          </div>
                          <div className={`flex items-center gap-1 mt-0.5 ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                            <span className="text-xs text-gray-400">{formatTime(msg.created_at)}</span>
                            {isAdmin && (
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
                        {isAdmin && <Avatar name={adminProfile.full_name} photoUrl={adminProfile.photo_url} size={7} />}
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>

                <div className="border-t border-gray-200 px-4 py-3 bg-white flex items-center gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
                    placeholder={`Reply to ${selectedConv.participantName}...`}
                    className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 bg-gray-50"
                    disabled={sending}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
                    className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40"
                    style={{ backgroundColor: '#FF8303' }}
                  >
                    <Send size={15} className="text-white" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* FAQs tab */}
      {activeTab === 'faqs' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">Manage FAQs shown to teachers and students in the support chat.</p>
            <button
              onClick={() => setAddingFaq(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              <Plus size={15} />
              Add FAQ
            </button>
          </div>

          {addingFaq && (
            <div className="border border-orange-200 rounded-lg p-4 bg-orange-50 mb-4">
              <p className="text-sm font-semibold text-gray-700 mb-3">New FAQ</p>
              <input
                type="text"
                value={newQuestion}
                onChange={e => setNewQuestion(e.target.value)}
                placeholder="Question"
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 mb-2"
              />
              <textarea
                value={newAnswer}
                onChange={e => setNewAnswer(e.target.value)}
                placeholder="Answer"
                rows={3}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 mb-2 resize-none"
              />
              <div className="flex items-center gap-3">
                <select
                  value={newAudience}
                  onChange={e => setNewAudience(e.target.value as any)}
                  className="text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 bg-white"
                >
                  <option value="teacher">Teachers only</option>
                </select>
                <button
                  onClick={handleAddFaq}
                  disabled={savingFaq || !newQuestion.trim() || !newAnswer.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40"
                  style={{ backgroundColor: '#FF8303' }}
                >
                  Save
                </button>
                <button
                  onClick={() => { setAddingFaq(false); setNewQuestion(''); setNewAnswer('') }}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 bg-white border border-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {faqs.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No FAQs yet. Click Add FAQ to create your first one.</p>
            ) : (
              faqs.map(faq => (
                <div key={faq.id} className="border border-gray-200 rounded-lg p-4 bg-white">
                  {editingFaqId === faq.id ? (
                    <div>
                      <input
                        type="text"
                        value={editQuestion}
                        onChange={e => setEditQuestion(e.target.value)}
                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 mb-2"
                      />
                      <textarea
                        value={editAnswer}
                        onChange={e => setEditAnswer(e.target.value)}
                        rows={3}
                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:border-orange-400 mb-2 resize-none"
                      />
                      <div className="flex gap-2">
                        <button onClick={() => handleSaveEdit(faq)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white"
                          style={{ backgroundColor: '#FF8303' }}>
                          <Check size={13} /> Save
                        </button>
                        <button onClick={() => setEditingFaqId(null)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 bg-gray-100">
                          <X size={13} /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-gray-800">{faq.question}</p>
                          <p className="text-sm text-gray-500 mt-1 leading-relaxed">{faq.answer}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs px-2 py-0.5 rounded-full"
                            style={{ backgroundColor: '#f3f4f6', color: '#6b7280' }}>
                            {faq.target_audience === 'both' ? 'All' : faq.target_audience}
                          </span>
                          <button
                            onClick={() => handleToggleFaq(faq)}
                            className="text-xs px-2 py-0.5 rounded-full font-medium"
                            style={faq.is_active
                              ? { backgroundColor: '#dcfce7', color: '#16a34a' }
                              : { backgroundColor: '#f3f4f6', color: '#9ca3af' }
                            }>
                            {faq.is_active ? 'Active' : 'Inactive'}
                          </button>
                          <button
                            onClick={() => { setEditingFaqId(faq.id); setEditQuestion(faq.question); setEditAnswer(faq.answer) }}
                            className="text-gray-400 hover:text-gray-600 transition-colors">
                            <Edit2 size={15} />
                          </button>
                          <button
                            onClick={() => handleDeleteFaq(faq.id)}
                            className="text-gray-400 hover:text-red-500 transition-colors">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
