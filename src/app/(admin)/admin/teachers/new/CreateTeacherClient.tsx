'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DatePartInput } from '../../_components/DatePartInput'
import { toast } from 'sonner'

const TIMEZONES = [
  'Africa/Johannesburg',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Warsaw',
  'Europe/Prague',
  'Europe/Budapest',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
]

const CURRENCY_OPTIONS = [
  { value: 'EUR', symbol: '€' },
  { value: 'GBP', symbol: '£' },
  { value: 'USD', symbol: '$' },
]

const ACCOUNT_TYPE_OPTIONS = [
  { value: 'teacher', label: 'Teacher' },
  { value: 'teacher_exam', label: 'Teacher+Exam' },
  { value: 'staff', label: 'Staff' },
  { value: 'hr_admin', label: 'HR Admin' },
  { value: 'school_admin', label: 'School Admin' },
]

const STATUS_OPTIONS = [
  { value: 'current', label: 'Current' },
  { value: 'former', label: 'Former' },
  { value: 'on_hold', label: 'On Hold' },
]

const LANGUAGE_OPTIONS = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese',
  'Dutch', 'Polish', 'Czech', 'Hungarian', 'Romanian', 'Swedish',
  'Norwegian', 'Danish', 'Finnish', 'Afrikaans', 'Zulu', 'Xhosa',
]

const TITLE_OPTIONS = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof']
const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Prefer not to say']

type FormData = {
  // Section A
  first_name: string
  last_name: string
  email: string
  timezone: string
  account_types: string[]
  status: string
  contract_start: string
  orientation_date: string
  observed_lesson_date: string
  // Section B
  title: string
  date_of_birth: string
  gender: string
  nationality: string
  phone: string
  street_address: string
  area_code: string
  city: string
  preferred_payment_type: string
  paypal_email: string
  iban: string
  bic: string
  vat_required: boolean
  tax_number: string
  hourly_rate: string
  currency: string
  native_languages: string[]
  teaching_languages: string[]
  qualifications: string
  specialties: string
  bio: string
  quote: string
  admin_notes: string
  follow_up_date: string
  follow_up_reason: string
}

const EMPTY_FORM: FormData = {
  first_name: '', last_name: '', email: '',
  timezone: '', account_types: ['teacher'],
  status: 'current', contract_start: '', orientation_date: '',
  observed_lesson_date: '', title: '', date_of_birth: '', gender: '',
  nationality: '', phone: '', street_address: '', area_code: '', city: '',
  preferred_payment_type: 'bank', paypal_email: '', iban: '', bic: '', vat_required: false, tax_number: '',
  hourly_rate: '', currency: 'EUR', native_languages: [], teaching_languages: [],
  qualifications: '', specialties: '', bio: '', quote: '',
  admin_notes: '', follow_up_date: '', follow_up_reason: '',
}

// Quiet grey "admin only" pill — the loud amber card at the bottom carries the message.
function AdminOnlyBadge() {
  return (
    <span
      className="ml-2 inline-flex items-center gap-1 align-middle text-[10px] font-normal px-1.5 py-0.5 rounded"
      style={{ backgroundColor: '#f3f4f6', color: '#6b7280' }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" style={{ width: '9px', height: '9px' }} aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      Admin only
    </span>
  )
}

// Reusable field wrapper
function Field({ label, children, adminOnly }: {
  label: string
  children: React.ReactNode
  adminOnly?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: '#4b5563' }}>
        {label}
        {adminOnly && <AdminOnlyBadge />}
      </label>
      {children}
    </div>
  )
}

// Bordered section card — matches the Teacher Detail Overview tab's card style.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border p-5 space-y-4" style={{ borderColor: '#E0DFDC' }}>
      <div className="flex items-center gap-2.5">
        <span className="block rounded-full" style={{ width: '3px', height: '18px', backgroundColor: '#FF8303' }} />
        <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
      </div>
      {children}
    </div>
  )
}

// Preset + custom language pills. Selected pills show a check; custom (non-preset)
// entries also get an × to remove them. The "+ Other" input is local state scoped
// to this component instance, so Native and Teaches stay independent.
function LanguagePicker({ values, onToggle, onAddCustom, onRemoveCustom }: {
  values: string[]
  onToggle: (lang: string) => void
  onAddCustom: (lang: string) => void
  onRemoveCustom: (lang: string) => void
}) {
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')

  const customValues = values.filter((v) => !LANGUAGE_OPTIONS.includes(v))

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
        const selected = values.includes(lang)
        return (
          <button key={lang} type="button"
            onClick={() => onToggle(lang)}
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

const inputClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm text-gray-800 transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"
const selectClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"

export default function CreateTeacherClient() {
  const router = useRouter()
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  function set(field: keyof FormData, value: string | boolean | string[]) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function toggleArrayItem(field: 'account_types' | 'native_languages' | 'teaching_languages', value: string) {
    setForm((prev) => {
      const arr = prev[field] as string[]
      return {
        ...prev,
        [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value],
      }
    })
  }

  async function handleSubmit() {
    // Basic validation
    if (!form.first_name.trim()) { toast.error('First name is required.'); return }
    if (!form.last_name.trim()) { toast.error('Last name is required.'); return }
    if (!form.email.trim()) { toast.error('Email is required.'); return }
    if (!form.timezone) { toast.error('Timezone is required.'); return }
    if (form.account_types.length === 0) { toast.error('At least one account type is required.'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/admin/teachers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          full_name: `${form.first_name.trim()} ${form.last_name.trim()}`,
          hourly_rate: form.hourly_rate ? parseFloat(parseFloat(form.hourly_rate).toFixed(2)) : null,
          currency: form.currency,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create teacher.')

      // Fail-safe: warn unless the API positively confirmed the invite went out.
      if (data.inviteEmailSent !== true) {
        toast.warning(
          'Teacher created, but the invite email could not be sent. The teacher can use "Forgot password" on the login page, or contact support.',
          { duration: 10000 }
        )
      } else {
        toast.success('Teacher created — invite email sent!')
      }
      setTimeout(() => { router.push('/admin/teachers'); router.refresh() }, 800)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong.', { duration: 6000 })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* Header */}
      <div className="max-w-4xl mx-auto flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push('/admin/teachers')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Teachers
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Add Teacher</h1>
      </div>

      {/* Single scrolling form — one card per section.
          pb-28 keeps the last field clear of the sticky action bar. */}
      <div className="max-w-4xl mx-auto space-y-8 pb-28">

        {/* 1. Account & Login */}
        <Section title="Account & Login">
          <div className="grid grid-cols-2 gap-4">
            <Field label="First Name">
              <input className={inputClass} value={form.first_name}
                onChange={(e) => set('first_name', e.target.value)} />
            </Field>
            <Field label="Last Name">
              <input className={inputClass} value={form.last_name}
                onChange={(e) => set('last_name', e.target.value)} />
            </Field>
          </div>

          <Field label="Email Address">
            <input type="email" autoComplete="off" className={inputClass} value={form.email}
              onChange={(e) => set('email', e.target.value)} />
            <p className="text-xs text-gray-400 mt-1">
              The teacher will receive an invite email at this address to set their own password.
            </p>
          </Field>

          <Field label="Timezone">
            <select className={selectClass} value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}>
              <option value="">— Select timezone —</option>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </Field>

          <Field label="Account Types">
            <div className="flex flex-wrap gap-2 mt-1">
              {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleArrayItem('account_types', opt.value)}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border transition-colors"
                  style={form.account_types.includes(opt.value)
                    ? { backgroundColor: '#FFF0E0', color: '#FF8303', borderColor: '#FF8303' }
                    : { backgroundColor: 'white', color: '#4b5563', borderColor: '#E0DFDC' }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Status">
            <select className={selectClass} value={form.status}
              onChange={(e) => set('status', e.target.value)}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-3 gap-4">
            <Field label="Contract Start Date">
              <DatePartInput value={form.contract_start} onChange={(v) => set('contract_start', v)} />
            </Field>
            <Field label="Orientation Date">
              <DatePartInput value={form.orientation_date} onChange={(v) => set('orientation_date', v)} />
            </Field>
            <Field label="Observed Lesson Date">
              <DatePartInput value={form.observed_lesson_date} onChange={(v) => set('observed_lesson_date', v)} />
            </Field>
          </div>
        </Section>

        {/* 2. Personal */}
        <Section title="Personal">
          <div className="grid grid-cols-3 gap-4">
            <Field label="Title">
              <select className={selectClass} value={form.title}
                onChange={(e) => set('title', e.target.value)}>
                <option value="">— Select —</option>
                {TITLE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Gender">
              <select className={selectClass} value={form.gender}
                onChange={(e) => set('gender', e.target.value)}>
                <option value="">— Select —</option>
                {GENDER_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="Nationality">
              <input className={inputClass} value={form.nationality}
                onChange={(e) => set('nationality', e.target.value)} />
            </Field>
          </div>

          <Field label="Date of Birth" adminOnly>
            <DatePartInput value={form.date_of_birth} onChange={(v) => set('date_of_birth', v)} />
          </Field>

          <Field label="Phone / Mobile">
            <input className={inputClass} value={form.phone}
              onChange={(e) => set('phone', e.target.value)} />
          </Field>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <Field label="Street Address">
                <input className={inputClass} value={form.street_address}
                  onChange={(e) => set('street_address', e.target.value)} />
              </Field>
            </div>
            <Field label="Area Code">
              <input className={inputClass} value={form.area_code}
                onChange={(e) => set('area_code', e.target.value)} />
            </Field>
          </div>

          <Field label="City">
            <input className={inputClass} value={form.city}
              onChange={(e) => set('city', e.target.value)} />
          </Field>
        </Section>

        {/* 3. Payment */}
        <Section title="Payment Details">
          <Field label="Preferred Payment Type">
            <select className={selectClass} value={form.preferred_payment_type}
              onChange={(e) => {
                const val = e.target.value
                setForm((prev) => ({
                  ...prev,
                  preferred_payment_type: val,
                  paypal_email: val === 'paypal' ? prev.paypal_email : '',
                }))
              }}>
              <option value="bank">Bank Transfer</option>
              <option value="paypal">PayPal</option>
            </select>
          </Field>
          {form.preferred_payment_type === 'paypal' && (
            <Field label="PayPal Email">
              <input type="email" className={inputClass} value={form.paypal_email}
                onChange={(e) => set('paypal_email', e.target.value)} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="IBAN">
              <input className={inputClass} value={form.iban}
                onChange={(e) => set('iban', e.target.value)} />
            </Field>
            <Field label="SWIFT / BIC">
              <input className={inputClass} value={form.bic}
                onChange={(e) => set('bic', e.target.value)} />
            </Field>
          </div>
          <Field label="Tax Number">
            <input className={inputClass} value={form.tax_number}
              onChange={(e) => set('tax_number', e.target.value)} />
          </Field>
          <Field label="VAT Required" adminOnly>
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input type="checkbox" checked={form.vat_required}
                onChange={(e) => set('vat_required', e.target.checked)}
                className="w-4 h-4 rounded" />
              <span className="text-sm" style={{ color: '#4b5563' }}>This teacher is required to charge VAT</span>
            </label>
          </Field>
          <Field label="Hourly Rate" adminOnly>
            <div className="flex">
              <select
                className="border border-[#E0DFDC] rounded-l-lg px-2 py-1.5 text-sm text-gray-800 bg-white border-r-0 transition-colors focus:outline-none focus:border-[#FF8303]"
                value={form.currency}
                onChange={(e) => set('currency', e.target.value)}
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.symbol} {c.value}</option>
                ))}
              </select>
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none select-none">
                  {CURRENCY_OPTIONS.find(c => c.value === form.currency)?.symbol ?? '€'}
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-full border border-[#E0DFDC] rounded-r-lg pl-7 pr-3 py-1.5 text-sm text-gray-800 transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"
                  value={form.hourly_rate}
                  onChange={(e) => set('hourly_rate', e.target.value)}
                />
              </div>
            </div>
          </Field>
        </Section>

        {/* 4. Languages */}
        <Section title="Languages">
          <Field label="Native Languages">
            <LanguagePicker
              values={form.native_languages}
              onToggle={(lang) => toggleArrayItem('native_languages', lang)}
              onAddCustom={(lang) => setForm((prev) => ({ ...prev, native_languages: [...prev.native_languages, lang] }))}
              onRemoveCustom={(lang) => setForm((prev) => ({ ...prev, native_languages: prev.native_languages.filter((v) => v !== lang) }))}
            />
          </Field>
          <Field label="Teaches (Languages)">
            <LanguagePicker
              values={form.teaching_languages}
              onToggle={(lang) => toggleArrayItem('teaching_languages', lang)}
              onAddCustom={(lang) => setForm((prev) => ({ ...prev, teaching_languages: [...prev.teaching_languages, lang] }))}
              onRemoveCustom={(lang) => setForm((prev) => ({ ...prev, teaching_languages: prev.teaching_languages.filter((v) => v !== lang) }))}
            />
          </Field>
        </Section>

        {/* 5. Public Profile */}
        <Section title="Public Profile">
          <Field label="Qualifications & Experience">
            <textarea rows={3} className={inputClass} value={form.qualifications}
              onChange={(e) => set('qualifications', e.target.value)} />
          </Field>
          <Field label="Specialties">
            <input className={inputClass} value={form.specialties}
              onChange={(e) => set('specialties', e.target.value)} />
          </Field>
          <Field label="About Me (Bio)">
            <textarea rows={4} className={inputClass} value={form.bio}
              onChange={(e) => set('bio', e.target.value)} />
          </Field>
          <Field label="Inspirational Quote">
            <input className={inputClass} value={form.quote}
              onChange={(e) => set('quote', e.target.value)} />
          </Field>
        </Section>

        {/* 6. Admin Notes — amber, admin-only */}
        <div className="rounded-xl border p-5 space-y-4"
          style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
          <h2 className="font-semibold" style={{ color: '#92400e' }}>
            🔒 Admin Only — Not visible to teacher
          </h2>
          <Field label="Admin Notes" adminOnly>
            <textarea rows={4} className={inputClass} value={form.admin_notes}
              onChange={(e) => set('admin_notes', e.target.value)}
              placeholder="Internal notes: warnings, training records, performance observations..." />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Follow-up Date" adminOnly>
              <DatePartInput value={form.follow_up_date} onChange={(v) => set('follow_up_date', v)} />
            </Field>
            <Field label="Follow-up Reason" adminOnly>
              <input className={inputClass} value={form.follow_up_reason}
                onChange={(e) => set('follow_up_reason', e.target.value)}
                placeholder="e.g. Performance review, contract renewal..." />
            </Field>
          </div>
        </div>
      </div>

      {/* Sticky action bar — sticks to the bottom of the scrolling main area */}
      <div className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}>
        <button
          onClick={() => router.push('/admin/teachers')}
          className="px-4 py-2 rounded-lg text-sm font-medium border border-[#E0DFDC] hover:bg-gray-50"
          style={{ color: '#4b5563' }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="btn-primary-hover px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
          style={{ backgroundColor: '#FF8303' }}
        >
          {saving ? 'Creating...' : 'Create Teacher'}
        </button>
      </div>
    </div>
  )
}
