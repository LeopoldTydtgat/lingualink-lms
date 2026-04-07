'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const TIMEZONES = [
  'Africa/Johannesburg', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Amsterdam', 'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw',
  'Europe/Prague', 'Europe/Budapest', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney',
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

type Teacher = Record<string, unknown>

type Props = {
  teacher: Teacher
  initialSection: 'A' | 'B'
}

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

export default function EditTeacherClient({ teacher, initialSection }: Props) {
  const router = useRouter()
  const id = teacher.id as string

  // Pre-populate form from existing teacher data
  const [form, setForm] = useState({
    first_name: ((teacher.full_name as string) ?? '').split(' ')[0] ?? '',
    last_name: ((teacher.full_name as string) ?? '').split(' ').slice(1).join(' ') ?? '',
    timezone: (teacher.timezone as string) ?? 'Africa/Johannesburg',
    account_types: (teacher.account_types as string[]) ?? ['teacher'],
    status: (teacher.status as string) ?? 'current',
    contract_start: (teacher.contract_start as string) ?? '',
    orientation_date: (teacher.orientation_date as string) ?? '',
    observed_lesson_date: (teacher.observed_lesson_date as string) ?? '',
    title: (teacher.title as string) ?? '',
    date_of_birth: (teacher.date_of_birth as string) ?? '',
    gender: (teacher.gender as string) ?? '',
    nationality: (teacher.nationality as string) ?? '',
    phone: (teacher.phone as string) ?? '',
    street_address: (teacher.street_address as string) ?? '',
    area_code: (teacher.area_code as string) ?? '',
    city: (teacher.city as string) ?? '',
    paypal_email: (teacher.paypal_email as string) ?? '',
    iban: (teacher.iban as string) ?? '',
    bic: (teacher.bic as string) ?? '',
    vat_required: (teacher.vat_required as boolean) ?? false,
    tax_number: (teacher.tax_number as string) ?? '',
    hourly_rate: teacher.hourly_rate != null ? String(teacher.hourly_rate) : '',
    native_languages: (teacher.native_languages as string[]) ?? [],
    teaching_languages: (teacher.teaching_languages as string[]) ?? [],
    qualifications: (teacher.qualifications as string) ?? '',
    specialties: (teacher.specialties as string) ?? '',
    bio: (teacher.bio as string) ?? '',
    quote: (teacher.quote as string) ?? '',
    video_url: (teacher.video_url as string) ?? '',
    admin_notes: (teacher.admin_notes as string) ?? '',
    follow_up_date: (teacher.follow_up_date as string) ?? '',
    follow_up_reason: (teacher.follow_up_reason as string) ?? '',
  })

  const [activeSection, setActiveSection] = useState<'A' | 'B'>(initialSection)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: string, value: string | boolean | string[]) {
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

  async function handleSave() {
    setError(null)
    if (!form.first_name.trim()) return setError('First name is required.')
    if (!form.last_name.trim()) return setError('Last name is required.')

    setSaving(true)
    try {
      const res = await fetch(`/api/admin/teachers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: `${form.first_name.trim()} ${form.last_name.trim()}`,
          timezone: form.timezone,
          account_types: form.account_types,
          status: form.status,
          contract_start: form.contract_start || null,
          orientation_date: form.orientation_date || null,
          observed_lesson_date: form.observed_lesson_date || null,
          title: form.title || null,
          gender: form.gender || null,
          nationality: form.nationality || null,
          phone: form.phone || null,
          street_address: form.street_address || null,
          area_code: form.area_code || null,
          city: form.city || null,
          paypal_email: form.paypal_email || null,
          iban: form.iban || null,
          bic: form.bic || null,
          vat_required: form.vat_required,
          tax_number: form.tax_number || null,
          hourly_rate: form.hourly_rate ? parseFloat(form.hourly_rate) : null,
          native_languages: form.native_languages,
          teaching_languages: form.teaching_languages,
          specialties: form.specialties || null,
          bio: form.bio || null,
          quote: form.quote || null,
          video_url: form.video_url || null,
          admin_notes: form.admin_notes || null,
          follow_up_date: form.follow_up_date || null,
          follow_up_reason: form.follow_up_reason || null,
          role: form.account_types.includes('school_admin') ? 'admin' : 'teacher',
          teacher_type: form.account_types.includes('teacher_exam') ? 'teacher_exam' : 'teacher',
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save changes.')

      router.push(`/admin/teachers/${id}`)
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
          onClick={() => router.push(`/admin/teachers/${id}`)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← {teacher.full_name as string}
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Edit Teacher</h1>
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

          {/* Email is read-only on edit — contact Supabase to change */}
          <Field label="Email Address">
            <input className={inputClass} value={teacher.email as string}
              disabled
              style={{ backgroundColor: '#f9fafb', color: '#9ca3af' }} />
            <p className="text-xs text-gray-400 mt-1">
              Email cannot be changed here. Contact support to update login email.
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
                <button key={opt.value} type="button"
                  onClick={() => toggleArrayItem('account_types', opt.value)}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border transition-colors"
                  style={form.account_types.includes(opt.value)
                    ? { backgroundColor: '#FF8303', color: 'white', borderColor: '#FF8303' }
                    : { backgroundColor: 'white', color: '#6b7280', borderColor: '#e5e7eb' }}>
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
              <input type="date" className={inputClass} value={form.contract_start}
                onChange={(e) => set('contract_start', e.target.value)} />
            </Field>
            <Field label="Orientation Date">
              <input type="date" className={inputClass} value={form.orientation_date}
                onChange={(e) => set('orientation_date', e.target.value)} />
            </Field>
            <Field label="Observed Lesson Date">
              <input type="date" className={inputClass} value={form.observed_lesson_date}
                onChange={(e) => set('observed_lesson_date', e.target.value)} />
            </Field>
          </div>

          <div className="flex justify-end pt-2">
            <button onClick={() => setActiveSection('B')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}>
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
            <input type="date" className={inputClass} value={form.date_of_birth}
              onChange={(e) => set('date_of_birth', e.target.value)} />
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
              <Field label="Hourly Rate (€)" adminOnly>
                <input type="number" min="0" step="0.01" className={inputClass}
                  value={form.hourly_rate}
                  onChange={(e) => set('hourly_rate', e.target.value)} />
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
              <Field label="YouTube Video URL">
                <input type="url" className={inputClass} value={form.video_url}
                  onChange={(e) => set('video_url', e.target.value)}
                  placeholder="https://youtube.com/..." />
              </Field>
            </div>
          </div>

          {/* Admin only */}
          <div className="border-t border-gray-100 pt-4 rounded-xl p-4"
            style={{ backgroundColor: '#fffbeb' }}>
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
                  <input type="date" className={inputClass} value={form.follow_up_date}
                    onChange={(e) => set('follow_up_date', e.target.value)} />
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
            <button onClick={() => setActiveSection('A')}
              className="text-sm text-gray-500 hover:text-gray-700">
              ← Back to Account & Login
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => router.push(`/admin/teachers/${id}`)}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#FF8303' }}>
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}