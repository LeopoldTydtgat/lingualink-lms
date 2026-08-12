'use client'

// src/components/AnnouncementBanner.tsx
// Renders active announcement banners above main page content.
// Dismissable banners show an X button — clicking it removes the banner
// locally and records the dismissal in the database via the dismiss API route.
// Non-dismissable banners show no close button and cannot be hidden by the user.

import { useState } from 'react'
import { X } from 'lucide-react'

export interface AnnouncementItem {
  id: string
  title: string
  message: string
  is_dismissable: boolean
}

interface Props {
  announcements: AnnouncementItem[]
}

export default function AnnouncementBanner({ announcements }: Props) {
  // Track which banners the user has dismissed this session
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const visible = announcements.filter((a) => !dismissed.has(a.id))
  if (visible.length === 0) return null

  const handleDismiss = async (id: string) => {
    // Remove from UI immediately — optimistic update
    setDismissed((prev) => new Set([...prev, id]))

    // Fail-safe revert: if the write never lands, the banner must come back rather
    // than stay hidden with nothing recorded (it would reappear on reload anyway).
    const revert = () =>
      setDismissed((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })

    // Persist dismissal so it doesn't reappear on next page load.
    // The route derives user identity and type from the session — body carries the id only.
    try {
      const res = await fetch('/api/announcements/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ announcementId: id }),
      })
      if (!res.ok) {
        console.error('Announcement dismissal failed:', res.status)
        revert()
      }
    } catch (e) {
      console.error('Announcement dismissal error:', e)
      revert()
    }
  }

  return (
    <div>
      {visible.map((a) => (
        <div
          key={a.id}
          style={{ backgroundColor: '#1f2937', borderLeft: '4px solid #FF8303' }}
          className="flex items-start justify-between gap-4 px-6 py-3"
        >
          <div className="flex-1 min-w-0">
            {a.title && (
              <span className="text-white font-semibold text-sm mr-2">
                {a.title}
              </span>
            )}
            <span className="text-white text-sm leading-relaxed">{a.message}</span>
          </div>

          {a.is_dismissable && (
            <button
              onClick={() => handleDismiss(a.id)}
              className="flex-shrink-0 text-white/80 hover:text-white transition-colors mt-0.5"
              aria-label="Dismiss announcement"
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
