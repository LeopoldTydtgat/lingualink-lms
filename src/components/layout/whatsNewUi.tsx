// src/components/layout/whatsNewUi.tsx
'use client'

// Shared What's New presentation, reused by the dashboard right panel and the
// top-header notifications bell so both render identical rows. Leaf module: both
// consumers import from here (clean import direction), no logic lives elsewhere.

import { useState } from 'react'
import { X } from 'lucide-react'
import type { WhatsNewItem } from '@/lib/whatsNew'

// Relative age of an ISO instant: "just now", "2m ago", "3h ago", "5d ago".
// Client-only — callers must gate on `mounted` before rendering (hydration-safe).
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

// A single What's New row. Attention items get an orange dot; normal items grey.
// Colours are inline style props only (Tailwind v4 can't apply dynamic colours).
// The relative-time line renders only when mounted (hydration-safe) and the item
// carries a real timestamp (showTime !== false).
//
// Seen styling: seen rows dim their text; a seen normal dot goes hollow, but a
// seen attention dot stays solid (unresolved urgency keeps its dot).
//
// Dismiss: when `onDismiss` is passed the row wraps in a relative container and
// renders an X button over its right edge — hidden until row hover on pointer
// devices (group-hover), always visible below md (touch). Its click is stopped
// from bubbling so the row's navigation never fires. When `onDismiss` is absent
// the row behaves exactly as before (no wrapper button, no extra padding).
export function WhatsNewRow({ item, mounted, seen, onClick, onDismiss }: { item: WhatsNewItem; mounted: boolean; seen: boolean; onClick: () => void; onDismiss?: () => void }) {
  const [hovered, setHovered] = useState(false)
  const [dismissHovered, setDismissHovered] = useState(false)
  const hollowDot = seen && !item.attention
  return (
    <div
      className="group"
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          width: '100%',
          padding: '8px',
          paddingRight: onDismiss ? '30px' : '8px',
          borderRadius: '8px',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          backgroundColor: hovered ? '#FAFAFA' : 'transparent',
          transition: 'background-color 0.15s ease',
        }}
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '9999px',
            marginTop: '6px',
            flexShrink: 0,
            boxSizing: 'border-box',
            backgroundColor: item.attention ? '#FF8303' : hollowDot ? 'transparent' : '#E0DFDC',
            border: hollowDot ? '1px solid #E0DFDC' : 'none',
          }}
        />
        <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span style={{ fontSize: '13px', fontWeight: seen ? 400 : 600, color: seen ? '#9ca3af' : '#374151', lineHeight: '1.35' }}>{item.text}</span>
          {mounted && item.showTime !== false && (
            <span style={{ fontSize: '11px' }} className="text-gray-400">{relativeTime(item.at)}</span>
          )}
        </span>
      </button>

      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onDismiss()
          }}
          onMouseEnter={() => setDismissHovered(true)}
          onMouseLeave={() => setDismissHovered(false)}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
          style={{
            position: 'absolute',
            top: '6px',
            right: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '20px',
            height: '20px',
            padding: 0,
            borderRadius: '6px',
            border: 'none',
            backgroundColor: dismissHovered ? '#F3F4F6' : 'transparent',
            cursor: 'pointer',
            transition: 'opacity 0.15s ease, background-color 0.15s ease',
          }}
        >
          <X size={14} color={dismissHovered ? '#4b5563' : '#9ca3af'} />
        </button>
      )}
    </div>
  )
}
