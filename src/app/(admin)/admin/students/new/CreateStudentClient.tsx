'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, CheckCircle } from 'lucide-react'
import { DatePartInput } from '../../_components/DatePartInput'

type Company = { id: string; name: string }
type Teacher = { id: string; full_name: string }

type Props = {
  companies: Company[]
  teachers: Teacher[]
}

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

const LANGUAGE_OPTIONS = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese',
  'Dutch', 'Polish', 'Czech', 'Hungarian', 'Romanian', 'Swedish',
  'Norwegian', 'Danish', 'Finnish', 'Afrikaans', 'Zulu', 'Xhosa',
]

const FLUENCY_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

const STATUS_OPTIONS = [
  { value: 'current', label: 'Current' },
  { value: 'former', label: 'Former' },
  { value: 'on_hold', label: 'On Hold' },
]

const CANCELLATION_OPTIONS = [
  { value: '24hr', label: '24 hours (default)' },
  { value: '48hr', label: '48 hours (B2B)' },
]

type FormData = {
  // Section A — Personal Info
  first_name: string
  last_name: string
  email: string
  temp_password: string
  date_of_birth: string
  phone: string
  timezone: string
  language_preference: string
  status: string
  customer_number: string
  is_private: boolean
  company_id: string
  academic_advisor_id: string
  assigned_teacher_ids: string[]
  // Section B — Learning Info
  native_language: string
  learning_language: string
  current_fluency_level: string
  self_assessed_level: string
  learning_goals: string
  interests: string
  // Section C — Training Setup
  package_name: string
  total_hours: string
  end_date: string
  cancellation_policy: string
  // Section D — Notes
  admin_notes: string
  teacher_notes: string
}

const EMPTY_FORM: FormData = {
  first_name: '', last_name: '', email: '', temp_password: '',
  date_of_birth: '', phone: '',
  timezone: 'Europe/Paris', language_preference: '',
  status: 'current', customer_number: '',
  is_private: true, company_id: '', academic_advisor_id: '',
  assigned_teacher_ids: [],
  native_language: '', learning_language: 'English',
  current_fluency_level: '', self_assessed_level: '',
  learning_goals: '', interests: '',
  package_name: '', total_hours: '', end_date: '',
  cancellation_policy: '24hr',
  admin_notes: '', teacher_notes: '',
}

type Section = 'A' | 'B' | 'C' | 'D'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'A', label: 'Personal Info' },
  { key: 'B', label: 'Learning Info' },
  { key: 'C', label: 'Training Setup' },
  { key: 'D', label: 'Notes' },
]

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
          <span
            className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded"
            style={{ backgroundColor: '#fef3c7', color: '#92400e' }}
          >
            Admin only
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
const selectClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 bg-white'

export default function CreateStudentClient({ companies, teachers }: Props) {
  const router = useRouter()
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [activeSection, setActiveSection] = useState<Section>('A')
  const [showTempPassword, setShowTempPassword] = useState(false)

  function set(field: keyof FormData, value: string | boolean | string[]) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function toggleTeacher(id: string) {
    setForm((prev) => {
      const ids = prev.assigned_teacher_ids
      return {
        ...prev,
        assigned_teacher_ids: ids.includes(id)
          ? ids.filter((i) => i !== id)
          : [...ids, id],
      }
    })
  }

  async function handleSubmit() {
    setError(null)

    // Validation
    if (!form.first_name.trim()) return setError('First name is required.')
    if (!form.last_name.trim()) return setError('Last name is required.')
    if (!form.email.trim()) return setError('Email is required.')
    if (!form.temp_password.trim()) return setError('Temporary password is required.')
    if (!form.timezone) return setError('Timezone is required.')
    if (form.assigned_teacher_ids.length === 0) return setError('At least one teacher must be assigned.')
    if (!form.package_name.trim()) return setError('Training package name is required.')
    if (!form.total_hours) return setError('Total hours is required.')

    setSaving(true)
    try {
      const res = await fetch('/api/admin/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          full_name: `${form.first_name.trim()} ${form.last_name.trim()}`,
          total_hours: parseFloat(form.total_hours),
          // Blank strings become null for optional FK fields
          company_id: form.company_id || null,
          academic_advisor_id: form.academic_advisor_id || null,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create student.')

      setSuccess(true)
      setTimeout(() => { router.push('/admin/students'); router.refresh() }, 1500)
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
          onClick={() => router.push('/admin/students')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Students
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Add Student</h1>
      </div>

      {/* Section tabs */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className="px-5 py-2 text-sm font-medium transition-colors"
            style={
              activeSection === s.key
                ? { backgroundColor: '#FF8303', color: 'white' }
                : { backgroundColor: 'white', color: '#6b7280' }
            }
          >
            {s.key}: {s.label}
          </button>
        ))}
      </div>

      {/* Success toast */}
      {success && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          backgroundColor: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px',
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px',
          fontSize: '14px', color: '#166534', zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          <CheckCircle size={16} color="#16a34a" />
          Student created!
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="mb-4 px-4 py-3 rounded-lg text-sm"
          style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}
        >
          {error}
        </div>
      )}

      {/* ── Section A: Personal Info ── */}
      {activeSection === 'A' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="font-semibold text-gray-800 text-base">Personal Info</h2>

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
              Student will be prompted to set their own password on first login.
            </p>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Date of Birth" adminOnly>
              <DatePartInput value={form.date_of_birth} onChange={(v) => set('date_of_birth', v)} />
            </Field>
            <Field label="Phone / Mobile">
              <input className={inputClass} value={form.phone}
                onChange={(e) => set('phone', e.target.value)} />
            </Field>
          </div>

          <Field label="Timezone">
            <select className={selectClass} value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </Field>

          <Field label="Language Preference">
            <select className={selectClass} value={form.language_preference}
              onChange={(e) => set('language_preference', e.target.value)}>
              <option value="">— Select native language —</option>
              {LANGUAGE_OPTIONS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </Field>

          <Field label="Status">
            <select className={selectClass} value={form.status}
              onChange={(e) => set('status', e.target.value)}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Customer Number" adminOnly>
            <input className={inputClass} value={form.customer_number}
              onChange={(e) => set('customer_number', e.target.value)}
              placeholder="Optional admin reference" />
          </Field>

          {/* Private / B2B toggle */}
          <Field label="Customer Type">
            <div className="flex gap-0 border border-gray-200 rounded-lg overflow-hidden w-fit mt-1">
              {[
                { value: true, label: 'Private' },
                { value: false, label: 'B2B' },
              ].map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => {
                    set('is_private', opt.value)
                    if (opt.value) set('company_id', '')
                  }}
                  className="px-5 py-2 text-sm font-medium transition-colors"
                  style={
                    form.is_private === opt.value
                      ? { backgroundColor: '#FF8303', color: 'white' }
                      : { backgroundColor: 'white', color: '#6b7280' }
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          {/* Company dropdown — only shown for B2B */}
          {!form.is_private && (
            <Field label="Company">
              <select className={selectClass} value={form.company_id}
                onChange={(e) => set('company_id', e.target.value)}>
                <option value="">— Select company —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Academic Advisor">
            <select className={selectClass} value={form.academic_advisor_id}
              onChange={(e) => set('academic_advisor_id', e.target.value)}>
              <option value="">— Select advisor (defaults to admin) —</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>{t.full_name}</option>
              ))}
            </select>
          </Field>

          <Field label="Assigned Teacher(s)">
            <div className="flex flex-wrap gap-2 mt-1">
              {teachers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTeacher(t.id)}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border transition-colors"
                  style={
                    form.assigned_teacher_ids.includes(t.id)
                      ? { backgroundColor: '#FF8303', color: 'white', borderColor: '#FF8303' }
                      : { backgroundColor: 'white', color: '#6b7280', borderColor: '#e5e7eb' }
                  }
                >
                  {t.full_name}
                </button>
              ))}
            </div>
            {teachers.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">No active teachers found.</p>
            )}
          </Field>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => setActiveSection('B')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              Next: Learning Info →
            </button>
          </div>
        </div>
      )}

      {/* ── Section B: Learning Info ── */}
      {activeSection === 'B' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="font-semibold text-gray-800 text-base">Learning Info</h2>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Native Language">
              <select className={selectClass} value={form.native_language}
                onChange={(e) => set('native_language', e.target.value)}>
                <option value="">— Select —</option>
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
            <Field label="Learning Language">
              <select className={selectClass} value={form.learning_language}
                onChange={(e) => set('learning_language', e.target.value)}>
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Current Fluency Level (Admin Assessed)">
              <select className={selectClass} value={form.current_fluency_level}
                onChange={(e) => set('current_fluency_level', e.target.value)}>
                <option value="">— Select —</option>
                {FLUENCY_LEVELS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
            <Field label="Self-Assessed Level">
              <select className={selectClass} value={form.self_assessed_level}
                onChange={(e) => set('self_assessed_level', e.target.value)}>
                <option value="">— Select —</option>
                {FLUENCY_LEVELS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Learning Goals">
            <textarea rows={3} className={inputClass} value={form.learning_goals}
              onChange={(e) => set('learning_goals', e.target.value)}
              placeholder="e.g. Pass my IELTS exam, improve business communication..." />
          </Field>

          <Field label="Interests">
            <input className={inputClass} value={form.interests}
              onChange={(e) => set('interests', e.target.value)}
              placeholder="e.g. Business, Travel, Culture, Technology" />
          </Field>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setActiveSection('A')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back to Personal Info
            </button>
            <button
              onClick={() => setActiveSection('C')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              Next: Training Setup →
            </button>
          </div>
        </div>
      )}

      {/* ── Section C: Training Setup ── */}
      {activeSection === 'C' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="font-semibold text-gray-800 text-base">Training Setup</h2>

          <Field label="Training Package Name">
            <input className={inputClass} value={form.package_name}
              onChange={(e) => set('package_name', e.target.value)}
              placeholder="e.g. Standard 20hrs, Intensive B2" />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Total Hours">
              <input type="number" min="0.5" step="0.5" className={inputClass}
                value={form.total_hours}
                onChange={(e) => set('total_hours', e.target.value)} />
            </Field>
            <Field label="Training End Date">
              <DatePartInput value={form.end_date} onChange={(v) => set('end_date', v)} />
            </Field>
          </div>

          <Field label="Cancellation Policy" adminOnly>
            <div className="flex gap-0 border border-gray-200 rounded-lg overflow-hidden w-fit mt-1">
              {CANCELLATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set('cancellation_policy', opt.value)}
                  className="px-5 py-2 text-sm font-medium transition-colors"
                  style={
                    form.cancellation_policy === opt.value
                      ? { backgroundColor: '#FF8303', color: 'white' }
                      : { backgroundColor: 'white', color: '#6b7280' }
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              48hr policy is for B2B clients with a commercial agreement. Never shown to student or teacher.
            </p>
          </Field>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setActiveSection('B')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back to Learning Info
            </button>
            <button
              onClick={() => setActiveSection('D')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}
            >
              Next: Notes →
            </button>
          </div>
        </div>
      )}

      {/* ── Section D: Notes ── */}
      {activeSection === 'D' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="font-semibold text-gray-800 text-base">Notes</h2>

          <Field label="Teacher Notes">
            <textarea rows={4} className={inputClass} value={form.teacher_notes}
              onChange={(e) => set('teacher_notes', e.target.value)}
              placeholder="Context for the teacher: B2B client info, special requirements, background. Not visible to the student." />
            <p className="text-xs text-gray-400 mt-1">
              Visible to assigned teachers. Not visible to the student.
            </p>
          </Field>

          {/* Admin-only notes section */}
          <div
            className="rounded-lg p-4 space-y-4"
            style={{ backgroundColor: '#fffbeb' }}
          >
            <p className="text-sm font-semibold" style={{ color: '#92400e' }}>
              🔒 Admin Only — Not visible to teacher or student
            </p>
            <Field label="Admin Notes" adminOnly>
              <textarea rows={4} className={inputClass} value={form.admin_notes}
                onChange={(e) => set('admin_notes', e.target.value)}
                placeholder="Internal notes: billing agreements, HR observations, warnings..." />
            </Field>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setActiveSection('C')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back to Training Setup
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => router.push('/admin/students')}
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
                {saving ? 'Creating...' : 'Create Student'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
