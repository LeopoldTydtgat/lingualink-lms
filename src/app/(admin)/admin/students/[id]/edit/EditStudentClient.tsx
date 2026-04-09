'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Company = { id: string; name: string }
type Teacher = { id: string; full_name: string }

type ActiveTrain = {
  id: string
  package_name: string | null
  total_hours: number | null
  end_date: string | null
  status: string | null
} | null

type Props = {
  student: Record<string, unknown>
  activeTrain: ActiveTrain
  assignedTeacherIds: string[]
  companies: Company[]
  teachers: Teacher[]
}

const TIMEZONES = [
  'Africa/Johannesburg', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Amsterdam', 'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw',
  'Europe/Prague', 'Europe/Budapest', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney',
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

export default function EditStudentClient({
  student,
  activeTrain,
  assignedTeacherIds,
  companies,
  teachers,
}: Props) {
  const router = useRouter()
  const id = student.id as string

  const [form, setForm] = useState({
    // Section A — Personal Info
    first_name: ((student.full_name as string) ?? '').split(' ')[0] ?? '',
    last_name: ((student.full_name as string) ?? '').split(' ').slice(1).join(' ') ?? '',
    date_of_birth: (student.date_of_birth as string) ?? '',
    phone: (student.phone as string) ?? '',
    timezone: (student.timezone as string) ?? 'Europe/Paris',
    language_preference: (student.language_preference as string) ?? '',
    status: (student.status as string) ?? 'current',
    customer_number: (student.customer_number as string) ?? '',
    is_private: (student.is_private as boolean) ?? true,
    company_id: (student.company_id as string) ?? '',
    academic_advisor_id: (student.academic_advisor_id as string) ?? '',
    assigned_teacher_ids: assignedTeacherIds,
    // Section B — Learning Info
    native_language: (student.native_language as string) ?? '',
    learning_language: (student.learning_language as string) ?? 'English',
    current_fluency_level: (student.current_fluency_level as string) ?? '',
    self_assessed_level: (student.self_assessed_level as string) ?? '',
    learning_goals: (student.learning_goals as string) ?? '',
    interests: (student.interests as string) ?? '',
    // Section C — Training Setup
    package_name: activeTrain?.package_name ?? '',
    total_hours: activeTrain?.total_hours != null ? String(activeTrain.total_hours) : '',
    end_date: activeTrain?.end_date ?? '',
    cancellation_policy: (student.cancellation_policy as string) ?? '24hr',
    // Section D — Notes
    admin_notes: (student.admin_notes as string) ?? '',
    teacher_notes: (student.teacher_notes as string) ?? '',
  })

  const [activeSection, setActiveSection] = useState<Section>('A')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: string, value: string | boolean | string[]) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function toggleTeacher(tid: string) {
    setForm((prev) => {
      const ids = prev.assigned_teacher_ids
      return {
        ...prev,
        assigned_teacher_ids: ids.includes(tid)
          ? ids.filter((i) => i !== tid)
          : [...ids, tid],
      }
    })
  }

  async function handleSave() {
    setError(null)
    if (!form.first_name.trim()) return setError('First name is required.')
    if (!form.last_name.trim()) return setError('Last name is required.')
    if (form.assigned_teacher_ids.length === 0) return setError('At least one teacher must be assigned.')
    if (!form.package_name.trim()) return setError('Training package name is required.')
    if (!form.total_hours) return setError('Total hours is required.')
    if (!form.end_date) return setError('Training end date is required.')

    setSaving(true)
    try {
      const res = await fetch(`/api/admin/students/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: `${form.first_name.trim()} ${form.last_name.trim()}`,
          date_of_birth: form.date_of_birth || null,
          phone: form.phone || null,
          timezone: form.timezone,
          language_preference: form.language_preference || null,
          status: form.status,
          customer_number: form.customer_number || null,
          is_private: form.is_private,
          company_id: form.company_id || null,
          academic_advisor_id: form.academic_advisor_id || null,
          assigned_teacher_ids: form.assigned_teacher_ids,
          native_language: form.native_language || null,
          learning_language: form.learning_language || null,
          current_fluency_level: form.current_fluency_level || null,
          self_assessed_level: form.self_assessed_level || null,
          learning_goals: form.learning_goals || null,
          interests: form.interests || null,
          package_name: form.package_name,
          total_hours: parseFloat(form.total_hours),
          end_date: form.end_date,
          cancellation_policy: form.cancellation_policy,
          admin_notes: form.admin_notes || null,
          teacher_notes: form.teacher_notes || null,
          training_id: activeTrain?.id ?? null,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save changes.')

      router.push(`/admin/students/${id}`)
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
          onClick={() => router.push(`/admin/students/${id}`)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← {student.full_name as string}
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Edit Student</h1>
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

          {/* Email is read-only — assigned by admin, cannot be changed here */}
          <Field label="Email Address">
            <input
              className={inputClass}
              value={student.email as string}
              disabled
              style={{ backgroundColor: '#f9fafb', color: '#9ca3af' }}
            />
            <p className="text-xs text-gray-400 mt-1">
              Email cannot be changed here. Contact support to update login email.
            </p>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Date of Birth" adminOnly>
              <input type="date" className={inputClass} value={form.date_of_birth}
                onChange={(e) => set('date_of_birth', e.target.value)} />
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
              <option value="">— Select advisor —</option>
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
            <button onClick={() => setActiveSection('A')}
              className="text-sm text-gray-500 hover:text-gray-700">
              ← Back to Personal Info
            </button>
            <button onClick={() => setActiveSection('C')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}>
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
              <input type="date" className={inputClass} value={form.end_date}
                onChange={(e) => set('end_date', e.target.value)} />
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
            <button onClick={() => setActiveSection('B')}
              className="text-sm text-gray-500 hover:text-gray-700">
              ← Back to Learning Info
            </button>
            <button onClick={() => setActiveSection('D')}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: '#FF8303' }}>
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

          {/* Admin-only notes */}
          <div className="rounded-lg p-4 space-y-4" style={{ backgroundColor: '#fffbeb' }}>
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
            <button onClick={() => setActiveSection('C')}
              className="text-sm text-gray-500 hover:text-gray-700">
              ← Back to Training Setup
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => router.push(`/admin/students/${id}`)}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#FF8303' }}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
