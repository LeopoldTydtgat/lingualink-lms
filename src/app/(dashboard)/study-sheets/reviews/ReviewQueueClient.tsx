'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, AlertTriangle } from 'lucide-react'

export type ReviewItem = {
  attemptId: string
  studentName: string
  activityTitle: string
  sheetTitle: string
  submittedAt: string
  prompt: string | null
  responseText: string
  promptEditedAfterSubmission: boolean
}

// Locked portal palette.
const PRIMARY = '#FF8303'
const PENDING_BG = '#FFF8E8'
const PENDING_FG = '#B45309'
const AMBER = '#FFB942'
const MAX_FEEDBACK = 5000

// Deterministic across the SSR/CSR boundary (explicit UTC, Intl only — no
// toISOString / toLocaleTimeString). Matches the ResponsesClient pattern.
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d)
}

// One queue row with an inline expandable review panel. The review view lives
// here (not a separate [attemptId] page) because the queue query already
// carries everything it needs — a sub-page would re-run the whole auth gate
// and scope resolution for a single row.
function ReviewRow({
  item,
  onReviewed,
}: {
  item: ReviewItem
  onReviewed: (attemptId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = feedback.trim().length > 0 && !saving

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/teacher/attempts/${item.attemptId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Could not save your feedback.')
        setSaving(false)
        return
      }
      // Parent removes the row and refreshes server data (header count etc.).
      onReviewed(item.attemptId)
    } catch {
      setError('Could not save your feedback.')
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6' }}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <span className="font-medium text-sm" style={{ color: '#111827' }}>
            {item.studentName}
          </span>
          <span className="text-sm truncate" style={{ color: '#4b5563' }}>
            {item.activityTitle}
          </span>
          <span className="text-xs truncate" style={{ color: '#9ca3af' }}>
            {item.sheetTitle}
          </span>
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: PENDING_BG, color: PENDING_FG }}
          >
            Pending review
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-xs hidden sm:inline" style={{ color: '#9ca3af' }}>
            {formatDate(item.submittedAt)}
          </span>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="text-sm px-3 py-1.5 rounded-md border font-medium"
            style={open
              ? { borderColor: '#E0DFDC', color: '#4b5563', backgroundColor: '#f9fafb' }
              : { borderColor: PRIMARY, color: 'white', backgroundColor: PRIMARY }}
            onMouseEnter={e => {
              if (!open) e.currentTarget.style.backgroundColor = '#e67300'
            }}
            onMouseLeave={e => {
              if (!open) e.currentTarget.style.backgroundColor = PRIMARY
            }}
          >
            {open ? 'Close' : 'Review'}
          </button>
        </div>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid #f3f4f6' }} className="px-4 py-4 space-y-4">
          {/* NEW371: prompt edited after this response was submitted */}
          {item.promptEditedAfterSubmission && (
            <div
              className="flex items-start gap-2 rounded-lg p-3"
              style={{ backgroundColor: '#FFF7EA', border: `1px solid ${AMBER}` }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: AMBER }} />
              <p className="text-sm" style={{ color: '#92660A' }}>
                The prompt was edited after this response was submitted
              </p>
            </div>
          )}

          <div>
            <p className="text-xs font-medium uppercase tracking-wide mb-1.5" style={{ color: '#9ca3af' }}>
              Prompt
            </p>
            {item.prompt !== null ? (
              <p className="text-sm whitespace-pre-wrap" style={{ color: '#111827' }}>
                {item.prompt}
              </p>
            ) : (
              <p className="text-sm" style={{ color: '#9ca3af' }}>
                This activity&apos;s prompt could not be displayed.
              </p>
            )}
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide mb-1.5" style={{ color: '#9ca3af' }}>
              Student&apos;s response
            </p>
            <div
              className="rounded-lg p-3 text-sm whitespace-pre-wrap"
              style={{ backgroundColor: '#f9fafb', border: '1px solid #f3f4f6', color: '#111827' }}
            >
              {item.responseText !== '' ? item.responseText : (
                <span style={{ color: '#9ca3af' }}>No response text was recorded.</span>
              )}
            </div>
            <p className="text-xs mt-1.5" style={{ color: '#9ca3af' }}>
              Submitted on {formatDate(item.submittedAt)}
            </p>
          </div>

          <div>
            <label
              htmlFor={`feedback-${item.attemptId}`}
              className="block text-xs font-medium uppercase tracking-wide mb-1.5"
              style={{ color: '#9ca3af' }}
            >
              Your feedback
            </label>
            <textarea
              id={`feedback-${item.attemptId}`}
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              maxLength={MAX_FEEDBACK}
              rows={5}
              placeholder="Write your feedback for the student..."
              className="w-full rounded-lg p-3 text-sm"
              style={{
                border: '1px solid #E0DFDC',
                color: '#111827',
                backgroundColor: 'white',
                resize: 'vertical',
              }}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs" style={{ color: '#9ca3af' }}>
                {feedback.length}/{MAX_FEEDBACK}
              </span>
              <button
                type="button"
                onClick={save}
                disabled={!canSave}
                className="text-sm px-4 py-1.5 rounded-md text-white font-medium"
                style={{
                  backgroundColor: canSave ? PRIMARY : '#FFC989',
                  border: `1px solid ${canSave ? PRIMARY : '#FFC989'}`,
                  cursor: canSave ? 'pointer' : 'default',
                }}
                onMouseEnter={e => {
                  if (canSave) e.currentTarget.style.backgroundColor = '#e67300'
                }}
                onMouseLeave={e => {
                  if (canSave) e.currentTarget.style.backgroundColor = PRIMARY
                }}
              >
                {saving ? 'Saving…' : 'Save feedback'}
              </button>
            </div>
            {error && (
              <p className="text-sm mt-2" style={{ color: '#FD5602' }}>
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ReviewQueueClient({ items: initialItems }: { items: ReviewItem[] }) {
  const router = useRouter()
  const [items, setItems] = useState(initialItems)

  function handleReviewed(attemptId: string) {
    setItems(prev => prev.filter(i => i.attemptId !== attemptId))
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/study-sheets"
          prefetch={false}
          className="inline-flex items-center gap-1.5 text-sm mb-3"
          style={{ color: '#4b5563' }}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Lesson Library
        </Link>
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl font-semibold" style={{ color: '#111827' }}>Review queue</h1>
          <span
            className="px-2 py-0.5 rounded-full text-xs font-semibold"
            style={{ backgroundColor: PENDING_BG, color: PENDING_FG }}
          >
            {items.length} pending
          </span>
        </div>
        <p className="text-sm mt-1" style={{ color: '#4b5563' }}>
          Written responses waiting for your feedback, oldest first
        </p>
      </div>

      {items.length === 0 ? (
        <div
          className="rounded-xl px-6 py-12 text-center text-sm shadow-sm"
          style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', color: '#9ca3af' }}
        >
          No responses are waiting for review.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => (
            <ReviewRow key={item.attemptId} item={item} onReviewed={handleReviewed} />
          ))}
        </div>
      )}
    </div>
  )
}
