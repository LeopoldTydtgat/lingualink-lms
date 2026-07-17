'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import type { WhatsNewItem } from '@/lib/whatsNew'
import { WhatsNewRow } from '@/components/layout/whatsNewUi'
import { createClient } from '@/lib/supabase/client'
import { markWhatsNewSeen } from '@/app/(dashboard)/actions/whatsNewSeen'
import { dismissWhatsNewItem, clearAllWhatsNew } from '@/app/(dashboard)/actions/whatsNewDismiss'

type NotificationsBellProps = {
  items: WhatsNewItem[]
  seenAt: string | null
}

export default function NotificationsBell({ items, seenAt }: NotificationsBellProps) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [localSeenAt, setLocalSeenAt] = useState<string | null>(seenAt)
  // Optimistically hidden keys: rows the user just dismissed, removed immediately
  // while the server write + router.refresh() catch up. Cleared naturally when the
  // refreshed props no longer contain them (fetchWhatsNew filters dismissed keys).
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

  // Persist the seen stamp when the dropdown OPENS (server-side), but only advance
  // the LOCAL stamp when it CLOSES — so rows keep their unseen styling while being
  // read, and the badge clears once the user is done. Skips the initial mount (no
  // open→close transition), so nothing is marked seen until the user actually opens.
  useEffect(() => {
    if (open && !prevOpen.current) {
      markWhatsNewSeen().catch(() => {})
    } else if (!open && prevOpen.current) {
      setLocalSeenAt(new Date().toISOString())
      setClearedJustNow(false)
    }
    prevOpen.current = open
  }, [open])

  // Open the dropdown when the RightPanel's "View all" dispatches 'open-whats-new'.
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('open-whats-new', handler)
    return () => window.removeEventListener('open-whats-new', handler)
  }, [])

  // Realtime: refresh the feed when any source table it is built from changes in
  // another session. Mirrors BillingRealtimeRefresher — one channel, postgres_changes
  // scoped to this teacher wherever a teacher_id column exists, and a debounced
  // router.refresh(). This ONLY asks Next.js to re-run the layout; the server refetch
  // (fetchWhatsNew) stays the single source of truth for what shows, and seen/dismiss
  // logic is untouched. NotificationsBell has no user-id prop, so we resolve it once
  // via the browser client before opening the channel (guarded on a null id).
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

  // Effective marker = the later of the server-provided stamp and the local
  // close-of-dropdown stamp. The server action refreshes the route, so seenAt
  // advances on its own; useState would otherwise pin us to the mount-time value.
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
  // the refresh matters — the passive RightPanel reads the same array straight
  // from props with no optimistic hide, so the refetch must run after the row is
  // committed or the panel would keep showing the dismissed item.
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

  // Clear the WHOLE feed, not just the visible page. Optimistically hide the
  // currently-visible keys for instant bell feedback, then AWAIT the server drain
  // (clearAllWhatsNew recomputes and dismisses every page), flag "All caught up"
  // on success, and refresh so the passive RightPanel reconciles too. Same
  // await-then-refresh order as handleDismiss.
  const handleClearAll = async () => {
    const keys = visibleItems.map((i) => i.id)
    if (keys.length === 0) return
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => next.add(k))
      return next
    })
    try {
      await clearAllWhatsNew()
      setClearedJustNow(true)
    } catch {
      // write failed; the next full load will restore the rows honestly
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
                    if (pathname !== targetPath) router.push(item.href)
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
