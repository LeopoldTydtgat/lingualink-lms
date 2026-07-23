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
  // refreshed props no longer contain them (fetchStudentWhatsNew filters dismissed keys).
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
      markStudentWhatsNewSeen().catch(() => {})
    } else if (!open && prevOpen.current) {
      setLocalSeenAt(new Date().toISOString())
      setClearedJustNow(false)
    }
    prevOpen.current = open
  }, [open])

  // Realtime: refresh the feed when any source table it is built from changes in
  // another session. Mirrors the teacher bell — one channel, postgres_changes
  // scoped to this student wherever a student_id column exists, and a debounced
  // router.refresh(). This ONLY asks Next.js to re-run the layout; the server
  // refetch (fetchStudentWhatsNew) stays the single source of truth for what
  // shows, and seen/dismiss logic is untouched. Unlike the teacher bell there is
  // no auth.getUser() resolve here: the students table PK arrives as a prop, and
  // it — not the auth uid — is what student_id columns hold.
  useEffect(() => {
    const supabase = createClient()

    // Coalesce a burst of events (e.g. a rebooking that DELETEs then INSERTs) into a
    // single refresh within 800ms.
    const scheduleRefresh = () => {
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current)
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null
        router.refresh()
      }, 800)
    }

    const channel = supabase
      .channel(`student-whats-new-${studentId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons', filter: `student_id=eq.${studentId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `student_id=eq.${studentId}` }, scheduleRefresh)
      // trainings changes are low volume, so this subscription is unfiltered: a
      // trainings change anywhere triggers this student's refetch. The refetch is
      // student-scoped by RLS so it cannot leak other students' data.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trainings' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current)
        refreshDebounceRef.current = null
      }
      supabase.removeChannel(channel)
    }
  }, [router, studentId])

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
  // the refresh mirrors the teacher bell's choreography.
  const handleDismiss = async (key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      await dismissStudentWhatsNewItem(key)
    } catch {
      // write failed; the next full load will restore the row honestly
    }
    router.refresh()
  }

  // Clear the WHOLE feed, not just the visible page. Optimistically hide the
  // currently-visible keys for instant bell feedback, then AWAIT the server drain
  // (clearAllStudentWhatsNew recomputes and dismisses every page), flag "All
  // caught up" on success, and refresh. Same await-then-refresh order as
  // handleDismiss.
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
