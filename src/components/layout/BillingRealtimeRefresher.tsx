'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface Props {
  teacherId: string | null
}

// Keeps the server-computed right-panel billing summary (current + projected month
// totals) fresh when this teacher's lessons change in ANOTHER session — e.g. a student
// cancels, or an admin books/reassigns a class. The billing figures are derived in the
// (dashboard) layout Server Component, so the only lever a client component has is to ask
// Next.js for a soft refresh (router.refresh()); that re-runs the layout and re-passes the
// recomputed billingData down to RightPanel. No billing math lives here.
//
// Mirrors the DayToDay lessons Realtime pattern: a postgres_changes subscription scoped to
// this teacher's rows, plus a focus/visibility heal because Realtime can silently drop
// events (the reassignment gap in particular — a lesson moved AWAY from this teacher stops
// matching the teacher_id filter, so no DELETE event arrives).
export default function BillingRealtimeRefresher({ teacherId }: Props) {
  const router = useRouter()

  // router is stable across renders in the App Router, but we read it through a ref so the
  // subscription/heal effects can depend solely on teacherId and never re-subscribe.
  const routerRef = useRef(router)
  routerRef.current = router

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!teacherId) return

    const supabase = createClient()

    // Debounce ~1s so a burst of events (e.g. a rebooking that DELETEs then INSERTs, or a
    // bulk admin change) collapses into a single refresh instead of hammering the server.
    const scheduleRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        routerRef.current.refresh()
      }, 1000)
    }

    const channel = supabase
      .channel(`billing-refresh-${teacherId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lessons',
          filter: `teacher_id=eq.${teacherId}`,
        },
        scheduleRefresh
      )
      .subscribe()

    // Heal on focus/visibility for events Realtime may have dropped. BOTH listeners are
    // needed: tab-switch fires visibilitychange but not focus; alt-tabbing back to the
    // window fires focus. The debounce collapses a double-fire into one refresh.
    function onFocus() {
      scheduleRefresh()
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') scheduleRefresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      supabase.removeChannel(channel)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [teacherId])

  return null
}
