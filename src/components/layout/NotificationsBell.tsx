'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell } from 'lucide-react'
import type { WhatsNewItem } from '@/lib/whatsNew'
import { WhatsNewRow } from '@/components/layout/whatsNewUi'
import { markWhatsNewSeen } from '@/app/(dashboard)/actions/whatsNewSeen'

type NotificationsBellProps = {
  items: WhatsNewItem[]
  seenAt: string | null
}

export default function NotificationsBell({ items, seenAt }: NotificationsBellProps) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [localSeenAt, setLocalSeenAt] = useState<string | null>(seenAt)
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)
  const prevOpen = useRef(false)

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
    }
    prevOpen.current = open
  }, [open])

  // Effective marker = the later of the server-provided stamp and the local
  // close-of-dropdown stamp. The server action refreshes the route, so seenAt
  // advances on its own; useState would otherwise pin us to the mount-time value.
  const effectiveSeenAt =
    localSeenAt != null && (seenAt == null || localSeenAt > seenAt) ? localSeenAt : seenAt
  const isSeen = (item: WhatsNewItem) => effectiveSeenAt != null && item.at <= effectiveSeenAt

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

  // Badge counts all unseen items; seen-state clears it honestly. Hidden entirely
  // while the dropdown is open (the user is looking straight at them).
  const count = items.filter((i) => !isSeen(i)).length

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
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #E0DFDC' }}>
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
          </div>

          {items.length === 0 ? (
            <div style={{ padding: '16px' }}>
              <p style={{ fontSize: '14px', color: '#9ca3af', fontStyle: 'italic' }}>
                No new notifications
              </p>
            </div>
          ) : (
            <div style={{ padding: '8px' }}>
              {items.map((item) => (
                <WhatsNewRow
                  key={item.id}
                  item={item}
                  mounted={mounted}
                  seen={isSeen(item)}
                  onClick={() => {
                    setOpen(false)
                    router.push(item.href)
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
