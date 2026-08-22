'use client'

// Sibling of src/components/layout/NotificationsBell.tsx (the teacher bell).
// Identical open/close seen stamping, optimistic dismiss + await-then-refresh
// choreography, badge logic and dropdown markup; only the actions, the realtime
// sources and the identity differ. There is deliberately NO 'open-whats-new'
// window-event listener here — the student right panel has no "View all" hook.
//
// IDENTITY RULE: the `studentId` prop is students.id (the table PK), which is
// what lessons.student_id / assignments.student_id filter on — so the realtime
// filters below use it directly. auth.uid() (= students.auth_user_id) is a
// DIFFERENT uuid and never appears in this component; the server actions resolve
// it themselves from the session. Never mix the two.

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import type { WhatsNewItem } from '@/lib/whatsNew'
import { WhatsNewRow } from '@/components/layout/whatsNewUi'
import { createClient } from '@/lib/supabase/client'
import { markStudentWhatsNewSeen } from '@/app/(student)/student/actions/studentWhatsNewSeen'
import { dismissStudentWhatsNewItem, clearAllStudentWhatsNew } from '@/app/(student)/student/actions/studentWhatsNewDismiss'

type StudentNotificationsBellProps = {
  items: WhatsNewItem[]
  seenAt: string | null
  studentId: string
}

export default function StudentNotificationsBell({ items, seenAt, studentId }: StudentNotificationsBellProps) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [localSeenAt, setLocalSeenAt] = useState<string | null>(seenAt)
  // Optimistically hidden keys: rows the user just dismissed, removed immediately
  // while the server write + router.refresh() catch up. Cleared naturally when the
  // refreshed props no longer contain them (fetchStudentWhatsNew filters dismissed keys);
  // a write that fails removes its own key again so the row comes straight back.
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [clearAllHovered, setClearAllHovered] = useState(false)
  // True only for the window between a successful "Clear all" and the next dropdown
  // close — swaps the empty-state copy to a friendlier "All caught up".
  const [clearedJustNow, setClearedJustNow] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const containerRef = useRef<HTMLDivElement>(null)
  const prevOpen = useRef(false)
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  // BOTH seen stamps are taken on the OPEN transition — the server one
  // (markStudentWhatsNewSeen) and the local one — so they anchor on the same
  // moment. Advancing the LOCAL stamp on CLOSE instead marked every item that
  // ARRIVED while the popover was open as already seen, and the badge is hidden
  // while open (the `!open` guard on the badge below), so such an item was never
  // badged at all: it was born seen and silently vanished. Anchoring on open
  // leaves it with at > stamp, so it badges as soon as the dropdown closes.
  // Accepted trade: rows now take their dimmed "seen" styling when the dropdown
  // opens rather than after it closes. Skips the initial mount (no false open
  // transition), so nothing is marked seen until the user actually opens it.
  //
  // clearedJustNow still resets on CLOSE — it is scoped to "since the last
  // successful Clear all until the dropdown next closes" and is independent of
  // seen state, so it deliberately stays in the close branch.
  useEffect(() => {
    if (open && !prevOpen.current) {
      markStudentWhatsNewSeen().catch(() => {})
      setLocalSeenAt(new Date().toISOString())
    } else if (!open && prevOpen.current) {
      setClearedJustNow(false)
    }
    prevOpen.current = open
  }, [open])

  // Realtime: refresh the feed when any source table it is built from changes in
  // another session. Mirrors the teacher feed (RightPanel) — one channel,
  // postgres_changes scoped to this student wherever a student_id column exists,
  // and a debounced router.refresh(). router.refresh() re-runs the WHOLE current
  // route, layout and page, so any page whose server component redirects on
  // mutable state can be redirected by this refresh; the student booking page was
  // hit by exactly that and now decides client-side instead. The server refetch
  // (fetchStudentWhatsNew) stays the single source of truth for what shows, and
  // seen/dismiss logic is untouched. Unlike the teacher feed there
  // is no auth.getUser() resolve here: the students table PK arrives as a prop, and
  // it — not the auth uid — is what student_id columns hold.
  //
  // That prop-only setup is exactly what can race the shared browser client's
  // realtime JWT seeding (supabase/client.ts wires realtime.setAuth from an async
  // getSession()): a channel that joins before the socket holds a token has its
  // RLS-filtered events silently dropped, and the bell then stays dead for the whole
  // mount. The resolution is NOT to block on auth here — the identity rule above
  // keeps the auth uid out of this component — but to make that state RECOVERABLE:
  // the subscribe status callback marks a token-less join (which comes back
  // CHANNEL_ERROR) unhealthy, and the focus/visibility heal below tears the channel
  // down and re-runs the SAME establish() the initial setup uses, by which point
  // setAuth has long since run. A bad seed therefore self-corrects on next focus
  // instead of persisting.
  //
  // The heal's refresh also covers cross-tab dismissals: a dismissal writes to a
  // table this channel deliberately does NOT subscribe to (audit decision — no
  // dismissal-table subscriptions), so only a refetch reconciles a feed that was
  // drained in another tab.
  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let disposed = false
    // 'none' = never established; 'connecting' = subscribe() has not reported yet;
    // 'healthy' = SUBSCRIBED; 'unhealthy' = the socket reported CHANNEL_ERROR /
    // TIMED_OUT / CLOSED. Only 'none' and 'unhealthy' let the heal re-establish, so
    // a focus burst cannot stack duplicate channels. No timers and no reconnect
    // loop — focus IS the retry.
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
      if (disposed) return
      health = 'connecting'

      // Await auth so the shared realtime socket JWT is seeded before
      // subscribe() - anon-role subscriptions fail filter validation (P0001).
      let uid: string | null = null
      try {
        const { data, error } = await supabase.auth.getUser()
        if (!error) uid = data.user?.id ?? null
      } catch {
        // Network/auth failure — treated exactly like a null user below.
        uid = null
      }
      if (!uid) {
        health = 'unhealthy'
        return
      }
      if (disposed) return

      // Drop any previous channel BEFORE opening the new one so a re-establish can
      // never leave an orphan subscription on the shared socket.
      if (channel) {
        const stale = channel
        channel = null
        supabase.removeChannel(stale)
      }

      const ch = supabase
        .channel(`student-whats-new-${studentId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons', filter: `student_id=eq.${studentId}` }, scheduleRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `student_id=eq.${studentId}` }, scheduleRefresh)
        // trainings changes are low volume, so this subscription is unfiltered: a
        // trainings change anywhere triggers this student's refetch. The refetch is
        // student-scoped by RLS so it cannot leak other students' data.
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
    // debounce collapses a double-fire into one refresh.
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
  }, [router, studentId])

  // Effective marker = the later of the server-provided stamp and the local
  // open-of-dropdown stamp. markStudentWhatsNewSeen writes students.whats_new_seen_at
  // but does NOT revalidate, so the `seenAt` prop does not advance on its own — it
  // only catches up when something else re-runs the student layout (a dismiss or
  // clear-all refresh, the realtime/heal refresh above, or a navigation). The local
  // stamp is therefore what clears the badge immediately, and taking the LATER of the
  // two means a lagging prop can never un-see rows the user has already opened.
  const effectiveSeenAt =
    localSeenAt != null && (seenAt == null || localSeenAt > seenAt) ? localSeenAt : seenAt
  const isSeen = (item: WhatsNewItem) => effectiveSeenAt != null && item.at <= effectiveSeenAt

  // Rendered items = server items minus anything optimistically dismissed.
  const visibleItems = items.filter((i) => !hiddenKeys.has(i.id))

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return

    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Dismiss one item: hide it locally for instant bell feedback, AWAIT the write,
  // then refresh so the server feed becomes the source of truth. Awaiting before
  // the refresh mirrors the teacher bell's choreography.
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
      await dismissStudentWhatsNewItem(key)
    } catch {
      // Write failed — un-hide the row so the feed stays honest.
      setHiddenKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
    router.refresh()
  }

  // Clear the WHOLE feed, not just the visible page. Optimistically hide the
  // currently-visible keys for instant bell feedback, then AWAIT the server drain
  // (clearAllStudentWhatsNew recomputes and dismisses every page), flag "All
  // caught up" on success, and refresh. Same await-then-refresh order as
  // handleDismiss.
  //
  // On failure the action throws, every key hidden by THIS invocation is restored
  // (same reason as handleDismiss — refresh does not reset client state) and
  // clearedJustNow stays false, so the empty state can never claim "All caught up"
  // over a feed that did not drain. The keys are guaranteed absent from hiddenKeys
  // beforehand because visibleItems is already filtered by it, so deleting them
  // restores exactly the pre-click state.
  const handleClearAll = async () => {
    const keys = visibleItems.map((i) => i.id)
    if (keys.length === 0) return
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => next.add(k))
      return next
    })
    try {
      await clearAllStudentWhatsNew()
      setClearedJustNow(true)
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

  // Badge counts all unseen, not-yet-dismissed items; seen-state clears it honestly.
  // Hidden entirely while the dropdown is open (the user is looking straight at them).
  const count = visibleItems.filter((i) => !isSeen(i)).length

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="hover:bg-gray-100 rounded-lg p-2"
        style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Bell size={20} color="#4b5563" />
        {count > 0 && !open && (
          <span
            style={{
              position: 'absolute',
              top: '2px',
              right: '2px',
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              backgroundColor: '#FF8303',
              color: '#ffffff',
              fontSize: '10px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: '20rem',
            backgroundColor: '#ffffff',
            border: '1px solid #E0DFDC',
            borderRadius: '12px',
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 50,
          }}
        >
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #E0DFDC', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <p
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: '#9ca3af',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              What&apos;s New
            </p>
            {visibleItems.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                onMouseEnter={() => setClearAllHovered(true)}
                onMouseLeave={() => setClearAllHovered(false)}
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: clearAllHovered ? '#FF8303' : '#4b5563',
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

          {visibleItems.length === 0 ? (
            <div style={{ padding: '16px' }}>
              {clearedJustNow ? (
                <p style={{ fontSize: '14px', color: '#4b5563' }}>
                  All caught up
                </p>
              ) : (
                <p style={{ fontSize: '14px', color: '#9ca3af', fontStyle: 'italic' }}>
                  No new notifications
                </p>
              )}
            </div>
          ) : (
            <div style={{ padding: '8px' }}>
              {visibleItems.map((item) => (
                <WhatsNewRow
                  key={item.id}
                  item={item}
                  mounted={mounted}
                  seen={isSeen(item)}
                  onDismiss={() => handleDismiss(item.id)}
                  onClick={() => {
                    setOpen(false)
                    const targetPath = item.href.split('?')[0].split('#')[0]
                    router.push(item.href)
                    if (pathname === targetPath) router.refresh()
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
