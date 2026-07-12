'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  IDLE_TIMEOUT_MS,
  WARNING_BEFORE_MS,
  CLASS_SUPPRESSION_MS,
  ACTIVITY_THROTTLE_MS,
  LAST_ACTIVITY_KEY,
} from '@/lib/config/idle-timeout'

interface UseIdleTimeoutArgs {
  // ISO string of the user's next upcoming class start, or null if none
  nextLessonStartIso: string | null
  // Duration of that lesson in minutes (so we know when in-progress class ends)
  nextLessonDurationMinutes: number | null
  // Portal-specific login path for the idle redirect
  loginPath: string
}

interface UseIdleTimeoutReturn {
  showWarning: boolean
  secondsUntilLogout: number
  stayLoggedIn: () => void
}

// Returns true if a class is currently in progress OR starts within the suppression window
function isClassProtected(
  nextLessonStartIso: string | null,
  durationMinutes: number | null
): boolean {
  if (!nextLessonStartIso) return false
  const now = Date.now()
  const start = new Date(nextLessonStartIso).getTime()
  const end = durationMinutes ? start + durationMinutes * 60 * 1000 : start
  // Protected if class is upcoming within suppression window OR in progress
  if (start - now <= CLASS_SUPPRESSION_MS && now < end) return true
  return false
}

export function useIdleTimeout({
  nextLessonStartIso,
  nextLessonDurationMinutes,
  loginPath,
}: UseIdleTimeoutArgs): UseIdleTimeoutReturn {
  const [showWarning, setShowWarning] = useState(false)
  const [secondsUntilLogout, setSecondsUntilLogout] = useState(
    Math.floor(WARNING_BEFORE_MS / 1000)
  )

  const lastActivityRef = useRef<number>(Date.now())
  const lastWriteRef = useRef<number>(0)
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hiddenSinceRef = useRef<number | null>(null)        // when tab last became hidden

  // Reset activity (called on user input + on "Stay logged in" click)
  const recordActivity = () => {
    const now = Date.now()
    lastActivityRef.current = now
    setShowWarning(false)
    // Throttle localStorage writes to avoid perf hit
    if (now - lastWriteRef.current >= ACTIVITY_THROTTLE_MS) {
      lastWriteRef.current = now
      try {
        localStorage.setItem(LAST_ACTIVITY_KEY, String(now))
      } catch {
        // localStorage may be blocked; non-fatal
      }
    }
  }

  const stayLoggedIn = () => {
    recordActivity()
  }

  useEffect(() => {
    // Activity event listeners — passive, throttled via recordActivity
    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'keydown',
      'scroll',
      'click',
      'touchstart',
    ]
    const handler = () => recordActivity()
    events.forEach((e) => window.addEventListener(e, handler, { passive: true }))

    // Cross-tab sync: when another tab updates lastActivity, treat as activity here
    const storageHandler = (e: StorageEvent) => {
      if (e.key === LAST_ACTIVITY_KEY && e.newValue) {
        const ts = Number(e.newValue)
        if (!Number.isNaN(ts) && ts > lastActivityRef.current) {
          lastActivityRef.current = ts
          setShowWarning(false)
        }
      }
    }
    window.addEventListener('storage', storageHandler)

    // Seed lastActivity from localStorage if a more recent value exists (multi-tab handover)
    try {
      const stored = localStorage.getItem(LAST_ACTIVITY_KEY)
      if (stored) {
        const ts = Number(stored)
        if (!Number.isNaN(ts) && ts > lastActivityRef.current) {
          lastActivityRef.current = ts
        }
      }
    } catch {
      // ignore
    }

    const visibilityHandler = () => {
      if (document.hidden) {
        // Tab just hidden — record the moment
        hiddenSinceRef.current = Date.now()
      } else {
        // Tab just became visible
        if (hiddenSinceRef.current !== null) {
          const hiddenDuration = Date.now() - hiddenSinceRef.current
          // Shift lastActivity forward by the hidden duration so the idle counter resumes
          // from where it was when the tab was hidden, not from when it was hidden
          lastActivityRef.current += hiddenDuration
          hiddenSinceRef.current = null
        }
      }
    }
    document.addEventListener('visibilitychange', visibilityHandler)

    // Tick every second to check idle status
    tickIntervalRef.current = setInterval(() => {
      // Skip idle counting while the tab is hidden — only count visible idle time
      if (document.hidden) {
        return
      }
      // Class protection — pause timer entirely
      if (isClassProtected(nextLessonStartIso, nextLessonDurationMinutes)) {
        // Treat protected time as activity so timer doesn't fire the moment class ends
        lastActivityRef.current = Date.now()
        setShowWarning(false)
        return
      }

      const idleMs = Date.now() - lastActivityRef.current

      if (idleMs >= IDLE_TIMEOUT_MS) {
        // Time to log out
        const supabase = createClient()
        supabase.auth.signOut().finally(() => {
          window.location.href = `${loginPath}?reason=idle`
        })
        if (tickIntervalRef.current) clearInterval(tickIntervalRef.current)
        return
      }

      if (idleMs >= IDLE_TIMEOUT_MS - WARNING_BEFORE_MS) {
        const remainingMs = IDLE_TIMEOUT_MS - idleMs
        setSecondsUntilLogout(Math.max(0, Math.ceil(remainingMs / 1000)))
        setShowWarning(true)
      } else {
        setShowWarning(false)
      }
    }, 1000)

    return () => {
      events.forEach((e) => window.removeEventListener(e, handler))
      window.removeEventListener('storage', storageHandler)
      document.removeEventListener('visibilitychange', visibilityHandler)
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextLessonStartIso, nextLessonDurationMinutes, loginPath])

  return { showWarning, secondsUntilLogout, stayLoggedIn }
}
