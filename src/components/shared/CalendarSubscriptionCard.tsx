'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarPlus, Check, ChevronDown, ChevronUp, Copy, Loader2, RefreshCw, X } from 'lucide-react'

// Shared by the teacher Schedule page and the student My Classes page.
//
// One component serves both portals because the endpoint it calls,
// /api/calendar-subscription/token, derives teacher-vs-student identity from
// the session on the server. It therefore needs no portal-specific props and
// can hold no portal-specific behaviour, which is what makes sharing it safe
// rather than merely convenient.
//
// The link is fetched lazily, on first modal open, rather than on mount: a GET
// to the issuing route is get-or-create, so an eager fetch would mint a token
// row for every user who ever loads the page, including those who never
// subscribe. Reopening the modal reuses the already-loaded state.

type CardState = 'idle' | 'loading' | 'ready' | 'error'

const BRAND = '#FF8303'
const BRAND_TINT = '#FFF3E0'
const BRAND_EDGE = '#FFD9A8'
const CARD_EDGE = '#E0DFDC'
const TEXT_STRONG = '#111827'
const TEXT_BODY = '#374151'
const TEXT_MUTED = '#6b7280'
const DANGER = '#DC2626'
const DANGER_TINT = '#FEF2F2'
const DANGER_EDGE = '#FECACA'
const SUCCESS = '#16A34A'

// Step text lives in JS rather than JSX so the embedded double quotes need no
// entity escaping.
const HOW_TO: { app: string; steps: string[] }[] = [
  {
    app: 'Google Calendar',
    steps: [
      'Copy the link above.',
      'In Google Calendar, next to "Other calendars" click + and choose "From URL".',
      'Paste the link and click "Add calendar".',
    ],
  },
  {
    app: 'Outlook',
    steps: [
      'Copy the link above.',
      'In Outlook Calendar, choose "Add calendar" then "Subscribe from web".',
      'Paste the link and click "Import".',
    ],
  },
  {
    app: 'Apple Calendar',
    steps: [
      'Copy the link above.',
      'In the Calendar app choose File, then "New Calendar Subscription".',
      'Paste the link and click "Subscribe".',
    ],
  },
]

// buttonRadius exists only because the two host pages use different secondary
// button radii (Schedule: 8px, My Classes: 6px). Presentation only.
export default function CalendarSubscriptionCard({
  buttonRadius = '8px',
}: {
  buttonRadius?: string
}) {
  const [open, setOpen] = useState(false)
  const [triggerHovered, setTriggerHovered] = useState(false)
  const [state, setState] = useState<CardState>('idle')
  const [url, setUrl] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const [copyOk, setCopyOk] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [expandedApp, setExpandedApp] = useState<string | null>(null)

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  // Escape closes. Listener attached only while the modal is open, so it never
  // competes with anything else on the page.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Locks background scroll while the modal is open. The previous value is
  // captured before overwriting so the restore on cleanup can never clobber a
  // lock some other component already had in place.
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  // Returns the FULL feed URL or throws. Building it here rather than in the
  // caller means a partial result can never reach state: either a complete URL
  // is returned or the caller lands in its catch.
  async function requestFeedUrl(method: 'GET' | 'POST'): Promise<string> {
    const res = await fetch('/api/calendar-subscription/token', {
      method,
      cache: 'no-store',
    })
    if (!res.ok) {
      throw new Error(`${method} /api/calendar-subscription/token responded ${res.status}`)
    }
    const body = await res.json()
    const token = typeof body?.token === 'string' ? body.token.trim() : ''
    if (!token) {
      throw new Error(`${method} /api/calendar-subscription/token returned no token`)
    }
    return `${window.location.origin}/api/calendar-feed/${token}`
  }

  function flashCopyMessage(message: string, ok: boolean, ms: number) {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    setCopyMsg(message)
    setCopyOk(ok)
    copyTimer.current = setTimeout(() => {
      setCopyMsg('')
      setCopyOk(false)
    }, ms)
  }

  async function loadLink() {
    setState('loading')
    setErrorMsg('')
    setCopyMsg('')
    setCopyOk(false)
    try {
      const feedUrl = await requestFeedUrl('GET')
      setUrl(feedUrl)
      setState('ready')
    } catch (err) {
      console.error('[CalendarSubscriptionCard] could not load the subscription link:', err)
      setUrl('')
      setErrorMsg('Could not load your subscription link. Please try again.')
      setState('error')
    }
  }

  async function resetLink() {
    setIsResetting(true)
    setErrorMsg('')
    setCopyMsg('')
    setCopyOk(false)
    try {
      const feedUrl = await requestFeedUrl('POST')
      setUrl(feedUrl)
      setState('ready')
      setConfirmingReset(false)
    } catch (err) {
      console.error('[CalendarSubscriptionCard] could not reset the subscription link:', err)
      // The rotate may have revoked the old link before failing, so the URL on
      // screen can no longer be trusted. Clear it rather than present a link
      // that might already be dead, and send the user back through a fresh load.
      setUrl('')
      setConfirmingReset(false)
      setErrorMsg('Could not reset your link. Load it again to see which link is currently active.')
      setState('error')
    } finally {
      setIsResetting(false)
    }
  }

  async function copyLink() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      flashCopyMessage('Copied', true, 2000)
    } catch (err) {
      console.error('[CalendarSubscriptionCard] clipboard write failed:', err)
      flashCopyMessage('Could not copy automatically - select the link and copy it manually.', false, 6000)
    }
  }

  // The fetch happens here, on open - not on mount and not on trigger render.
  // Only an untouched ('idle') component fetches: a link already loaded is
  // reused, and a previous failure still ends at the explicit Try again button.
  function openModal() {
    setOpen(true)
    if (state === 'idle') loadLink()
  }

  // A reset left mid-confirmation, or a copy flash, must not be sitting on
  // screen the next time the modal opens. The link state itself is kept.
  function closeModal() {
    setOpen(false)
    setConfirmingReset(false)
    setExpandedApp(null)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    setCopyMsg('')
    setCopyOk(false)
  }

  const linkReady = state === 'ready' && url.length > 0

  return (
    <>
      <button
        onClick={openModal}
        onMouseEnter={() => setTriggerHovered(true)}
        onMouseLeave={() => setTriggerHovered(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '7px 14px',
          backgroundColor: triggerHovered ? '#F9FAFB' : '#ffffff',
          color: TEXT_BODY,
          border: `1px solid ${CARD_EDGE}`,
          borderRadius: buttonRadius,
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          transition: 'background-color 0.18s ease',
          boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
        }}
      >
        <CalendarPlus size={14} />
        Add to my calendar
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          // Only a press that starts AND lands on the backdrop closes - a text
          // selection dragged out of the panel must not dismiss it.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal()
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-subscription-title"
            className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto thin-scroll"
          >
            <div style={{ padding: '20px 24px 24px' }}>

              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div style={{ minWidth: 0 }}>
                  <h2
                    id="calendar-subscription-title"
                    style={{ fontSize: '16px', fontWeight: 700, color: TEXT_STRONG, marginBottom: '4px' }}
                  >
                    Add your classes to your calendar
                  </h2>
                  <p style={{ fontSize: '13px', color: TEXT_MUTED, lineHeight: 1.5 }}>
                    Paste this link into your calendar app once - after that, new bookings,
                    reschedules and cancellations appear automatically.
                  </p>
                </div>
                <button
                  onClick={closeModal}
                  aria-label="Close"
                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                >
                  <X size={18} />
                </button>
              </div>

              {/* Link block */}
              <div style={{ marginTop: '16px' }}>
                {state === 'loading' && (
                  <p
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '13px',
                      color: TEXT_MUTED,
                    }}
                  >
                    <Loader2 size={14} className="animate-spin" />
                    Loading your link...
                  </p>
                )}

                {state === 'error' && (
                  <div>
                    <p
                      style={{
                        fontSize: '13px',
                        color: DANGER,
                        backgroundColor: DANGER_TINT,
                        border: `1px solid ${DANGER_EDGE}`,
                        borderRadius: '6px',
                        padding: '8px 12px',
                        marginBottom: '12px',
                      }}
                    >
                      {errorMsg}
                    </p>
                    <button
                      onClick={loadLink}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 16px',
                        backgroundColor: '#ffffff',
                        color: TEXT_BODY,
                        border: '1px solid #D1D5DB',
                        borderRadius: '8px',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Try again
                    </button>
                  </div>
                )}

                {/* Rendered only when a complete URL is in hand - a half-built link is
                    never shown, because a truncated feed URL pasted into a calendar app
                    fails silently days later. */}
                {linkReady && (
                  <div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        readOnly
                        value={url}
                        aria-label="Calendar subscription link"
                        onFocus={(e) => e.currentTarget.select()}
                        style={{
                          flex: '1 1 280px',
                          minWidth: 0,
                          padding: '8px 12px',
                          backgroundColor: '#F9FAFB',
                          border: '1px solid #E5E7EB',
                          borderRadius: '8px',
                          fontSize: '12px',
                          color: TEXT_BODY,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        }}
                      />
                      <button
                        onClick={copyLink}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '8px 16px',
                          backgroundColor: BRAND_TINT,
                          color: BRAND,
                          border: `1px solid ${BRAND_EDGE}`,
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                      >
                        {copyOk ? <Check size={14} /> : <Copy size={14} />}
                        Copy
                      </button>
                    </div>

                    {copyMsg && (
                      <p style={{ fontSize: '12px', color: copyOk ? SUCCESS : DANGER, marginTop: '8px' }}>
                        {copyMsg}
                      </p>
                    )}

                    {errorMsg && (
                      <p style={{ fontSize: '12px', color: DANGER, marginTop: '8px' }}>
                        {errorMsg}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Instructions */}
              <div style={{ marginTop: '20px' }}>
                <h3 style={{ fontSize: '13px', fontWeight: 700, color: TEXT_STRONG, marginBottom: '10px' }}>
                  How to add it
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {HOW_TO.map((entry) => {
                    const isExpanded = expandedApp === entry.app
                    return (
                      <div
                        key={entry.app}
                        style={{
                          border: `1px solid ${CARD_EDGE}`,
                          borderRadius: '8px',
                        }}
                      >
                        <button
                          onClick={() => setExpandedApp(isExpanded ? null : entry.app)}
                          aria-expanded={isExpanded}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            width: '100%',
                            padding: '12px 14px',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <p style={{ fontSize: '13px', fontWeight: 600, color: TEXT_STRONG }}>
                            {entry.app}
                          </p>
                          {isExpanded ? (
                            <ChevronUp size={14} color={TEXT_MUTED} />
                          ) : (
                            <ChevronDown size={14} color={TEXT_MUTED} />
                          )}
                        </button>
                        {isExpanded && (
                          <ol style={{ margin: 0, padding: '0 14px 12px 32px', listStyleType: 'decimal' }}>
                            {entry.steps.map((step, i) => (
                              <li key={i} style={{ fontSize: '12.5px', color: TEXT_BODY, lineHeight: 1.6 }}>
                                {step}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Reset - bottom of the modal, behind its own in-place confirmation.
                  Gated on a loaded link exactly as before: there is nothing to
                  rotate until one has been issued. */}
              {linkReady && (
                <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: `1px solid ${CARD_EDGE}` }}>
                  {confirmingReset ? (
                    <div
                      style={{
                        padding: '10px 14px',
                        backgroundColor: DANGER_TINT,
                        border: `1px solid ${DANGER_EDGE}`,
                        borderRadius: '6px',
                      }}
                    >
                      <p style={{ fontSize: '13px', color: DANGER, marginBottom: '8px', lineHeight: 1.5 }}>
                        Resetting creates a new link and permanently breaks the current one. Any
                        calendar already subscribed stops updating until you paste the new link
                        into it. Continue?
                      </p>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          onClick={resetLink}
                          disabled={isResetting}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 14px',
                            backgroundColor: DANGER,
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: isResetting ? 'wait' : 'pointer',
                            opacity: isResetting ? 0.7 : 1,
                          }}
                        >
                          {isResetting && <Loader2 size={12} className="animate-spin" />}
                          {isResetting ? 'Resetting...' : 'Yes, reset link'}
                        </button>
                        <button
                          onClick={() => setConfirmingReset(false)}
                          disabled={isResetting}
                          style={{
                            padding: '6px 14px',
                            backgroundColor: 'transparent',
                            color: TEXT_BODY,
                            border: `1px solid ${CARD_EDGE}`,
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: isResetting ? 'wait' : 'pointer',
                            opacity: isResetting ? 0.7 : 1,
                          }}
                        >
                          Keep current link
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setErrorMsg('')
                        setConfirmingReset(true)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: 0,
                        background: 'none',
                        border: 'none',
                        color: TEXT_MUTED,
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <RefreshCw size={12} />
                      Reset link
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
