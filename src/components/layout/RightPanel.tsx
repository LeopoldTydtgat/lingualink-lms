// src/components/layout/RightPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Video, ArrowRight, BookOpen, Clock, Receipt, Sparkles, CalendarClock, CheckCircle2, Wrench, ChevronDown, ChevronUp } from 'lucide-react'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { utcInstantToTzParts, isValidTimeZone } from '@/lib/utils/timezone'
import type { WhatsNewItem } from '@/lib/whatsNew'
import { WhatsNewRow } from '@/components/layout/whatsNewUi'
import { WeekGridSpot } from '@/components/WeekGridSpot'
import { createClient } from '@/lib/supabase/client'
import { dismissWhatsNewItem, clearAllWhatsNew } from '@/app/(dashboard)/actions/whatsNewDismiss'

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
  showStaffTools = false,
}: RightPanelProps) {
  const currencySymbol = (currency != null ? CURRENCY_SYMBOL[currency] ?? currency : '€')
  const router = useRouter()
  const pathname = usePathname()
  const [secondsUntil, setSecondsUntil] = useState<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const [now, setNow] = useState(0)
  const [joinHovered, setJoinHovered] = useState(false)
  // What's New shows 3 rows by default and expands in place to the full feed.
  const [whatsNewExpanded, setWhatsNewExpanded] = useState(false)
  const [expandHovered, setExpandHovered] = useState(false)
  const [clearAllHovered, setClearAllHovered] = useState(false)
  // Set by a successful "Clear all" and then NEVER reset for the life of this
  // mount — the old bell reset it on dropdown close, and this card has no
  // equivalent close event. It only swaps the empty-state copy to a friendlier
  // "All caught up", so the visible consequence is that a feed which later
  // refills and is dismissed row-by-row also reads "All caught up" instead of
  // "No new activity". Cosmetic and accepted. Not set when the drain throws.
  const [clearedJustNow, setClearedJustNow] = useState(false)
  // Staff Tools is collapsed by default; the header row toggles it.
  const [staffToolsOpen, setStaffToolsOpen] = useState(false)
  // Optimistically hidden keys: rows the user just dismissed, removed immediately
  // while the server write + router.refresh() catch up. Cleared naturally once the
  // refreshed props no longer contain them (fetchWhatsNew filters dismissed keys);
  // a write that fails removes its own key again so the row comes straight back.
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())

  const panelRef = useRef<HTMLElement>(null)
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Realtime: refresh the feed when any source table it is built from changes in
  // another session. Moved here verbatim from the deleted NotificationsBell, which
  // used to own the only What's New subscription. Mirrors BillingRealtimeRefresher —
  // one channel, postgres_changes scoped to this teacher wherever a teacher_id
  // column exists, and a debounced router.refresh(). This ONLY asks Next.js to
  // re-run the layout; the server refetch (fetchWhatsNew) stays the single source
  // of truth for what shows, and dismiss logic is untouched.
  //
  // The teacherId prop is deliberately NOT used as the filter key even though it
  // holds the same uuid: awaiting a real auth.getUser() also guarantees the shared
  // browser client has finished seeding the socket JWT (see supabase/client.ts)
  // before .subscribe() runs. Swapping in the prop would let subscribe race that
  // seeding and silently drop RLS-filtered events.
  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false

    // Coalesce a burst of events (e.g. a rebooking that DELETEs then INSERTs) into a
    // single refresh within 800ms.
    const scheduleRefresh = () => {
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current)
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null
        router.refresh()
      }, 800)
    }

    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const uid = user.id

      channel = supabase
        .channel(`whats-new-${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reports', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'training_teachers', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        // trainings has no teacher_id column, so this subscription is unfiltered: a
        // trainings change anywhere triggers this teacher's refetch. The refetch is
        // teacher-scoped by RLS so it cannot leak other teachers' data; low volume.
        .on('postgres_changes', { event: '*', schema: 'public', table: 'trainings' }, scheduleRefresh)
        .subscribe()
    })()

    return () => {
      cancelled = true
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current)
        refreshDebounceRef.current = null
      }
      if (channel) supabase.removeChannel(channel)
    }
  }, [router])

  const classEndTime = nextLesson
    ? new Date(nextLesson.scheduled_at).getTime() + nextLesson.duration_minutes * 60 * 1000
    : null
  const classEnded = classEndTime ? Date.now() > classEndTime : false
  const remainingSeconds = classEndTime != null
    ? Math.max(0, Math.floor((classEndTime - now) / 1000))
    : 0
  const isJoinable = mounted && nextLesson != null && isLessonJoinable(nextLesson.scheduled_at, nextLesson.duration_minutes, nextLesson.status, now)

  // What's New is one flat list — no seen/unseen split, no "Earlier" divider. Order
  // is exactly what fetchWhatsNew returns (attention items first, then newest
  // first); the panel never re-sorts, so an urgent item with an old synthetic
  // timestamp cannot sink below fresher chatter. Optimistically-dismissed rows are
  // excluded BEFORE the 3-row slice so hiding one surfaces the next.
  const visibleWhatsNew = whatsNewItems.filter((i) => !hiddenKeys.has(i.id))
  const shownWhatsNew = whatsNewExpanded ? visibleWhatsNew : visibleWhatsNew.slice(0, 3)

  // Dismiss one item: hide it locally for instant feedback, AWAIT the write, then
  // refresh so the server feed becomes the source of truth.
  //
  // The action THROWS when the write fails, and the catch REVERTS the optimistic
  // hide. The revert is mandatory: router.refresh() re-runs the server layout but
  // preserves client state, so a key left in hiddenKeys would keep hiding a row
  // the server still returns — invisible until a full page reload.
  const handleDismiss = async (key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      await dismissWhatsNewItem(key)
    } catch {
      // Write failed — un-hide the row so the panel stays honest.
      setHiddenKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
    router.refresh()
  }

  // Clear the WHOLE feed, not just the 3 visible rows. Optimistically hide every
  // currently-visible key for instant feedback, then AWAIT the server drain
  // (clearAllWhatsNew recomputes and dismisses every page), flag "All caught up"
  // on success, and refresh. Same await-then-refresh order as handleDismiss.
  //
  // On a thrown failure every key hidden by THIS invocation is restored (same
  // reason as handleDismiss — refresh does not reset client state) and
  // clearedJustNow stays false. The keys are guaranteed absent from hiddenKeys
  // beforehand because visibleWhatsNew is already filtered by it, so deleting them
  // restores exactly the pre-click state.
  //
  // KNOWN GAP (pre-existing, in the action): clearAllWhatsNew RESOLVES rather than
  // throws when its own auth.getUser() yields no user, so an expired session
  // drains nothing yet still reaches the success path here — the card would show
  // "All caught up" over an undrained feed. Closing it requires the server action
  // to throw on a null user; deliberately not changed alongside the bell removal.
  const handleClearAll = async () => {
    const keys = visibleWhatsNew.map((i) => i.id)
    if (keys.length === 0) return
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => next.add(k))
      return next
    })
    try {
      await clearAllWhatsNew()
      setClearedJustNow(true)
      setWhatsNewExpanded(false)
    } catch {
      // Drain failed — un-hide every row this invocation hid.
      setHiddenKeys((prev) => {
        const next = new Set(prev)
        keys.forEach((k) => next.delete(k))
        return next
      })
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
      {/* pb-24 keeps the last card clear of the floating ChatWidget launcher
          (fixed bottom-6 right-6, 52px tall → occupies the bottom 76px). */}
      <div className="px-4 pt-4 pb-24 space-y-4">

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

        {/* ── WHAT'S NEW ── */}
        <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={14} color="#FF8303" style={{ flexShrink: 0 }} />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">What&apos;s New</p>
            {visibleWhatsNew.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                onMouseEnter={() => setClearAllHovered(true)}
                onMouseLeave={() => setClearAllHovered(false)}
                style={{
                  marginLeft: 'auto',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: clearAllHovered ? '#FF8303' : '#9ca3af',
                  backgroundColor: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  transition: 'color 0.15s ease',
                }}
              >
                Clear all
              </button>
            )}
          </div>

          {visibleWhatsNew.length === 0 ? (
            clearedJustNow ? (
              <p className="text-sm text-gray-500">All caught up</p>
            ) : (
              <p className="text-sm text-gray-500">No new activity</p>
            )
          ) : (
            <div className="flex flex-col">
              {shownWhatsNew.map((item) => (
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
            </div>
          )}

          {visibleWhatsNew.length > 3 && (
            <button
              type="button"
              onClick={() => setWhatsNewExpanded((v) => !v)}
              aria-expanded={whatsNewExpanded}
              onMouseEnter={() => setExpandHovered(true)}
              onMouseLeave={() => setExpandHovered(false)}
              style={{
                marginTop: '8px',
                alignSelf: 'flex-start',
                fontSize: '12px',
                fontWeight: 600,
                color: expandHovered ? '#FD5602' : '#FF8303',
                backgroundColor: 'transparent',
                border: 'none',
                padding: '4px 8px',
                cursor: 'pointer',
                transition: 'color 0.15s ease',
              }}
            >
              {whatsNewExpanded ? 'Show less' : `View all (${visibleWhatsNew.length})`}
            </button>
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
          <PanelButton
            className="mt-3 w-full text-sm"
            onClick={() => router.push('/billing')}
          >
            Billing &amp; Invoices
            <ArrowRight size={14} className="ml-2" />
          </PanelButton>
        </section>

        {/* ── STAFF TOOLS ── collapsed by default */}
        {showStaffTools && (
          <section className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <button
              type="button"
              onClick={() => setStaffToolsOpen((v) => !v)}
              aria-expanded={staffToolsOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: 0,
                border: 'none',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                marginBottom: staffToolsOpen ? '8px' : 0,
              }}
            >
              <Wrench size={14} color="#FF8303" style={{ flexShrink: 0 }} />
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Staff Tools</p>
              <span style={{ marginLeft: 'auto', display: 'flex' }}>
                {staffToolsOpen
                  ? <ChevronUp size={14} color="#9ca3af" />
                  : <ChevronDown size={14} color="#9ca3af" />}
              </span>
            </button>

            {staffToolsOpen && (
              <>
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
              </>
            )}
          </section>
        )}

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

      </div>
    </aside>
  )
}
