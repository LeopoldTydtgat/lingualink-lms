'use client'

import { useRef, useState } from 'react'

function parseDate(value: string): { day: string; month: string; year: string } {
  if (!value) return { day: '', month: '', year: '' }
  const parts = value.split('-')
  return { day: parts[2] ?? '', month: parts[1] ?? '', year: parts[0] ?? '' }
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

  const monthRef = useRef<HTMLInputElement>(null)
  const yearRef = useRef<HTMLInputElement>(null)

  function assemble(d: string, m: string, y: string) {
    if (d && m && y.length === 4) {
      onChange(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
    } else {
      onChange('')
    }
  }

  const partClass =
    'border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:border-orange-400'

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        placeholder="dd"
        value={day}
        className={partClass}
        style={{ width: '52px', padding: '8px 4px' }}
        onChange={(e) => {
          const val = e.target.value.replace(/\D/g, '').slice(0, 2)
          setDay(val)
          assemble(val, month, year)
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
        className={partClass}
        style={{ width: '52px', padding: '8px 4px' }}
        onChange={(e) => {
          const val = e.target.value.replace(/\D/g, '').slice(0, 2)
          setMonth(val)
          assemble(day, val, year)
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
        className={partClass}
        style={{ width: '72px', padding: '8px 4px' }}
        onChange={(e) => {
          const val = e.target.value.replace(/\D/g, '').slice(0, 4)
          setYear(val)
          assemble(day, month, val)
        }}
      />
    </div>
  )
}
