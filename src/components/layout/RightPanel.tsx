// src/components/layout/RightPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Video, ArrowRight, BookOpen, Clock, Receipt, Sparkles, CalendarClock, CheckCircle2, Wrench } from 'lucide-react'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'
import type { WhatsNewItem } from '@/lib/whatsNew'
import { WhatsNewRow } from '@/components/layout/whatsNewUi'
import { WeekGridSpot } from '@/components/WeekGridSpot'
import { dismissWhatsNewItem } from '@/app/(dashboard)/actions/whatsNewDismiss'

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
  offeredMinutes?: number
  minAvailableHours?: number | null
  whatsNewItems?: WhatsNewItem[]
  whatsNewSeenAt?: string | null
  showStaffTools?: boolean
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

// Soft-orange filled panel button. Hover deepens the tint. Keeps full width,
// icons, and onClick from the previous outline Button.
function PanelButton({ onClick, className, children }: { onClick: () => void; className?: string; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '8px 12px',
        borderRadius: '8px',
        backgroundColor: hovered ? '#FFE4CC' : '#FFF0E0',
        color: '#FF8303',
        border: 'none',
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'background-color 0.18s ease',
      }}
    >
      {children}
    </button>
  )
}

export default function RightPanel({
  teacherId,
  teacherTimezone,
  nextLesson = null,
  billingData,
  currency,
  offeredMinutes = 0,
  minAvailableHours = null,
  whatsNewItems = [],
  whatsNewSeenAt = null,
  showStaffTools = false,
}: RightPanelProps) {
  const currencySymbol = (currency != null ? CURRENCY_SYMBOL[currency] ?? currency : '€')
  const router = useRouter()
  const pathname = usePathname()
  const [secondsUntil, setSecondsUntil] = useState<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const [now, setNow] = useState(0)
  const [joinHovered, setJoinHovered] = useState(false)
  const [viewAllHovered, setViewAllHovered] = useState(false)
  // Optimistically hidden keys: rows the user just dismissed, removed immediately
  // while the server write + router.refresh() catch up. Cleared naturally once the
  // refreshed props no longer contain them (fetchWhatsNew filters dismissed keys).
  // Mirrors NotificationsBell so both surfaces get the same per-item cross.
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())

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

  // What's New seen split. The panel is passive — it never stamps; it only reads
  // the server-provided marker to separate fresh from already-seen items. ISO UTC
  // strings compare lexicographically in chronological order. Order within each
  // group is preserved from fetchWhatsNew (attention first, then newest). The
  // panel shows at most 3 items total: unseen first, then seen items fill any
  // remaining slots under an "Earlier" divider. "View all" opens the bell for
  // the rest.
  const isWhatsNewSeen = (item: WhatsNewItem) => whatsNewSeenAt != null && item.at <= whatsNewSeenAt
  // Exclude optimistically-dismissed rows BEFORE slicing so hiding one surfaces
  // the next within the 3-item cap.
  const visibleWhatsNew = whatsNewItems.filter((i) => !hiddenKeys.has(i.id))
  const unseenWhatsNew = visibleWhatsNew.filter((i) => !isWhatsNewSeen(i)).slice(0, 3)
  const seenWhatsNew = visibleWhatsNew
    .filter((i) => isWhatsNewSeen(i))
    .slice(0, Math.max(0, 3 - unseenWhatsNew.length))

  // Dismiss one item: hide it locally for instant feedback, AWAIT the write, then
  // refresh so the server feed becomes the source of truth. Same await-then-refresh
  // order as NotificationsBell.handleDismiss.
  const handleDismiss = async (key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      await dismissWhatsNewItem(key)
    } catch {
      // write failed; the next full load will restore the row honestly
    }
    router.refresh()
  }

  // Availability ring. All inputs are server props (no Date, no state) so this is
  // hydration-safe. pct is null when there is no numeric target — the card then
  // shows offered hours without a ring rather than inventing a percentage.
  const targetMinutes = minAvailableHours != null ? minAvailableHours * 60 : null
  const pct = targetMinutes && targetMinutes > 0
    ? Math.min(100, Math.round((offeredMinutes / targetMinutes) * 100))
    : null
  const offeredLabel = `${Math.floor(offeredMinutes / 60)}h ${String(offeredMinutes % 60).padStart(2, '0')}min`

  return (
    <aside ref={panelRef} onWheel={handleWheel} className="w-72 flex flex-col shrink-0 overflow-y-auto thin-scroll" style={{ backgroundColor: '#F7F8FA', borderLeft: '1px solid #E5E7EB' }}>
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
              <PanelButton
                className="w-full text-sm mb-2"
                onClick={() => router.push('/students')}
              >
                <BookOpen size={14} className="mr-2" />
                See Training
              </PanelButton>

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

        {/* ── STAFF TOOLS ── */}
        {showStaffTools && (
          <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-2">
              <Wrench size={14} color="#FF8303" style={{ flexShrink: 0 }} />
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Staff Tools</p>
            </div>
            <PanelButton
              className="w-full text-sm mb-2"
              onClick={() => router.push('/admin/classes')}
            >
              <CalendarClock size={14} className="mr-2" />
              Manage Classes
            </PanelButton>
            <PanelButton
              className="w-full text-sm mb-2"
              onClick={() => router.push('/admin/students')}
            >
              <BookOpen size={14} className="mr-2" />
              Students
            </PanelButton>
            <PanelButton
              className="w-full text-sm"
              onClick={() => router.push('/admin/support')}
            >
              <ArrowRight size={14} className="mr-2" />
              Support Inbox
            </PanelButton>
          </section>
        )}

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
          <PanelButton
            className="mt-3 w-full text-sm"
            onClick={() => router.push('/billing')}
          >
            Billing &amp; Invoices
            <ArrowRight size={14} className="ml-2" />
          </PanelButton>
        </section>

        {/* ── AVAILABILITY ── */}
        <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <CalendarClock size={14} color="#FF8303" style={{ flexShrink: 0 }} />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Availability</p>
          </div>

          {offeredMinutes === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
              <WeekGridSpot />
              <p style={{ fontSize: '14px', fontWeight: 600, color: '#111827', marginTop: '4px' }}>No availability set</p>
              <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px', marginBottom: '12px' }}>
                Add weekly slots so students can book with you.
              </p>
              <PanelButton className="w-full text-sm" onClick={() => router.push('/schedule')}>
                Set availability
              </PanelButton>
            </div>
          ) : pct === null ? (
            <>
              <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '12px' }}>
                {`You're offering ${offeredLabel} this week.`}
              </p>
              <PanelButton className="w-full text-sm" onClick={() => router.push('/schedule')}>
                Edit availability
              </PanelButton>
            </>
          ) : pct === 100 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <CheckCircle2 size={14} color="#22C55E" style={{ flexShrink: 0 }} />
              <p style={{ fontSize: '12px', color: '#6b7280' }}>{offeredLabel} offered · target met</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div style={{ position: 'relative', width: '84px', height: '84px', flexShrink: 0 }}>
                  <svg width="84" height="84" viewBox="0 0 84 84">
                    <circle cx="42" cy="42" r="34" fill="none" stroke="#F3F4F6" strokeWidth="8" />
                    <circle
                      cx="42"
                      cy="42"
                      r="34"
                      fill="none"
                      stroke="#FFB942"
                      strokeWidth="8"
                      strokeLinecap="round"
                      strokeDasharray={`${(pct / 100) * 213.63} 213.63`}
                      transform="rotate(-90 42 42)"
                    />
                  </svg>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: '16px', fontWeight: 500, color: '#111827', lineHeight: 1.1 }}>{pct}%</span>
                    <span style={{ fontSize: '10px', color: '#9ca3af', lineHeight: 1.1 }}>of target</span>
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>
                    Almost there
                  </p>
                  <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>
                    {`You're offering ${offeredLabel} of the ${minAvailableHours}h weekly target.`}
                  </p>
                </div>
              </div>
              <PanelButton className="mt-3 w-full text-sm" onClick={() => router.push('/schedule')}>
                Edit availability
              </PanelButton>
            </>
          )}
        </section>

        {/* ── WHAT'S NEW ── */}
        <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={14} color="#FF8303" style={{ flexShrink: 0 }} />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">What&apos;s New</p>
          </div>
          {whatsNewItems.length === 0 ? (
            <p className="text-sm text-gray-500">No new activity</p>
          ) : (
            <div className="flex flex-col">
              {unseenWhatsNew.map((item) => (
                <WhatsNewRow
                  key={item.id}
                  item={item}
                  mounted={mounted}
                  seen={false}
                  onDismiss={() => handleDismiss(item.id)}
                  onClick={() => {
                    const targetPath = item.href.split('?')[0].split('#')[0]
                    if (pathname !== targetPath) router.push(item.href)
                  }}
                />
              ))}
              {seenWhatsNew.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 8px 4px' }}>
                    <span className="text-gray-400 uppercase tracking-wider" style={{ fontSize: '11px' }}>Earlier</span>
                    <span style={{ flex: 1, height: '1px', backgroundColor: '#f3f4f6' }} />
                  </div>
                  {seenWhatsNew.map((item) => (
                    <WhatsNewRow
                      key={item.id}
                      item={item}
                      mounted={mounted}
                      seen={true}
                      onDismiss={() => handleDismiss(item.id)}
                      onClick={() => {
                    const targetPath = item.href.split('?')[0].split('#')[0]
                    if (pathname !== targetPath) router.push(item.href)
                  }}
                    />
                  ))}
                </>
              )}
            </div>
          )}
          {whatsNewItems.length > 3 && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('open-whats-new'))}
              onMouseEnter={() => setViewAllHovered(true)}
              onMouseLeave={() => setViewAllHovered(false)}
              style={{
                marginTop: '8px',
                alignSelf: 'flex-start',
                fontSize: '12px',
                fontWeight: 600,
                color: viewAllHovered ? '#FD5602' : '#FF8303',
                backgroundColor: 'transparent',
                border: 'none',
                padding: '4px 8px',
                cursor: 'pointer',
                transition: 'color 0.15s ease',
              }}
            >
              View all
            </button>
          )}
        </section>

      </div>
    </aside>
  )
}
