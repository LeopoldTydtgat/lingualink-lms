'use client'

import { useEffect, useRef, useState } from 'react'

function parseDate(value: string): { day: string; month: string; year: string } {
  if (!value) return { day: '', month: '', year: '' }
  const parts = value.split('-')
  return { day: parts[2] ?? '', month: parts[1] ?? '', year: parts[0] ?? '' }
}

// Calendar-aware day count. No Date object — avoids any timezone involvement.
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
}

export function DatePartInput({
  value,
  onChange,
}: {
  value: string
  onChange: (val: string) => void
}) {
  const init = parseDate(value)
  const [day, setDay] = useState(init.day)
  const [month, setMonth] = useState(init.month)
  const [year, setYear] = useState(init.year)
  const [invalid, setInvalid] = useState(false)

  const monthRef = useRef<HTMLInputElement>(null)
  const yearRef = useRef<HTMLInputElement>(null)

  // Last value this component emitted upward. Used to distinguish an external
  // value change (resync the boxes) from our own emission echoing back (ignore).
  const lastEmitted = useRef<string>(value)

  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    const next = parseDate(value)
    setDay(next.day)
    setMonth(next.month)
    setYear(next.year)
    setInvalid(false)
  }, [value])

  // Emission contract:
  //  - all three boxes empty  → emit '' (the only way to unset an optional date)
  //  - all three filled AND a real calendar date → emit YYYY-MM-DD
  //  - anything else (partial, or an impossible date) → emit NOTHING, so the
  //    parent keeps its last valid value instead of being wiped to NULL.
  function emit(d: string, m: string, y: string) {
    if (d === '' && m === '' && y === '') {
      setInvalid(false)
      if (lastEmitted.current !== '') {
        lastEmitted.current = ''
        onChange('')
      }
      return
    }

    if (d === '' || m === '' || y.length !== 4) {
      setInvalid(false)
      return
    }

    const dayNum = Number(d)
    const monthNum = Number(m)
    const yearNum = Number(y)

    if (
      yearNum < 1 ||
      monthNum < 1 || monthNum > 12 ||
      dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)
    ) {
      setInvalid(true)
      return
    }

    setInvalid(false)
    const next = `${String(yearNum).padStart(4, '0')}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
    if (next !== lastEmitted.current) {
      lastEmitted.current = next
      onChange(next)
    }
  }

  const partClass =
    'border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:border-orange-400'

  // Tailwind v4 cannot take a dynamically built colour class — inline style only.
  const errorBorder = invalid ? { borderColor: '#FD5602' } : {}

  return (
    <div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="numeric"
          maxLength={2}
          placeholder="dd"
          value={day}
          aria-invalid={invalid}
          className={partClass}
          style={{ width: '52px', padding: '8px 4px', ...errorBorder }}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, '').slice(0, 2)
            setDay(val)
            emit(val, month, year)
            if (val.length === 2) monthRef.current?.focus()
          }}
        />
        <span className="text-gray-400 text-sm">/</span>
        <input
          ref={monthRef}
          type="text"
          inputMode="numeric"
          maxLength={2}
          placeholder="mm"
          value={month}
          aria-invalid={invalid}
          className={partClass}
          style={{ width: '52px', padding: '8px 4px', ...errorBorder }}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, '').slice(0, 2)
            setMonth(val)
            emit(day, val, year)
            if (val.length === 2) yearRef.current?.focus()
          }}
        />
        <span className="text-gray-400 text-sm">/</span>
        <input
          ref={yearRef}
          type="text"
          inputMode="numeric"
          maxLength={4}
          placeholder="yyyy"
          value={year}
          aria-invalid={invalid}
          className={partClass}
          style={{ width: '72px', padding: '8px 4px', ...errorBorder }}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, '').slice(0, 4)
            setYear(val)
            emit(day, month, val)
          }}
        />
      </div>
      {invalid && (
        <p className="text-xs mt-1" style={{ color: '#FD5602' }}>
          Invalid date
        </p>
      )}
    </div>
  )
}
