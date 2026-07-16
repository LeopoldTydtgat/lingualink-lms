'use client'

import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'

type AnnouncementItem = {
  id: string
  title: string
  message: string
  is_dismissable: boolean
}

type NotificationsBellProps = {
  announcements: AnnouncementItem[]
}

export default function NotificationsBell({ announcements }: NotificationsBellProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

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

  const count = announcements.length

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
        {count > 0 && (
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

          {count === 0 ? (
            <div style={{ padding: '16px' }}>
              <p style={{ fontSize: '14px', color: '#9ca3af', fontStyle: 'italic' }}>
                No new notifications
              </p>
            </div>
          ) : (
            <div>
              {announcements.map((a, index) => (
                <div
                  key={a.id}
                  style={{
                    padding: '12px 16px',
                    borderTop: index > 0 ? '1px solid #E0DFDC' : 'none',
                  }}
                >
                  <p style={{ fontSize: '13px', fontWeight: 600, color: '#111827' }}>{a.title}</p>
                  <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px', lineHeight: 1.5 }}>
                    {a.message}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
