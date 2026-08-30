'use client'

import { useSyncExternalStore, type CSSProperties } from 'react'
import { sanitizeHtml } from '@/lib/sanitize'

// Renders stored rich-text HTML through the browser-side sanitiser.
//
// Empty on the server and during hydration, on purpose: the server snapshot
// is false, so server output and the hydrating client output are both an
// empty div and hydration matches. Once hydrated React re-reads the client
// snapshot (true) and the content appears. A bubble mounted later, after
// hydration, reads true straight away and never renders empty. The
// sanitiser, which needs a real DOM, therefore never runs during SSR.
//
// useSyncExternalStore rather than a mounted flag set in an effect: same
// result, no setState-in-effect, and no extra render on late mounts.
//
// Props are the two the existing bubbles use; keep it that narrow.
interface Props {
  html: string | null | undefined
  className?: string
  style?: CSSProperties
}

const subscribe = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false

export default function SafeHtml({ html, className, style }: Props) {
  const hydrated = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)
  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: hydrated ? sanitizeHtml(html) : '' }}
    />
  )
}
