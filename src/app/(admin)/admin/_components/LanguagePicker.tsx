'use client'

import { useState } from 'react'

export const LANGUAGE_OPTIONS = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese',
  'Dutch', 'Polish', 'Czech', 'Hungarian', 'Romanian', 'Swedish',
  'Norwegian', 'Danish', 'Finnish', 'Afrikaans', 'Zulu', 'Xhosa',
]

// DISPLAY-ONLY key. Used solely to decide whether a stored value should light up a
// preset pill instead of rendering as a removable custom chip, so legacy rows holding
// "english" or "English " classify as the English preset. It is never applied to the
// value that is stored or sent — the array keeps whatever string it already holds.
function displayKey(value: string) {
  return value.trim().toLowerCase()
}

const PRESET_KEYS = new Set(LANGUAGE_OPTIONS.map(displayKey))

// Preset + custom language pills. Selected pills show a check; custom (non-preset)
// entries also get an × to remove them. The "+ Other" input is local state scoped
// to this component instance, so Native and Teaches stay independent.
export function LanguagePicker({ values, onToggle, onAddCustom, onRemoveCustom }: {
  values: string[]
  onToggle: (lang: string) => void
  onAddCustom: (lang: string) => void
  onRemoveCustom: (lang: string) => void
}) {
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')

  const customValues = values.filter((v) => !PRESET_KEYS.has(displayKey(v)))

  function confirmOther() {
    const trimmed = otherText.trim()
    if (trimmed && !values.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      onAddCustom(trimmed)
    }
    setOtherText('')
    setOtherOpen(false)
  }

  return (
    <div className="flex flex-wrap gap-2 mt-1 items-center">
      {LANGUAGE_OPTIONS.map((lang) => {
        // The stored string that lit this preset up — may differ in case/whitespace
        // from `lang`. Toggling off must remove that exact stored string.
        const stored = values.find((v) => displayKey(v) === displayKey(lang))
        const selected = stored !== undefined
        return (
          <button key={lang} type="button"
            onClick={() => onToggle(stored ?? lang)}
            className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
            style={selected
              ? { backgroundColor: '#FFF0E0', color: '#FF8303', borderColor: '#FF8303' }
              : { backgroundColor: 'white', color: '#4b5563', borderColor: '#E0DFDC' }}>
            {selected && <span className="mr-1">✓</span>}
            {lang}
          </button>
        )
      })}

      {customValues.map((lang) => (
        <span key={lang}
          className="px-3 py-1 rounded-full text-xs font-medium border inline-flex items-center gap-1"
          style={{ backgroundColor: '#FFF0E0', color: '#FF8303', borderColor: '#FF8303' }}>
          <span>✓</span>
          {lang}
          <button type="button" onClick={() => onRemoveCustom(lang)}
            aria-label={`Remove ${lang}`}
            className="leading-none cursor-pointer"
            style={{ color: '#FF8303' }}>
            ×
          </button>
        </span>
      ))}

      {otherOpen ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); confirmOther() }
              if (e.key === 'Escape') { setOtherText(''); setOtherOpen(false) }
            }}
            placeholder="Language..."
            className="px-2 py-1 rounded-full text-xs border w-28 focus:outline-none"
            style={{ borderColor: '#E0DFDC', color: '#4b5563' }}
          />
          <button type="button" onClick={confirmOther}
            className="px-2 py-1 rounded-full text-xs font-medium border"
            style={{ backgroundColor: '#FFF0E0', color: '#FF8303', borderColor: '#FF8303' }}>
            Add
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => setOtherOpen(true)}
          className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
          style={{ backgroundColor: 'white', color: '#4b5563', borderColor: '#E0DFDC' }}>
          + Other
        </button>
      )}
    </div>
  )
}
