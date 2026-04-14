'use client'

import { useState, useRef, useEffect } from 'react'

// ─── Timezone data grouped by region ─────────────────────────────────────────

interface TzEntry { tz: string; region: string }

const TIMEZONES: TzEntry[] = [
  // UTC
  { tz: 'UTC',                    region: 'UTC'       },
  // Africa
  { tz: 'Africa/Cairo',           region: 'Africa'    },
  { tz: 'Africa/Johannesburg',    region: 'Africa'    },
  { tz: 'Africa/Lagos',           region: 'Africa'    },
  { tz: 'Africa/Nairobi',         region: 'Africa'    },
  // America — sorted by city name
  { tz: 'America/Bogota',         region: 'America'   },
  { tz: 'America/Buenos_Aires',   region: 'America'   },
  { tz: 'America/Chicago',        region: 'America'   },
  { tz: 'America/Denver',         region: 'America'   },
  { tz: 'America/Lima',           region: 'America'   },
  { tz: 'America/Los_Angeles',    region: 'America'   },
  { tz: 'America/Mexico_City',    region: 'America'   },
  { tz: 'America/New_York',       region: 'America'   },
  { tz: 'America/Santiago',       region: 'America'   },
  { tz: 'America/Sao_Paulo',      region: 'America'   },
  { tz: 'America/Toronto',        region: 'America'   },
  { tz: 'America/Vancouver',      region: 'America'   },
  // Asia
  { tz: 'Asia/Bangkok',           region: 'Asia'      },
  { tz: 'Asia/Dhaka',             region: 'Asia'      },
  { tz: 'Asia/Dubai',             region: 'Asia'      },
  { tz: 'Asia/Hong_Kong',         region: 'Asia'      },
  { tz: 'Asia/Jakarta',           region: 'Asia'      },
  { tz: 'Asia/Karachi',           region: 'Asia'      },
  { tz: 'Asia/Kolkata',           region: 'Asia'      },
  { tz: 'Asia/Kuala_Lumpur',      region: 'Asia'      },
  { tz: 'Asia/Manila',            region: 'Asia'      },
  { tz: 'Asia/Riyadh',            region: 'Asia'      },
  { tz: 'Asia/Seoul',             region: 'Asia'      },
  { tz: 'Asia/Shanghai',          region: 'Asia'      },
  { tz: 'Asia/Singapore',         region: 'Asia'      },
  { tz: 'Asia/Taipei',            region: 'Asia'      },
  { tz: 'Asia/Tokyo',             region: 'Asia'      },
  // Australia
  { tz: 'Australia/Brisbane',     region: 'Australia' },
  { tz: 'Australia/Melbourne',    region: 'Australia' },
  { tz: 'Australia/Perth',        region: 'Australia' },
  { tz: 'Australia/Sydney',       region: 'Australia' },
  // Europe
  { tz: 'Europe/Amsterdam',       region: 'Europe'    },
  { tz: 'Europe/Athens',          region: 'Europe'    },
  { tz: 'Europe/Berlin',          region: 'Europe'    },
  { tz: 'Europe/Brussels',        region: 'Europe'    },
  { tz: 'Europe/Bucharest',       region: 'Europe'    },
  { tz: 'Europe/Budapest',        region: 'Europe'    },
  { tz: 'Europe/Copenhagen',      region: 'Europe'    },
  { tz: 'Europe/Dublin',          region: 'Europe'    },
  { tz: 'Europe/Helsinki',        region: 'Europe'    },
  { tz: 'Europe/Kiev',            region: 'Europe'    },
  { tz: 'Europe/Lisbon',          region: 'Europe'    },
  { tz: 'Europe/London',          region: 'Europe'    },
  { tz: 'Europe/Madrid',          region: 'Europe'    },
  { tz: 'Europe/Moscow',          region: 'Europe'    },
  { tz: 'Europe/Oslo',            region: 'Europe'    },
  { tz: 'Europe/Paris',           region: 'Europe'    },
  { tz: 'Europe/Prague',          region: 'Europe'    },
  { tz: 'Europe/Rome',            region: 'Europe'    },
  { tz: 'Europe/Stockholm',       region: 'Europe'    },
  { tz: 'Europe/Vienna',          region: 'Europe'    },
  { tz: 'Europe/Warsaw',          region: 'Europe'    },
  { tz: 'Europe/Zurich',          region: 'Europe'    },
  // Pacific
  { tz: 'Pacific/Auckland',       region: 'Pacific'   },
  { tz: 'Pacific/Fiji',           region: 'Pacific'   },
  { tz: 'Pacific/Honolulu',       region: 'Pacific'   },
]

const REGION_ORDER = ['UTC', 'Africa', 'America', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Pacific']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeOffset(tz: string): string {
  if (tz === 'UTC') return 'UTC+0'
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    const raw = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
    // Normalise: "GMT" → "UTC+0", "GMT+2" → "UTC+2", "GMT-5" → "UTC-5"
    if (raw === 'GMT') return 'UTC+0'
    return raw.replace('GMT', 'UTC')
  } catch {
    return 'UTC'
  }
}

function displayLabel(tz: string, offset: string): string {
  // "America/New_York" → "America/New York (UTC-5)"
  const name = tz.replace(/_/g, ' ')
  return `${name} (${offset})`
}

// Pre-compute offsets once (module level, runs only on the client after hydration
// via useEffect in the component — see below).
function buildOffsetMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const { tz } of TIMEZONES) {
    map[tz] = computeOffset(tz)
  }
  return map
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  value: string
  onChange: (value: string) => void
  className?: string
}

export default function TimezoneSelect({ value, onChange, className }: Props) {
  const [isOpen, setIsOpen]     = useState(false)
  const [query, setQuery]       = useState('')
  // Offsets are empty on first SSR pass, filled after mount to avoid hydration mismatch
  const [offsets, setOffsets]   = useState<Record<string, string>>({})
  const containerRef            = useRef<HTMLDivElement>(null)
  const inputRef                = useRef<HTMLInputElement>(null)
  const listRef                 = useRef<HTMLDivElement>(null)

  // Fill offsets client-side only
  useEffect(() => {
    setOffsets(buildOffsetMap())
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  // ── Derived values ──────────────────────────────────────────────────────────

  const selectedOffset = value ? (offsets[value] ?? '') : ''
  const selectedLabel  = value ? displayLabel(value, selectedOffset) : ''

  const lowerQuery = query.trim().toLowerCase()
  const filtered: TzEntry[] = lowerQuery
    ? TIMEZONES.filter(({ tz }) =>
        tz.toLowerCase().includes(lowerQuery) ||
        tz.replace(/_/g, ' ').toLowerCase().includes(lowerQuery)
      )
    : TIMEZONES

  // Group filtered results by region in the canonical order
  const grouped: { region: string; entries: TzEntry[] }[] = REGION_ORDER
    .map(region => ({ region, entries: filtered.filter(t => t.region === region) }))
    .filter(g => g.entries.length > 0)

  // ── Interaction handlers ────────────────────────────────────────────────────

  function open() {
    setIsOpen(true)
    setQuery('')
  }

  function handleSelect(tz: string) {
    onChange(tz)
    setIsOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const inputBaseStyle: React.CSSProperties = {
    width: '100%',
    padding: '9px 36px 9px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: isOpen ? '8px 8px 0 0' : '8px',
    fontSize: '14px',
    color: '#111827',
    backgroundColor: '#ffffff',
    outline: 'none',
    boxSizing: 'border-box',
    cursor: 'pointer',
    appearance: 'none' as const,
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: 'relative', width: '100%' }}
    >
      {/* Input / search field */}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          placeholder="Select timezone…"
          value={isOpen ? query : selectedLabel}
          onFocus={open}
          onChange={e => {
            setQuery(e.target.value)
            if (!isOpen) setIsOpen(true)
          }}
          style={inputBaseStyle}
        />
        {/* Chevron icon */}
        <svg
          viewBox="0 0 20 20"
          fill="none"
          style={{
            position: 'absolute',
            right: '10px',
            top: '50%',
            transform: isOpen ? 'translateY(-50%) rotate(180deg)' : 'translateY(-50%)',
            width: '16px',
            height: '16px',
            pointerEvents: 'none',
            color: '#9ca3af',
            transition: 'transform 0.15s ease',
          }}
        >
          <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div
          ref={listRef}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            backgroundColor: '#ffffff',
            border: '1px solid #e5e7eb',
            borderTop: 'none',
            borderRadius: '0 0 8px 8px',
            maxHeight: '280px',
            overflowY: 'auto',
            zIndex: 9999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
        >
          {grouped.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: '14px', color: '#9ca3af' }}>
              No timezones found
            </div>
          ) : (
            grouped.map(({ region, entries }) => (
              <div key={region}>
                {/* Region header */}
                <div style={{
                  padding: '6px 12px 4px',
                  fontSize: '10px',
                  fontWeight: '700',
                  color: '#9ca3af',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  backgroundColor: '#f9fafb',
                  borderBottom: '1px solid #f3f4f6',
                  position: 'sticky',
                  top: 0,
                }}>
                  {region}
                </div>

                {entries.map(({ tz }) => {
                  const isSelected = tz === value
                  const label = displayLabel(tz, offsets[tz] ?? '')
                  return (
                    <OptionRow
                      key={tz}
                      label={label}
                      isSelected={isSelected}
                      onSelect={() => handleSelect(tz)}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ─── Row sub-component (handles hover with local state) ───────────────────────

function OptionRow({
  label,
  isSelected,
  onSelect,
}: {
  label: string
  isSelected: boolean
  onSelect: () => void
}) {
  const [hovered, setHovered] = useState(false)

  let bg = 'transparent'
  if (isSelected) bg = '#fff7ed'
  else if (hovered) bg = '#f9fafb'

  return (
    <div
      onMouseDown={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '8px 16px',
        fontSize: '14px',
        cursor: 'pointer',
        color: isSelected ? '#FF8303' : '#111827',
        backgroundColor: bg,
        fontWeight: isSelected ? '500' : 'normal',
      }}
    >
      {label}
    </div>
  )
}
