'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import { createClient } from '@/lib/supabase/client'
import { MessageSquare, HelpCircle, Send, Plus, Trash2, Edit2, Check, X, Paperclip, Loader2 } from 'lucide-react'
import dynamic from 'next/dynamic'
import data from '@emoji-mart/data'
import { sanitizeHtml } from '@/lib/sanitize'
import { isEmojiOnly } from '@/lib/messages/isEmojiOnly'
import { messageAttachmentHref } from '@/lib/messages/attachmentHref'
import { EDIT_WINDOW_ERROR, isWithinEditWindow } from '@/lib/messages/editWindow'
import ReadTicks from '@/components/messages/ReadTicks'
import { toast } from 'sonner'
import { getSupportParticipant } from './actions'

const EmojiPicker = dynamic(() => import('@emoji-mart/react'), { ssr: false })

interface Conversation {
  participantId: string
  participantType: 'teacher' | 'student'
  participantAuthId: string
  participantName: string
  participantPhotoUrl: string | null
  // id lets the Realtime UPDATE handler patch this preview when the latest
  // message is edited (page.tsx assigns the whole row, so id is always present).
  latestMessage: { id: string; content: string; created_at: string; sender_role: string }
  unreadCount: number
}

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

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').slice(0, 60)
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
  const supabase = useMemo(() => createClient(), [])

  const [activeTab, setActiveTab] = useState<'conversations' | 'faqs'>('conversations')
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [messagesLoaded, setMessagesLoaded] = useState(false)
  // Fail-safe: a thread whose load failed must NOT render as "no messages yet" — an
  // empty thread and an unreadable one look identical otherwise.
  const [messagesError, setMessagesError] = useState(false)
  // Keyed per conversation id, not a shared boolean: the list renders every row at once,
  // so a single flag would spin every row for one click.
  const [openingConvIds, setOpeningConvIds] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ url: string; filename: string; size: number }>>([])
  const [uploading, setUploading] = useState(false)
  const [faqs, setFaqs] = useState<Faq[]>(initialFaqs)
  const [newQuestion, setNewQuestion] = useState('')
  const [newAnswer, setNewAnswer] = useState('')
  const [newAudience, setNewAudience] = useState<'teacher' | 'student' | 'both'>('teacher')
  const [addingFaq, setAddingFaq] = useState(false)
  const [savingFaq, setSavingFaq] = useState(false)
  const [editingFaqId, setEditingFaqId] = useState<string | null>(null)
  const [editQuestion, setEditQuestion] = useState('')
  const [editAnswer, setEditAnswer] = useState('')
  // Only one FAQ editor is open at a time (editingFaqId is a single id), so a plain
  // boolean is enough here. The toggle/delete flags below MUST be keyed per FAQ id
  // because every FAQ row renders its own toggle and delete button at once.
  const [savingFaqEdit, setSavingFaqEdit] = useState(false)
  const [togglingFaqIds, setTogglingFaqIds] = useState<Set<string>>(new Set())
  const [deletingFaqIds, setDeletingFaqIds] = useState<Set<string>>(new Set())
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [, forceUpdate] = useState(0)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ bottom: number; left: number } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // NEW300: buffers read_at values that arrive via Realtime UPDATE before handleSend has
  // swapped the temp message for the real DB row, so the read tick isn't stomped back to null.
  const pendingReadsRef = useRef<Map<string, string>>(new Map())
  // NEW304: holds the tempId of the admin's own in-flight optimistic send. The Realtime
  // INSERT below can echo that same row back before handleSend's fetch response resolves;
  // without this the echo is appended as a second row (duplicate React key) instead of
  // replacing the temp one. Single-flight only (handleSend is guarded by `sending`), so one
  // ref is enough - no need to track multiple in-flight sends.
  const pendingSendIdRef = useRef<string | null>(null)
  // NEW303: mirrors selectedConv so the component-lifetime list subscription (which must NOT
  // resubscribe on every selection change) can read the currently-open conversation without
  // being keyed to it. Kept in sync by the tiny effect below.
  const selectedConvRef = useRef<Conversation | null>(null)
  useEffect(() => { selectedConvRef.current = selectedConv }, [selectedConv])
  // NEW303: mirrors the conversation list so the same lifetime subscription can tell a
  // first-time sender (no row yet → look up name/photo) from an existing conversation
  // (update in place) without a stale closure or resubscribing.
  const conversationsRef = useRef<Conversation[]>(initialConversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ underline: false }),
      Underline,
      Placeholder.configure({ placeholder: 'Type a reply...' }),
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

  // Per-id pending helpers. Set-valued so several rows can be in flight at once
  // without one clobbering another's flag. Used by the conversation list and the FAQ rows.
  const addPendingId = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter(prev => { const next = new Set(prev); next.add(id); return next })
  const removePendingId = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter(prev => { const next = new Set(prev); next.delete(id); return next })

  // NEW300: mark all inbound user messages read for this conversation. Reusable so it fires
  // both on load and when a user message arrives live (previously reads only happened inside
  // loadMessages, so a live-arriving message never flipped the admin's tick — no UPDATE fired).
  const markUserMessagesRead = useCallback(async (conv: Conversation) => {
    const { error } = await supabase
      .from('support_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('participant_auth_id', conv.participantAuthId)
      .eq('sender_role', 'user')
      .is('read_at', null)

    if (error) {
      // The rows are still unread in the database — zeroing the badge here would make it
      // lie, and the count would silently reappear on the next page load.
      toast.error('Could not mark these messages as read. The unread count may be out of date.', { duration: 6000 })
      return
    }

    // Clear the unread badge on this conversation in the list
    setConversations(prev =>
      prev.map(c => c.participantId === conv.participantId ? { ...c, unreadCount: 0 } : c)
    )
  }, [supabase])

  const loadMessages = useCallback(async (conv: Conversation) => {
    setMessagesLoaded(false)
    setMessagesError(false)
    setEditingMessageId(null)
    const { data, error } = await supabase
      .from('support_messages')
      .select('id, sender_role, content, attachments, created_at, read_at, edited_at')
      .eq('participant_auth_id', conv.participantAuthId)
      .order('created_at', { ascending: true })

    if (error) {
      // Don't fall through to markUserMessagesRead: we never saw the thread, so claiming
      // it was read (and clearing the badge) would be a second lie on top of the first.
      setMessages([])
      setMessagesError(true)
      setMessagesLoaded(true)
      toast.error('Conversation failed to load. Please try again.', { duration: 6000 })
      return
    }

    setMessages((data as SupportMessage[]) || [])
    setMessagesLoaded(true)

    // Mark all unread user messages as read now that Shannon has opened this conversation
    await markUserMessagesRead(conv)
  }, [supabase, markUserMessagesRead])

  useEffect(() => {
    if (!selectedConv) return
    // Composer state belongs to the conversation it was typed in: a draft, an uploaded
    // attachment or a half-finished message edit left over from the previous thread must
    // never be sendable into this one. Same clear the send-success path uses.
    editor?.commands.clearContent()
    setPendingAttachments([])
    setEditingMessageId(null)
    editEditor?.commands.clearContent()
    // Feedback on the clicked row itself, keyed by its conversation id — the thread pane's
    // "Loading..." is on the other side of the screen and the row looked inert.
    const pendingId = selectedConv.participantId
    addPendingId(setOpeningConvIds, pendingId)
    void (async () => {
      try {
        await loadMessages(selectedConv)
      } finally {
        removePendingId(setOpeningConvIds, pendingId)
      }
    })()
  }, [selectedConv, loadMessages, editor, editEditor])

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
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev
          // NEW304: this Realtime echo can arrive before handleSend's own fetch response
          // swaps the temp row for the real one. If it's the admin's own in-flight send,
          // replace the pending temp row in place instead of appending a duplicate - the
          // later fetch-response swap then finds no matching tempId and is a harmless no-op.
          if (msg.sender_role === 'admin' && pendingSendIdRef.current) {
            const tempIdx = prev.findIndex(m => m.id === pendingSendIdRef.current)
            if (tempIdx !== -1) {
              pendingSendIdRef.current = null
              return [...prev.slice(0, tempIdx), msg, ...prev.slice(tempIdx + 1)]
            }
          }
          return [...prev, msg]
        })
        // NEW300: a user message arriving live in the open conversation must be marked read so
        // its tick flips for the user. The subscription filter already scopes this to selectedConv.
        if (msg.sender_role === 'user') {
          markUserMessagesRead(selectedConv)
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'support_messages',
        filter: `participant_auth_id=eq.${selectedConv.participantAuthId}`,
      }, (payload) => {
        const updated = payload.new as SupportMessage
        // Buffer the read_at first (NEW300) so a temp→real swap in handleSend can carry it over
        // instead of losing it, then flip the tick live. The same events also carry edits
        // (content + edited_at) from either side, so patch those too — read_at never regresses
        // to null here because an edit UPDATE on an unread message arrives with read_at null.
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
        // Keep the conversation list's preview in step when the edited message is
        // the one shown there. Gated on edited_at so plain read-receipt UPDATEs
        // don't churn the list; covers the admin's own edits too (this channel
        // echoes them), so handleSaveMessageEdit needs no separate list patch.
        if (updated.edited_at) {
          setConversations(prev =>
            prev.map(c => c.latestMessage.id === updated.id
              ? { ...c, latestMessage: { ...c.latestMessage, content: updated.content ?? c.latestMessage.content } }
              : c)
          )
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [selectedConv, supabase, markUserMessagesRead])

  // NEW303: component-lifetime subscription that keeps the conversation LIST live for every
  // thread, not just the open one. It listens to unfiltered INSERTs on support_messages and
  // reads the current selection via selectedConvRef, so it never resubscribes on selection
  // change. The open-conversation channel above is left untouched (it drives the thread view
  // and read receipts); this one only maintains the list preview / ordering / unread badges.
  useEffect(() => {
    const channel = supabase
      .channel('admin-support-list')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'support_messages',
      }, async (payload) => {
        const msg = payload.new as {
          id: string
          participant_id: string
          participant_type: 'teacher' | 'student'
          participant_auth_id: string
          sender_role: 'user' | 'admin'
          content: string
          created_at: string
        }
        const isOpen = selectedConvRef.current?.participantId === msg.participant_id
        const latestMessage = { id: msg.id, content: msg.content, created_at: msg.created_at, sender_role: msg.sender_role }

        if (conversationsRef.current.some(c => c.participantId === msg.participant_id)) {
          // Existing conversation: refresh its preview + unread, then float it to the top
          // (the incoming message is the newest, so move-to-top == re-sort by created_at desc).
          // A user message bumps unread only when the thread isn't currently open — the open
          // thread is marked read live by the open-conversation subscription; admin's own
          // sends never count as unread.
          setConversations(prev => {
            const idx = prev.findIndex(c => c.participantId === msg.participant_id)
            if (idx === -1) return prev
            const bump = msg.sender_role === 'user' && !isOpen
            const updated: Conversation = {
              ...prev[idx],
              latestMessage,
              unreadCount: bump ? prev[idx].unreadCount + 1 : prev[idx].unreadCount,
            }
            return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)]
          })
          return
        }

        // First-time sender: no conversation row exists yet, so resolve the participant's
        // name/photo server-side, then prepend. A second message for the SAME brand-new
        // participant can race this await (both handlers saw no row before either committed),
        // so re-check inside the updater: if a row now exists, MERGE into it (refresh preview,
        // bump unread, move to top — same logic as the existing-conversation branch) rather
        // than returning prev unchanged, which would silently drop this message's unread/preview.
        const result = await getSupportParticipant(msg.participant_id, msg.participant_type)
        if ('error' in result) return
        setConversations(prev => {
          const idx = prev.findIndex(c => c.participantId === msg.participant_id)
          if (idx !== -1) {
            const bump = msg.sender_role === 'user' && !isOpen
            const updated: Conversation = {
              ...prev[idx],
              latestMessage,
              unreadCount: bump ? prev[idx].unreadCount + 1 : prev[idx].unreadCount,
            }
            return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)]
          }
          const newConv: Conversation = {
            participantId: msg.participant_id,
            participantType: msg.participant_type,
            participantAuthId: msg.participant_auth_id,
            participantName: result.name,
            participantPhotoUrl: result.photoUrl,
            latestMessage,
            unreadCount: msg.sender_role === 'user' ? 1 : 0,
          }
          return [newConv, ...prev]
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [supabase])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Captured before the awaits below so the reset in `finally` can't hit a
    // detached/re-pointed event target.
    const input = e.target
    const file = input.files?.[0]
    if (!file) return

    if (file.size > 10 * 1024 * 1024) {
      toast.error('File must be under 10MB.', { duration: 6000 })
      input.value = ''
      return
    }

    setUploading(true)
    const form = new FormData()
    form.append('file', file)

    try {
      const res = await fetch('/api/messages/upload', { method: 'POST', body: form })
      if (!res.ok) {
        // Parse only AFTER the ok check, and tolerantly: an error response is not
        // guaranteed to carry a JSON body (a 502/HTML error page threw here before).
        const json = await res.json().catch(() => null)
        toast.error(json?.error ?? 'Upload failed. Please try again.', { duration: 6000 })
        return
      }
      const json = await res.json()
      setPendingAttachments(prev => [...prev, { url: json.url, filename: json.filename, size: json.size }])
    } catch {
      toast.error('Upload failed. Please check your connection and try again.', { duration: 6000 })
    } finally {
      // Always clears the spinner — a thrown fetch/parse used to leave it stuck on.
      setUploading(false)
      input.value = ''
    }
  }

  const handleSend = async () => {
    if (!editor || !selectedConv || sending) return
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

    // Optimistic temp row is pending until the temp-to-real swap below, so the Edit
    // affordance never targets a row whose id doesn't exist in the DB.
    const tempId = crypto.randomUUID()
    // NEW304: tracks this send until either the fetch response or the Realtime echo resolves
    // it, so the other one becomes a no-op instead of creating a duplicate row.
    pendingSendIdRef.current = tempId
    setMessages(prev => [...prev, { id: tempId, sender_role: 'admin', content: contentToSend, attachments: attachmentsToSend, created_at: new Date().toISOString(), read_at: null, pending: true }])

    try {
      const res = await fetch('/api/support/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: selectedConv.participantId,
          participantType: selectedConv.participantType,
          participantAuthId: selectedConv.participantAuthId,
          content: contentToSend,
          attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
        }),
      })

      if (!res.ok) {
        // Restore the pending attachments so a failed send doesn't silently discard the
        // already-uploaded file, and surface an error instead of failing quietly.
        setMessages(prev => prev.filter(m => m.id !== tempId))
        setPendingAttachments(attachmentsToSend)
        toast.error('Message failed to send. Please try again.', { duration: 6000 })
      } else {
        // Tolerant parse: the message WAS accepted, so an unreadable body must not roll the
        // optimistic row back — the Realtime INSERT echo swaps it for the real one.
        const json = await res.json().catch(() => null)
        if (json?.message) {
          // NEW300: if the user already read this reply before the real row landed, the Realtime
          // UPDATE buffered its read_at here — carry it over instead of hardcoding null (which
          // stomped the read tick). Otherwise honour the DB row's own read_at.
          const real = json.message as SupportMessage
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
    } catch {
      // The fetch itself never completed, so nothing was sent: same rollback + attachment
      // restore as a non-ok response, rather than leaving a temp row that will never resolve.
      setMessages(prev => prev.filter(m => m.id !== tempId))
      setPendingAttachments(attachmentsToSend)
      toast.error('Message failed to send. Please check your connection and try again.', { duration: 6000 })
    } finally {
      // NEW304: this send is now resolved one way or another; stop tracking it so a later,
      // unrelated Realtime INSERT never mistakes itself for this send.
      if (pendingSendIdRef.current === tempId) pendingSendIdRef.current = null
      setSending(false)
    }
  }

  const handleStartMessageEdit = (msg: SupportMessage) => {
    setEditingMessageId(msg.id)
    editEditor?.commands.setContent(msg.content || '')
    setTimeout(() => editEditor?.commands.focus('end'), 100)
  }

  const handleCancelMessageEdit = () => {
    setEditingMessageId(null)
    editEditor?.commands.clearContent()
  }

  const handleSaveMessageEdit = async () => {
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
        const json = await res.json().catch(() => null)
        if (json?.message) {
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
    } catch {
      // Editor stays open with the typed edit intact so it isn't lost to a dropped request.
      toast.error('Edit failed to save. Please check your connection and try again.', { duration: 6000 })
    } finally {
      setSavingEdit(false)
    }
  }

  const handleAddFaq = async () => {
    if (!newQuestion.trim() || !newAnswer.trim()) return
    setSavingFaq(true)
    try {
      const { data, error } = await supabase
        .from('faqs')
        .insert({ question: newQuestion.trim(), answer: newAnswer.trim(), target_audience: newAudience, display_order: faqs.length })
        .select('id, question, answer, target_audience, display_order, is_active')
        .single()
      if (error || !data) {
        // Leave the form open and populated so the typed question/answer isn't lost.
        toast.error('FAQ failed to save. Please try again.', { duration: 6000 })
        return
      }
      setFaqs(prev => [...prev, data as Faq])
      setNewQuestion('')
      setNewAnswer('')
      setAddingFaq(false)
    } finally {
      setSavingFaq(false)
    }
  }

  const handleDeleteFaq = async (id: string) => {
    if (deletingFaqIds.has(id)) return
    addPendingId(setDeletingFaqIds, id)
    try {
      const { error } = await supabase.from('faqs').delete().eq('id', id)
      if (error) {
        // Keep the row on screen — it still exists in the database.
        toast.error('FAQ failed to delete. Please try again.', { duration: 6000 })
        return
      }
      setFaqs(prev => prev.filter(f => f.id !== id))
    } finally {
      removePendingId(setDeletingFaqIds, id)
    }
  }

  const handleToggleFaq = async (faq: Faq) => {
    if (togglingFaqIds.has(faq.id)) return
    const nextActive = !faq.is_active
    addPendingId(setTogglingFaqIds, faq.id)
    // Optimistic flip, reverted below if the write doesn't land, so the badge
    // never claims a state the database doesn't have.
    setFaqs(prev => prev.map(f => f.id === faq.id ? { ...f, is_active: nextActive } : f))
    try {
      const { error } = await supabase.from('faqs').update({ is_active: nextActive }).eq('id', faq.id)
      if (error) {
        setFaqs(prev => prev.map(f => f.id === faq.id ? { ...f, is_active: !nextActive } : f))
        toast.error('FAQ status failed to update. Please try again.', { duration: 6000 })
      }
    } finally {
      removePendingId(setTogglingFaqIds, faq.id)
    }
  }

  const handleSaveEdit = async (faq: Faq) => {
    if (savingFaqEdit) return
    setSavingFaqEdit(true)
    try {
      const { error } = await supabase.from('faqs').update({ question: editQuestion, answer: editAnswer }).eq('id', faq.id)
      if (error) {
        // Editor stays open with editQuestion/editAnswer intact so the edit isn't lost.
        toast.error('FAQ failed to save. Please try again.', { duration: 6000 })
        return
      }
      setFaqs(prev => prev.map(f => f.id === faq.id ? { ...f, question: editQuestion, answer: editAnswer } : f))
      setEditingFaqId(null)
    } finally {
      setSavingFaqEdit(false)
    }
  }

  const handleEmojiButtonClick = () => {
    if (!showEmojiPicker && emojiButtonRef.current) {
      const rect = emojiButtonRef.current.getBoundingClientRect()
      setEmojiPickerPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      })
    }
    setShowEmojiPicker(v => !v)
  }

  // NEW346: the 2px underline is drawn by the button's own border-bottom, so without a
  // fixed width it shrank to each label's text width ("FAQs" got a much shorter underline
  // than "Conversations"). Centre the label in a 150px-minimum button so every underline
  // is the same length, matching the teacher account tab bar.
  const tabStyle = (tab: 'conversations' | 'faqs'): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '150px',
    ...(activeTab === tab
      ? { borderBottom: '2px solid #FF8303', color: '#FF8303' }
      : { borderBottom: '2px solid transparent', color: '#6b7280' }),
  })

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
          Conversations {conversations.some(c => c.unreadCount > 0) && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs text-white" style={{ backgroundColor: '#FF8303' }}>
              {conversations.reduce((acc, c) => acc + c.unreadCount, 0)}
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
          <div className="w-72 flex-shrink-0 border border-gray-200 rounded-lg overflow-y-auto bg-white thin-scroll">
            {conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <MessageSquare size={32} className="text-gray-200 mb-3" />
                <p className="text-sm text-gray-500">No support messages yet</p>
              </div>
            ) : (
              conversations.map(conv => {
                const opening = openingConvIds.has(conv.participantId)
                return (
                <button
                  key={conv.participantId}
                  onClick={() => setSelectedConv(conv)}
                  disabled={opening}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors border-b border-gray-100 disabled:opacity-60"
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
                    <p className="text-xs text-gray-400 truncate mt-0.5">{stripHtml(conv.latestMessage.content)}</p>
                  </div>
                  {/* The spinner takes the badge's slot while this row's thread is loading, so
                      the click has feedback on the row itself and not only in the thread pane. */}
                  {opening ? (
                    <Loader2 size={16} className="animate-spin flex-shrink-0" style={{ color: '#FF8303' }} />
                  ) : conv.unreadCount > 0 ? (
                    <span className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: '#FF8303' }}>
                      {conv.unreadCount}
                    </span>
                  ) : null}
                </button>
                )
              })
            )}
          </div>

          {/* Message thread */}
          <div className="flex-1 border border-gray-200 rounded-lg flex flex-col bg-white overflow-hidden">
            {!selectedConv ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <MessageSquare size={32} className="text-gray-200 mb-3" />
                <p className="text-sm text-gray-500">Select a conversation</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 flex-shrink-0">
                  <Avatar name={selectedConv.participantName} photoUrl={selectedConv.participantPhotoUrl} size={9} />
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{selectedConv.participantName}</p>
                    <p className="text-xs text-gray-400 capitalize">{selectedConv.participantType}</p>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 thin-scroll" style={{ backgroundColor: '#FFF9F3' }}>
                  {!messagesLoaded ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-xs text-gray-400">Loading...</p>
                    </div>
                  ) : messagesError ? (
                    /* A failed load must never look like an empty thread — say so and offer a retry. */
                    <div className="flex flex-col items-center justify-center h-full text-center px-6">
                      <p className="text-sm font-medium" style={{ color: '#b91c1c' }}>Messages failed to load.</p>
                      <p className="text-xs text-gray-500 mt-1">This thread may contain messages that could not be fetched.</p>
                      <button
                        onClick={() => loadMessages(selectedConv)}
                        className="mt-3 px-3 py-1.5 rounded-lg text-xs font-medium"
                        style={{ backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FF8303' }}
                      >
                        Try again
                      </button>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-xs text-gray-400">No messages in this conversation yet</p>
                    </div>
                  ) : messages.map(msg => {
                    const isAdmin = msg.sender_role === 'admin'
                    const hasContent = msg.content.replace(/<[^>]*>/g, '').trim().length > 0 || isEmojiOnly(msg.content)
                    // On-bubble ticks only where there is a real bubble to hang them in:
                    // an emoji-only message has no bubble fill, and an attachment-only
                    // message has no bubble at all, so both keep the metadata-row ticks.
                    const isBubbleTicked = isAdmin && hasContent && !isEmojiOnly(msg.content)
                    return (
                      <div key={msg.id} className={`flex ${isAdmin ? 'justify-end' : 'justify-start'} items-end gap-2`}>
                        {!isAdmin && <Avatar name={selectedConv.participantName} photoUrl={selectedConv.participantPhotoUrl} size={7} />}
                        <div className="max-w-[75%]">
                          {editingMessageId === msg.id ? (
                            /* Inline edit box replaces the bubble; attachments are never
                               modified by an edit and reappear on save/cancel. */
                            <div className="rounded-2xl border border-gray-200 bg-white px-3 py-2" style={{ minWidth: '220px' }}>
                              <div
                                className="admin-support-composer text-sm min-h-[32px] max-h-[80px] overflow-y-auto cursor-text"
                                onClick={() => editEditor?.commands.focus()}
                              >
                                <EditorContent editor={editEditor} />
                              </div>
                              <div className="flex items-center justify-end gap-2 mt-2">
                                <button
                                  onClick={handleCancelMessageEdit}
                                  className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-600 border border-gray-200 hover:bg-gray-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={handleSaveMessageEdit}
                                  disabled={savingEdit}
                                  className="px-2.5 py-1 rounded-lg text-xs font-medium disabled:opacity-50"
                                  style={{ backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FF8303' }}
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
                                className="admin-support-bubble px-3 py-2 rounded-2xl text-sm inline-flex items-end"
                                style={{ backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }}
                              >
                                <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }} />
                                <ReadTicks readAt={msg.read_at} variant="bubble" className="self-end ml-1" />
                              </div>
                            ) : (
                          <div
                            className="admin-support-bubble px-3 py-2 rounded-2xl text-sm"
                            style={isEmojiOnly(msg.content)
                              ? { fontSize: '2rem', background: 'none', padding: '4px 8px' }
                              : isAdmin
                              ? { backgroundColor: '#1f2937', color: '#f9fafb', borderBottomRightRadius: '4px' }
                              : { backgroundColor: '#ffffff', color: '#1f2937', border: '1px solid #E0DFDC', borderBottomLeftRadius: '4px' }
                            }
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.content) }}
                          />
                            )
                          )}
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div className={`flex flex-col gap-0.5 ${hasContent ? 'mt-1' : ''} ${isAdmin ? 'items-end' : 'items-start'}`}>
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
                          <div className={`flex items-center gap-1 mt-0.5 ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                            {/* Edit affordance: admin's own replies only, within the
                                15-minute window (server re-checks authoritatively),
                                never on a pending optimistic row. */}
                            {isAdmin && editingMessageId !== msg.id &&
                              !msg.pending && isWithinEditWindow(msg.created_at) && (
                              <button
                                onClick={() => handleStartMessageEdit(msg)}
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
                            {isAdmin && !isBubbleTicked && <ReadTicks readAt={msg.read_at} />}
                          </div>
                        </div>
                        {isAdmin && <Avatar name={adminProfile.full_name} photoUrl={adminProfile.photo_url} size={7} />}
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>

                <div className="border-t border-gray-200 flex-shrink-0 bg-white">
                  <style>{`
                    .admin-support-composer .ProseMirror { outline: none !important; border: none !important; box-shadow: none !important; }
                    .admin-support-composer .ProseMirror:focus { outline: none !important; border: none !important; }
                    .admin-support-composer .ProseMirror p.is-editor-empty:first-child::before { color: #9ca3af; content: attr(data-placeholder); float: left; height: 0; pointer-events: none; }
                    .admin-support-composer .ProseMirror ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
                    .admin-support-composer .ProseMirror ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
                    .admin-support-composer .ProseMirror li { margin: 0.1rem 0; }
                    .admin-support-bubble ul { list-style-type: disc; padding-left: 1.5rem; margin: 0.25rem 0; }
                    .admin-support-bubble ol { list-style-type: decimal; padding-left: 1.5rem; margin: 0.25rem 0; }
                    .admin-support-bubble li { margin: 0.1rem 0; }
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
                      <button
                        ref={emojiButtonRef}
                        onClick={handleEmojiButtonClick}
                        title="Emoji"
                        style={{ padding: '2px 6px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}
                      >😊</button>
                      {showEmojiPicker && emojiPickerPos && (
                        <div style={{ position: 'fixed', bottom: emojiPickerPos.bottom, left: emojiPickerPos.left, zIndex: 9999 }}>
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
                      {uploading
                        ? <Loader2 size={15} className="animate-spin" />
                        : <Paperclip size={15} />}
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
                      className="admin-support-composer flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus-within:border-orange-400 bg-gray-50 min-h-[36px] max-h-[80px] overflow-y-auto cursor-text transition-colors"
                      onClick={() => editor?.commands.focus()}
                    >
                      <EditorContent editor={editor} />
                    </div>
                    <button
                      onClick={handleSend}
                      disabled={sending}
                      className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 disabled:opacity-40"
                      style={{ backgroundColor: '#FF8303' }}
                    >
                      {sending
                        ? <Loader2 size={15} className="animate-spin text-white" />
                        : <Send size={15} className="text-white" />}
                    </button>
                  </div>
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
                  {savingFaq ? 'Saving...' : 'Save'}
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
                          disabled={savingFaqEdit}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-40"
                          style={{ backgroundColor: '#FF8303' }}>
                          <Check size={13} /> {savingFaqEdit ? 'Saving...' : 'Save'}
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
                            disabled={togglingFaqIds.has(faq.id)}
                            className="text-xs px-2 py-0.5 rounded-full font-medium disabled:opacity-50"
                            style={faq.is_active
                              ? { backgroundColor: '#DCFCE7', color: '#15803D' }
                              : { backgroundColor: '#f3f4f6', color: '#9ca3af' }
                            }>
                            {togglingFaqIds.has(faq.id) ? 'Saving...' : (faq.is_active ? 'Active' : 'Inactive')}
                          </button>
                          <button
                            onClick={() => { setEditingFaqId(faq.id); setEditQuestion(faq.question); setEditAnswer(faq.answer) }}
                            className="text-gray-400 hover:text-gray-600 transition-colors">
                            <Edit2 size={15} />
                          </button>
                          <button
                            onClick={() => handleDeleteFaq(faq.id)}
                            disabled={deletingFaqIds.has(faq.id)}
                            aria-label="Delete FAQ"
                            className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50">
                            {deletingFaqIds.has(faq.id)
                              ? <Loader2 size={15} className="animate-spin" />
                              : <Trash2 size={15} />}
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
