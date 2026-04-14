'use client'

// ─── Language list (alphabetical) ─────────────────────────────────────────────

const LANGUAGES = [
  'Afrikaans',
  'Arabic',
  'Bengali',
  'Bulgarian',
  'Catalan',
  'Croatian',
  'Czech',
  'Danish',
  'Dutch',
  'English',
  'Estonian',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hebrew',
  'Hindi',
  'Hungarian',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Latvian',
  'Lithuanian',
  'Malay',
  'Mandarin Chinese',
  'Norwegian',
  'Persian (Farsi)',
  'Polish',
  'Portuguese',
  'Romanian',
  'Russian',
  'Serbian',
  'Slovak',
  'Slovenian',
  'Spanish',
  'Swedish',
  'Tamil',
  'Telugu',
  'Thai',
  'Turkish',
  'Ukrainian',
  'Urdu',
  'Vietnamese',
]

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export default function LanguageSelect({ value, onChange, placeholder, className }: Props) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={className}
      style={{
        width: '100%',
        padding: '9px 12px',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        fontSize: '14px',
        color: value ? '#111827' : '#9ca3af',
        backgroundColor: '#ffffff',
        outline: 'none',
        boxSizing: 'border-box',
        cursor: 'pointer',
        appearance: 'auto',
      }}
    >
      <option value="">{placeholder ?? 'Select language…'}</option>
      {LANGUAGES.map(lang => (
        <option key={lang} value={lang} style={{ color: '#111827' }}>
          {lang}
        </option>
      ))}
    </select>
  )
}
