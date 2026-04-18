'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { DatePartInput } from '../../_components/DatePartInput'

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
  temp_password: string
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
  first_name: '', last_name: '', email: '', temp_password: '',
  timezone: 'Africa/Johannesburg', account_types: ['teacher'],
  status: 'current', contract_start: '', orientation_date: '',
  observed_lesson_date: '', title: '', date_of_birth: '', gender: '',
  nationality: '', phone: '', street_address: '', area_code: '', city: '',
  paypal_email: '', iban: '', bic: '', vat_required: false, tax_number: '',
  hourly_rate: '', currency: 'EUR', native_languages: [], teaching_languages: [],
  qualifications: '', specialties: '', bio: '', quote: '',
  admin_notes: '', follow_up_date: '', follow_up_reason: '',
}

// Reusable field wrapper
function Field({ label, children, adminOnly }: {
  label: string
  children: React.ReactNode
  adminOnly?: boolean
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {adminOnly && (
          <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded"
            style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
            Admin only
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

const inputClass = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
const selectClass = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 bg-white"

export default function CreateTeacherClient() {
  const router = useRouter()
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<'A' | 'B'>('A')
  const [showTempPassword, setShowTempPassword] = useState(false)

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
    setError(null)

    // Basic validation
    if (!form.first_name.trim()) return setError('First name is required.')
    if (!form.last_name.trim()) return setError('Last name is required.')
    if (!form.email.trim()) return setError('Email is required.')
    if (!form.temp_password.trim()) return setError('Temporary password is required.')
    if (form.account_types.length === 0) return setError('At least one account type is required.')

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

      router.push('/admin/teachers')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push('/admin/teachers')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Teachers
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Add Teacher</h1>
      </div>

      {/* Section tabs */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {(['A', 'B'] as const).map((section) => (
          <button
            key={section}
            onClick={() => setActiveSection(section)}
            className="px-5 py-2 text-sm font-medium transition-colors"
            style={activeSection === section
              ? { backgroundColor: '#FF8303', color: 'white' }
              : { backgroundColor: 'white', color: '#6b7280' }}
          >
            {section === 'A' ? 'Account & Login' : 'Profile & Admin Info'}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg text-sm"
          style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
          {error}
        </div>
      )}

      {/* Section A */}
      {activeSection === 'A' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="font-semibold text-gray-800 text-base">Account & Login</h2>

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
            <input type="email" className={inputClass} value={form.email}
              onChange={(e) => set('email', e.target.value)} />
          </Field>

          <Field label="Temporary Password">
            <div style={{ position: 'relative' }}>
              <input type={showTempPassword ? 'text' : 'password'} className={inputClass + ' pr-10'} value={form.temp_password}
                onChange={(e) => set('temp_password', e.target.value)} />
              <button
                type="button"
                onClick={() => setShowTempPassword(v => !v)}
                style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                aria-label={showTempPassword ? 'Hide password' : 'Show password'}
              >
                {showTempPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Teacher will be prompted to set their own password on first login.
            </p>
          </Field>

          <Field label="Timezone">
            <select className={selectClass} value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}>
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
                    ? { backgroundColor: '#FF8303', color: 'white', borderColor: '#FF8303' }
                    : { backgroundColor: 'white', color: '#6b7280', borderColor: '#e5e7eb' }}
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

          <div className="flex justify-end pt-2">
            <button
              onClick={() => setActiveSection('B')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              Next: Profile & Admin Info →
            </button>
          </div>
        </div>
      )}

      {/* Section B */}
      {activeSection === 'B' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="font-semibold text-gray-800 text-base">Profile & Admin Info</h2>

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

          {/* Payment */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Payment Details</p>
            <div className="space-y-4">
              <Field label="PayPal Email">
                <input type="email" className={inputClass} value={form.paypal_email}
                  onChange={(e) => set('paypal_email', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="IBAN">
                  <input className={inputClass} value={form.iban}
                    onChange={(e) => set('iban', e.target.value)} />
                </Field>
                <Field label="BIC">
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
                  <span className="text-sm text-gray-600">This teacher is required to charge VAT</span>
                </label>
              </Field>
              <Field label="Hourly Rate" adminOnly>
                <div className="flex">
                  <select
                    className="border border-gray-200 rounded-l-lg px-2 py-2 text-sm focus:outline-none focus:border-orange-400 bg-white border-r-0"
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
                      className="w-full border border-gray-200 rounded-r-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                      value={form.hourly_rate}
                      onChange={(e) => set('hourly_rate', e.target.value)}
                    />
                  </div>
                </div>
              </Field>
            </div>
          </div>

          {/* Languages */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Languages</p>
            <div className="space-y-4">
              <Field label="Native Languages">
                <div className="flex flex-wrap gap-2 mt-1">
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <button key={lang} type="button"
                      onClick={() => toggleArrayItem('native_languages', lang)}
                      className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                      style={form.native_languages.includes(lang)
                        ? { backgroundColor: '#FF8303', color: 'white', borderColor: '#FF8303' }
                        : { backgroundColor: 'white', color: '#6b7280', borderColor: '#e5e7eb' }}>
                      {lang}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Teaches (Languages)">
                <div className="flex flex-wrap gap-2 mt-1">
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <button key={lang} type="button"
                      onClick={() => toggleArrayItem('teaching_languages', lang)}
                      className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                      style={form.teaching_languages.includes(lang)
                        ? { backgroundColor: '#FF8303', color: 'white', borderColor: '#FF8303' }
                        : { backgroundColor: 'white', color: '#6b7280', borderColor: '#e5e7eb' }}>
                      {lang}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </div>

          {/* Public profile */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Public Profile</p>
            <div className="space-y-4">
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
            </div>
          </div>

          {/* Admin only */}
          <div className="border-t border-gray-100 pt-4"
            style={{ backgroundColor: '#fffbeb', borderRadius: '8px', padding: '16px' }}>
            <p className="text-sm font-semibold mb-3" style={{ color: '#92400e' }}>
              🔒 Admin Only — Not visible to teacher
            </p>
            <div className="space-y-4">
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

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setActiveSection('A')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back to Account & Login
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => router.push('/admin/teachers')}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={saving}
                className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#FF8303' }}
              >
                {saving ? 'Creating...' : 'Create Teacher'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}