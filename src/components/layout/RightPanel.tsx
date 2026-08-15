// src/components/layout/RightPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Video, ArrowRight, BookOpen, Clock, Receipt, Sparkles, CalendarClock, CheckCircle2, Wrench, ChevronDown, ChevronUp } from 'lucide-react'
import { isLessonJoinable } from '@/lib/billing/joinable'
import { describeLessonCountdown, formatRemainingCountdown, formatHeroCountdown } from '@/lib/lessons/countdown'
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
  // "May 2026"-style label for the previous month when its invoice still needs
  // uploading, null when the reminder must not show. The whole decision — upload
  // window, teacher timezone, uploaded_at — is made server-side in
  // (dashboard)/layout.tsx; this component only renders off the prop.
  invoiceReminderLabel: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  invoiceReminderLabel,
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
  // Set by a successful "Clear all" — swaps the empty-state copy to a friendlier
  // "All caught up". Not set when the drain throws. The old bell reset it on
  // dropdown close and this card has no equivalent close event, so the reset is
  // keyed on the feed refilling instead (see the adjustment below visibleWhatsNew).
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
  // used to own the only What's New subscription. One channel, postgres_changes
  // scoped to this teacher wherever a teacher_id column exists, and a debounced
  // router.refresh(). This ONLY asks Next.js to re-run the layout; the server
  // refetch (fetchWhatsNew) stays the single source of truth for what shows, and
  // dismiss logic is untouched.
  //
  // This is now the (dashboard) layout's ONLY realtime refresher. It absorbed the
  // deleted BillingRealtimeRefresher, whose subscription (lessons filtered to this
  // same teacher_id) and focus refresh were both strict subsets of what runs here —
  // two components mounted in one layout meant two router.refresh() calls per focus,
  // and router.refresh() re-runs the whole layout, so the billing summary this panel
  // renders is recomputed by the refresh below exactly as it was before.
  //
  // The teacherId prop is deliberately NOT used as the filter key even though it
  // holds the same uuid: awaiting a real auth.getUser() also guarantees the shared
  // browser client has finished seeding the socket JWT (see supabase/client.ts)
  // before .subscribe() runs. Swapping in the prop would let subscribe race that
  // seeding and silently drop RLS-filtered events.
  //
  // A null/failed getUser() is NOT terminal. It used to be: the async setup
  // returned, no channel was ever created, nothing retried, and the card silently
  // stopped receiving cross-session updates for the whole mount. Now the attempt
  // leaves `health` at 'unhealthy' and returns, and the focus/visibility heal below
  // calls establish() again on the next foreground. Deliberately no error UI — this
  // is a background feed, and a navigation still re-renders the server-fetched items.
  //
  // The heal also covers events Realtime dropped while the tab slept AND cross-tab
  // dismissals: a dismissal writes to a table this channel deliberately does NOT
  // subscribe to (audit decision — no dismissal-table subscriptions), so only the
  // refresh reconciles a feed drained in another tab.
  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let disposed = false
    // 'none' = never established; 'connecting' = an establish() is in flight or its
    // subscribe() has not reported yet; 'healthy' = SUBSCRIBED; 'unhealthy' = the
    // socket reported CHANNEL_ERROR / TIMED_OUT / CLOSED, or auth was unavailable.
    // Only 'none' and 'unhealthy' let the heal re-establish, so a focus burst cannot
    // stack duplicate channels. No timers and no reconnect loop — focus IS the retry.
    let health: 'none' | 'connecting' | 'healthy' | 'unhealthy' = 'none'

    // Coalesce a burst of events (e.g. a rebooking that DELETEs then INSERTs) into a
    // single refresh within 800ms.
    const scheduleRefresh = () => {
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current)
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null
        router.refresh()
      }, 800)
    }

    const establish = async () => {
      if (disposed || health === 'connecting') return
      health = 'connecting'

      let uid: string | null = null
      try {
        const { data, error } = await supabase.auth.getUser()
        if (!error) uid = data.user?.id ?? null
      } catch {
        // Network/auth failure — treated exactly like a null user below.
        uid = null
      }

      if (disposed) return
      if (!uid) {
        health = 'unhealthy'
        return
      }

      // Drop any previous channel BEFORE opening the new one so a re-establish can
      // never leave an orphan subscription on the shared socket.
      if (channel) {
        const stale = channel
        channel = null
        supabase.removeChannel(stale)
      }

      const ch = supabase
        .channel(`whats-new-${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reports', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'training_teachers', filter: `teacher_id=eq.${uid}` }, scheduleRefresh)
        // trainings has no teacher_id column, so this subscription is unfiltered: a
        // trainings change anywhere triggers this teacher's refetch. The refetch is
        // teacher-scoped by RLS so it cannot leak other teachers' data; low volume.
        .on('postgres_changes', { event: '*', schema: 'public', table: 'trainings' }, scheduleRefresh)

      channel = ch
      // `status` is typed as the REALTIME_SUBSCRIBE_STATES enum, which @supabase/
      // supabase-js does not re-export; widening the parameter to string keeps the
      // literal comparisons legal without importing from @supabase/realtime-js.
      ch.subscribe((status: string) => {
        // Ignore a late callback from a channel we already replaced or removed:
        // removeChannel() fires 'CLOSED' on the OLD channel, which would otherwise
        // mark a perfectly healthy fresh one as dead.
        if (ch !== channel) return
        if (status === 'SUBSCRIBED') {
          health = 'healthy'
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          health = 'unhealthy'
        }
      })
    }

    void establish()

    // Heal on focus/visibility. BOTH listeners are needed: tab-switch fires
    // visibilitychange but not focus; alt-tabbing back to the window fires focus. The
    // debounce collapses a double-fire into one refresh — and since this is the only
    // refresher left in the layout, exactly one refresh now fires per focus event.
    const heal = () => {
      scheduleRefresh()
      if (health === 'none' || health === 'unhealthy') void establish()
    }
    function onFocus() {
      heal()
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') heal()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current)
        refreshDebounceRef.current = null
      }
      if (channel) {
        const stale = channel
        channel = null
        supabase.removeChannel(stale)
      }
    }
  }, [router])

  const lessonStartMs = nextLesson ? new Date(nextLesson.scheduled_at).getTime() : null
  const classEndTime = lessonStartMs !== null && nextLesson
    ? lessonStartMs + nextLesson.duration_minutes * 60 * 1000
    : null
  // Liveness comes from the shared half-open [start, end) window in
  // describeLessonCountdown, the same definition the upcoming-classes cards use, so a
  // panel heading can never disagree with the card beside it. Only `live` is taken:
  // the hero below uses formatHeroCountdown (zero-padded HH:MM:SS), which the
  // cards deliberately do NOT use.
  //
  // Both of these read the component's own 1s tick (`now`, set at mount and by the
  // countdown interval above) rather than Date.now(): the render path stays pure, and
  // they agree with remainingSeconds below instead of drifting a tick apart from it.
  const isLive = mounted && lessonStartMs !== null && classEndTime !== null
    ? describeLessonCountdown(lessonStartMs, classEndTime, now).live
    : false
  // now >= end, not now > end: the end instant is NOT teaching time. This previously
  // used `>` here while the student panel used `>=`, so at the exact end instant the
  // teacher read "In class 00:00" and the student read "Class has ended".
  const classEnded = mounted && classEndTime !== null ? now >= classEndTime : false
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

  // "All caught up" describes the feed a Clear all drained, so it must not outlive it:
  // reset as soon as the card has rows again, and a feed that later refills and is
  // dismissed row-by-row reads "No new activity" as it should. Keyed on the VISIBLE
  // count, not whatsNewItems.length — optimistically-hidden rows are not arrivals, so
  // a router.refresh() landing mid-drain (server items still present, every one of
  // them hidden) cannot flip the copy back early.
  //
  // Adjusted during render rather than in an effect: React re-runs THIS component with
  // the new value before committing, so the card never paints the stale copy for a
  // frame. The `clearedJustNow &&` guard is what terminates it — once set to false the
  // condition is false, so the adjustment costs exactly one extra pass and never loops.
  if (clearedJustNow && visibleWhatsNew.length > 0) setClearedJustNow(false)

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
  // An expired session is covered by that same catch: clearAllWhatsNew THROWS on a
  // null auth.getUser() rather than resolving, so a session that drains nothing can
  // no longer reach the success path here. The catch reverts the optimistic hide and
  // clearedJustNow stays false, so the card can never read "All caught up" over an
  // undrained feed.
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
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{isLive ? 'In Class' : 'Next Class'}</p>
          </div>

          {!nextLesson ? (
            <p className="text-sm text-gray-500">No upcoming classes</p>
          ) : (
            <>
              {/* Countdown — big bold live HH:MM:SS hero, matches student panel */}
              {mounted && secondsUntil !== null && classEnded ? (
                <p className="text-sm font-semibold text-gray-900 leading-snug mb-1">Class has ended</p>
              ) : mounted && secondsUntil !== null && isLive ? (
                <p className="text-sm font-semibold leading-snug mb-1" style={{ color: '#FF8303' }}>
                  In class: {formatRemainingCountdown(remainingSeconds)} remaining
                </p>
              ) : (
                <p style={{ fontSize: '22px', fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums', lineHeight: '1.2', marginBottom: '4px' }}>
                  {mounted && secondsUntil !== null ? formatHeroCountdown(secondsUntil) : '--:--:--'}
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
                <>
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
                  {/* Mirrors the student panel: a greyed button with no explanation
                      reads as broken. Suppressed once the class has ended, when the
                      button is gone for good rather than not open yet. */}
                  {!isJoinable && !classEnded && (
                    <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', marginTop: '6px' }}>
                      Opens 10 min before class
                    </p>
                  )}
                </>
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

          {/* Invoice-upload reminder. Pure render off the server prop — no state, no
              effects, no dismiss: the layout re-decides it on every render, and it
              disappears the moment uploaded_at is set or the window closes.
              Pending-state yellow via inline style props only; Tailwind v4 does not
              apply dynamically constructed colour classes. */}
          {invoiceReminderLabel !== null && (
            <div
              style={{
                marginTop: '12px',
                padding: '10px',
                borderRadius: '8px',
                backgroundColor: '#FFF8E8',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: '#FFB942',
                color: '#000000',
              }}
            >
              <p style={{ fontSize: '12px', color: '#000000', lineHeight: 1.4 }}>
                Please upload your {invoiceReminderLabel} invoice by the 10th.
              </p>
              <PanelButton
                className="mt-2 w-full text-sm"
                onClick={() => router.push('/billing')}
              >
                Upload invoice
                <ArrowRight size={14} className="ml-2" />
              </PanelButton>
            </div>
          )}

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
