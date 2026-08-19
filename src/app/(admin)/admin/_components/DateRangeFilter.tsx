'use client'

import type { CSSProperties } from 'react'
import { getPresetRange, type DateRangePreset } from '@/lib/dates/dateRangePresets'

const PRESETS: ReadonlyArray<{ key: DateRangePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
]

// Lifted verbatim from the two date inputs this component replaces on the admin
// Classes filter row, so the row is pixel-identical after the swap.
const labelStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: '#374151',
  display: 'block',
  marginBottom: '4px',
}

const inputStyle: CSSProperties = {
  width: '100%',
  border: '1px solid #D1D5DB',
  borderRadius: '6px',
  padding: '8px 10px',
  fontSize: '14px',
  outline: 'none',
  boxSizing: 'border-box',
}

const NO_TZ_TITLE = 'Set your profile timezone to use presets'

/**
 * Controlled From/To day-key pair plus timezone-correct quick-range presets.
 *
 * Fully controlled and stateless: the parent owns `from` and `to`, and every
 * interaction reports back through a SINGLE onChange(from, to) call. That is the
 * contract the Classes list depends on — its fetch is memoised on the filter values,
 * so one call means one render and one request, while two calls would mean two.
 *
 * Renders as a fragment of three flex items so it drops straight into an existing
 * filter row without adding a wrapper that would break the row's flex layout.
 */
export function DateRangeFilter({
  from,
  to,
  onChange,
  tz,
  disabled = false,
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  // Admin's profile timezone; null when unset. Presets go dead rather than guessing:
  // without a zone there is no honest answer to "which day is today", and assuming
  // UTC would seed the wrong day for most of the world. Same judgement the server
  // page makes when it declines to seed ?filter=today on a null timezone. The manual
  // inputs stay live — an explicitly typed date needs no zone to be meaningful.
  //
  // "Unset" is tested by TRUTHINESS, not `=== null`, at every one of the four gates
  // below. An empty string is a zone this component cannot use, and `?? null` upstream
  // does not convert '' to null, so a `=== null` enablement gate would leave the
  // buttons looking live while the click handler silently no-ops on the same value.
  // Every other consumer of profiles.timezone already reads it as truthy-or-absent.
  tz: string | null
  disabled?: boolean
}) {
  const presetsDisabled = disabled || !tz

  // Derived on every render, never stored. Held in state it would drift out of sync
  // the moment either date input was edited by hand or the parent's Clear button
  // emptied both, leaving a highlight that no longer describes what is being filtered.
  //
  // The clock read is deliberate and unavoidable — "this week" only means anything
  // relative to now. It happens once per render and feeds nothing but a background
  // colour, so the worst case of an SSR and a hydration render straddling local
  // midnight in tz is one button momentarily drawn in the wrong style.
  //
  // The (from || to) guard is the cleared state, which no preset can ever match
  // because every preset returns real day keys; it skips four Intl probes per render
  // in the case the filter spends most of its life in.
  const now = new Date()
  const activePreset: DateRangePreset | null =
    tz && (from || to)
      ? PRESETS.find((p) => {
          const range = getPresetRange(p.key, now, tz)
          return range.from === from && range.to === to
        })?.key ?? null
      : null

  return (
    <>
      {/* Date from */}
      <div style={{ flex: '1 1 140px' }}>
        <label style={labelStyle}>
          From
        </label>
        <input
          type="date"
          value={from}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, to)}
          style={inputStyle}
        />
      </div>

      {/* Date to */}
      <div style={{ flex: '1 1 140px' }}>
        <label style={labelStyle}>
          To
        </label>
        <input
          type="date"
          value={to}
          disabled={disabled}
          onChange={(e) => onChange(from, e.target.value)}
          style={inputStyle}
        />
      </div>

      {/* Presets. The title also sits on the wrapper because browsers suppress
          pointer events on a disabled button, so a title there alone never shows. */}
      <div style={{ flex: '0 1 auto' }} title={!tz ? NO_TZ_TITLE : undefined}>
        <label style={labelStyle}>
          Quick range
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {PRESETS.map((p) => {
            const active = p.key === activePreset
            return (
              <button
                key={p.key}
                type="button"
                disabled={presetsDisabled}
                title={!tz ? NO_TZ_TITLE : undefined}
                onClick={() => {
                  // Re-narrows tz for TypeScript and fails closed if this is ever
                  // reached with no zone; presetsDisabled already blocks the click.
                  if (!tz) return
                  const range = getPresetRange(p.key, new Date(), tz)
                  // Exactly one call: the parent sets both halves in one handler
                  // body, React batches them into a single render, and the memoised
                  // fetch fires once. Two calls here would mean two requests.
                  onChange(range.from, range.to)
                }}
                style={{
                  // Tailwind v4 does not emit dynamically built colour classes, so
                  // every state-dependent colour in this project is an inline style.
                  backgroundColor: active ? '#FF8303' : 'white',
                  color: active ? 'white' : '#374151',
                  border: `1px solid ${active ? '#FF8303' : '#D1D5DB'}`,
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '13px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  cursor: presetsDisabled ? 'not-allowed' : 'pointer',
                  opacity: presetsDisabled ? 0.5 : 1,
                }}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
