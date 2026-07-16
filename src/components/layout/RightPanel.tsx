// src/components/layout/RightPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Video, ArrowRight, BookOpen, Clock, Receipt } from 'lucide-react'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NextLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teams_join_url: string | null
  student_name: string
  status: string
}

type RightPanelProps = {
  teacherId: string | null
  teacherTimezone: string | null
  nextLesson?: NextLesson | null
  billingData?: { currentAmount: number; projectedAmount: number }
  currency?: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Now'
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) {
    return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Format: "Thu 09 Apr, 10:00 – 11:00" in the teacher's account timezone.
// Built from utcInstantToTzParts (same helper as StudentRightPanel and the
// teacher schedule) so server and client render identical text — never
// getHours()/getDay() (browser-local, causes hydration mismatch) and never
// toLocaleTimeString(). Falls back to UTC if the account timezone is missing
// or invalid rather than throwing — this panel has no error boundary above it.
function formatClassTime(isoString: string, durationMinutes: number, timezone: string | null): string {
  const tz = timezone && isValidTimeZone(timezone) ? timezone : 'UTC'
  const startMs = new Date(isoString).getTime()
  const s = utcInstantToTzParts(isoString, tz)
  const e = utcInstantToTzParts(new Date(startMs + durationMinutes * 60 * 1000), tz)
  const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.weekday]
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][s.month - 1]
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${weekday} ${pad(s.day)} ${month}, ${pad(s.hour)}:${pad(s.minute)} – ${pad(e.hour)}:${pad(e.minute)}`
}

// ── Component ─────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' }

export default function RightPanel({
  teacherId,
  teacherTimezone,
  nextLesson = null,
  billingData,
  currency,
}: RightPanelProps) {
  const currencySymbol = (currency != null ? CURRENCY_SYMBOL[currency] ?? currency : '€')
  const router = useRouter()
  const [secondsUntil, setSecondsUntil] = useState<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const [now, setNow] = useState(0)
  const [joinHovered, setJoinHovered] = useState(false)

  const panelRef = useRef<HTMLElement>(null)

  const handleWheel = (e: React.WheelEvent<HTMLElement>) => {
    const panel = panelRef.current
    if (!panel) return
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight
    const atTop = panel.scrollTop === 0
    if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return
    document.querySelector('main')?.scrollBy({ top: e.deltaY })
  }

  useEffect(() => {
    setMounted(true)
    setNow(Date.now())

    if (!nextLesson) {
      setSecondsUntil(null)
      return
    }

    const calc = () =>
      Math.max(0, Math.floor((new Date(nextLesson.scheduled_at).getTime() - Date.now()) / 1000))

    setSecondsUntil(calc())

    const timer = setInterval(() => {
      setNow(Date.now())
      setSecondsUntil(calc())
    }, 1000)

    return () => clearInterval(timer)
  }, [teacherId, nextLesson])

  const classEndTime = nextLesson
    ? new Date(nextLesson.scheduled_at).getTime() + nextLesson.duration_minutes * 60 * 1000
    : null
  const classEnded = classEndTime ? Date.now() > classEndTime : false
  const remainingSeconds = classEndTime != null
    ? Math.max(0, Math.floor((classEndTime - now) / 1000))
    : 0
  const isJoinable = mounted && nextLesson != null && isLessonJoinable(nextLesson.scheduled_at, nextLesson.duration_minutes, nextLesson.status, now)

  return (
    <aside ref={panelRef} onWheel={handleWheel} className="w-72 flex flex-col shrink-0 overflow-y-auto thin-scroll" style={{ backgroundColor: '#F7F8FA' }}>
      <div className="p-4 space-y-4">

        {/* ── NEXT CLASS ── */}
        <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Clock size={14} color="#FF8303" style={{ flexShrink: 0 }} />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Next Class</p>
          </div>

          {!nextLesson ? (
            <p className="text-sm text-gray-500">No upcoming classes</p>
          ) : (
            <>
              {/* Countdown — big bold live HH:MM:SS hero, matches student panel */}
              {mounted && secondsUntil !== null && classEnded ? (
                <p className="text-sm font-semibold text-gray-900 leading-snug mb-1">Class has ended</p>
              ) : mounted && secondsUntil !== null && secondsUntil <= 0 ? (
                <p className="text-sm font-semibold leading-snug mb-1" style={{ color: '#FF8303' }}>
                  In class — {formatCountdown(remainingSeconds)} remaining
                </p>
              ) : (
                <p style={{ fontSize: '22px', fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums', lineHeight: '1.2', marginBottom: '4px' }}>
                  {mounted && secondsUntil !== null ? formatCountdown(secondsUntil) : '--:--:--'}
                </p>
              )}

              {/* Date and time range — gated on mounted (hydration-safe) and
                  rendered in the teacher's account timezone, not browser-local */}
              <p className="text-xs text-gray-500 mb-0.5">
                {mounted ? formatClassTime(nextLesson.scheduled_at, nextLesson.duration_minutes, teacherTimezone) : ''}
              </p>

              {/* Student name */}
              <p className="text-xs text-gray-500 mb-3">
                with {nextLesson.student_name}
              </p>

              {/* See Training button — always visible */}
              <Button
                variant="outline"
                size="sm"
                className="w-full text-sm border-brand-grey hover:border-brand-orange hover:text-brand-orange mb-2"
                onClick={() => router.push('/students')}
              >
                <BookOpen size={14} className="mr-2" />
                See Training
              </Button>

              {/* Join Class — always visible; greyed until 10 min before start, gone at end */}
              {nextLesson.teams_join_url ? (
                <a
                  href={isJoinable ? nextLesson.teams_join_url : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onMouseEnter={() => setJoinHovered(true)}
                  onMouseLeave={() => setJoinHovered(false)}
                  onClick={() => {
                    // Fire-and-forget teacher join-click logging. Guarded to the joinable
                    // state only, and never awaited / never throws — logging must not block
                    // or break opening Teams.
                    if (!isJoinable || !nextLesson?.teams_join_url) return
                    fetch('/api/join-click', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ lesson_id: nextLesson.id }),
                      keepalive: true,
                    }).catch(() => {})
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '8px 12px',
                    backgroundColor: isJoinable ? (joinHovered ? '#FF8303' : '#ffffff') : '#E0DFDC',
                    color: isJoinable ? (joinHovered ? '#ffffff' : '#FF8303') : '#9ca3af',
                    border: isJoinable ? '1.5px solid #FF8303' : 'none',
                    borderRadius: '8px',
                    fontSize: '14px',
                    fontWeight: 600,
                    textAlign: 'center',
                    textDecoration: 'none',
                    cursor: isJoinable ? 'pointer' : 'default',
                    pointerEvents: isJoinable ? 'auto' : 'none',
                    transition: 'background-color 0.18s ease, color 0.18s ease',
                  }}
                >
                  <Video size={14} />
                  Join Class
                </a>
              ) : (
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                  Link not yet available
                </span>
              )}
            </>
          )}
        </section>

        {/* ── BILLING SUMMARY ── */}
        <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Receipt size={14} color="#FF8303" style={{ flexShrink: 0 }} />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Billing</p>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Current month</span>
              <span className="font-semibold text-gray-900">
                {billingData != null ? `${currencySymbol} ${billingData.currentAmount.toFixed(2)}` : `${currencySymbol} –`}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Projected</span>
              <span className="font-semibold text-gray-900">
                {billingData != null ? `${currencySymbol} ${billingData.projectedAmount.toFixed(2)}` : `${currencySymbol} –`}
              </span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full text-sm border-brand-grey hover:border-brand-orange hover:text-brand-orange"
            onClick={() => router.push('/billing')}
          >
            Billing &amp; Invoices
            <ArrowRight size={14} className="ml-2" />
          </Button>
        </section>

      </div>
    </aside>
  )
}
