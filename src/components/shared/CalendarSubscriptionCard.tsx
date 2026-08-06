'use client'

import { useEffect, useRef, useState } from 'react'
import { CalendarPlus, Check, Copy, Loader2, RefreshCw } from 'lucide-react'

// Shared by the teacher Schedule page and the student My Classes page.
//
// One component serves both portals because the endpoint it calls,
// /api/calendar-subscription/token, derives teacher-vs-student identity from
// the session on the server. The card therefore needs no props and can hold no
// portal-specific behaviour, which is what makes sharing it safe rather than
// merely convenient.
//
// The link is fetched lazily, on first open, rather than on mount: a GET to the
// issuing route is get-or-create, so an eager fetch would mint a token row for
// every user who ever loads the page, including those who never subscribe.

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

export default function CalendarSubscriptionCard() {
  const [state, setState] = useState<CardState>('idle')
  const [url, setUrl] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const [copyOk, setCopyOk] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

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

  return (
    <div
      style={{
        backgroundColor: '#ffffff',
        border: `1px solid ${CARD_EDGE}`,
        borderRadius: '12px',
        padding: '20px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: BRAND_TINT,
            flexShrink: 0,
          }}
        >
          <CalendarPlus size={16} style={{ color: BRAND }} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: TEXT_STRONG, marginBottom: '4px' }}>
            Calendar subscription
          </h3>
          <p style={{ fontSize: '13px', color: TEXT_MUTED, lineHeight: 1.5 }}>
            Paste this link into Google Calendar, Outlook or Apple Calendar using their
            subscribe by URL option, and your classes stay in sync automatically. New
            bookings, reschedules and cancellations all follow on their own.
          </p>
        </div>
      </div>

      <div style={{ marginTop: '16px' }}>
        {state === 'idle' && (
          <button
            onClick={loadLink}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              backgroundColor: BRAND,
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Show subscription link
          </button>
        )}

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
        {state === 'ready' && url.length > 0 && (
          <div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                readOnly
                value={url}
                aria-label="Calendar subscription link"
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  flex: '1 1 320px',
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

            {confirmingReset ? (
              <div
                style={{
                  marginTop: '12px',
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
                  marginTop: '12px',
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
  )
}
