// src/components/layout/whatsNewUi.tsx
'use client'

// Shared What's New presentation, reused by the dashboard right panel and the
// top-header notifications bell so both render identical rows. Leaf module: both
// consumers import from here (clean import direction), no logic lives elsewhere.

import { useState } from 'react'
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
export function WhatsNewRow({ item, mounted, seen, onClick }: { item: WhatsNewItem; mounted: boolean; seen: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  const hollowDot = seen && !item.attention
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        width: '100%',
        padding: '8px',
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
  )
}
