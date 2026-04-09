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
  userType: 'teacher' | 'student'
  userId: string
}

export default function AnnouncementBanner({ announcements, userType, userId }: Props) {
  // Track which banners the user has dismissed this session
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const visible = announcements.filter((a) => !dismissed.has(a.id))
  if (visible.length === 0) return null

  const handleDismiss = async (id: string) => {
    // Remove from UI immediately — optimistic update
    setDismissed((prev) => new Set([...prev, id]))

    // Persist dismissal so it doesn't reappear on next page load
    await fetch('/api/announcements/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcementId: id, userType, userId }),
    })
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
