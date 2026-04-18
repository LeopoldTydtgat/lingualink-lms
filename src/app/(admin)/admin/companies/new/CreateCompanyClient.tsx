'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle } from 'lucide-react'

const TYPE_OPTIONS = [
  { value: 'b2b', label: 'B2B' },
  { value: 'enterprise', label: 'Enterprise' },
  { value: 'partner', label: 'Partner' },
]

const CANCELLATION_OPTIONS = [
  { value: '24hr', label: '24 hours (default)' },
  { value: '48hr', label: '48 hours (B2B)' },
]

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'former', label: 'Former' },
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

const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
const selectClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 bg-white'

export default function CreateCompanyClient() {
  const router = useRouter()

  const [form, setForm] = useState({
    name: '',
    type: 'b2b',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    country: '',
    billing_email: '',
    cancellation_policy: '24hr',
    tags: '',
    notes: '',
    status: 'active',
  })

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit() {
    setError(null)
    if (!form.name.trim()) return setError('Company name is required.')

    setSaving(true)
    try {
      // Convert comma-separated tags string to array
      const tagsArray = form.tags
        ? form.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []

      const res = await fetch('/api/admin/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, tags: tagsArray }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create company.')

      setSuccess(true)
      setTimeout(() => { router.push(`/admin/companies/${data.id}`); router.refresh() }, 1500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => router.push('/admin/companies')}
          className="text-sm text-gray-500 hover:text-gray-700">
          ← Companies
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Add Company</h1>
      </div>

      {success && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          backgroundColor: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px',
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px',
          fontSize: '14px', color: '#166534', zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
          <CheckCircle size={16} color="#16a34a" />
          Company created!
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg text-sm"
          style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}>
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <h2 className="font-semibold text-gray-800 text-base">Company Details</h2>

        <Field label="Company Name">
          <input className={inputClass} value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Acme Corp" />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Company Type">
            <select className={selectClass} value={form.type}
              onChange={(e) => set('type', e.target.value)}>
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className={selectClass} value={form.status}
              onChange={(e) => set('status', e.target.value)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Contact Details</p>
          <div className="space-y-4">
            <Field label="Contact Person Name">
              <input className={inputClass} value={form.contact_name}
                onChange={(e) => set('contact_name', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Contact Email">
                <input type="email" className={inputClass} value={form.contact_email}
                  onChange={(e) => set('contact_email', e.target.value)} />
              </Field>
              <Field label="Contact Phone">
                <input className={inputClass} value={form.contact_phone}
                  onChange={(e) => set('contact_phone', e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Country">
                <input className={inputClass} value={form.country}
                  onChange={(e) => set('country', e.target.value)} />
              </Field>
              <Field label="Billing Email">
                <input type="email" className={inputClass} value={form.billing_email}
                  onChange={(e) => set('billing_email', e.target.value)} />
              </Field>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Settings</p>
          <div className="space-y-4">
            <Field label="Default Cancellation Policy" adminOnly>
              <div className="flex gap-0 border border-gray-200 rounded-lg overflow-hidden w-fit mt-1">
                {CANCELLATION_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button"
                    onClick={() => set('cancellation_policy', opt.value)}
                    className="px-5 py-2 text-sm font-medium transition-colors"
                    style={form.cancellation_policy === opt.value
                      ? { backgroundColor: '#FF8303', color: 'white' }
                      : { backgroundColor: 'white', color: '#6b7280' }}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Applied to all students in this company. Can be overridden per student.
                Never shown to students or teachers.
              </p>
            </Field>

            <Field label="Tags">
              <input className={inputClass} value={form.tags}
                onChange={(e) => set('tags', e.target.value)}
                placeholder="e.g. Vitro, Intensive, Priority Client (comma-separated)" />
            </Field>
          </div>
        </div>

        <div className="border-t border-gray-100 pt-4 rounded-xl p-4"
          style={{ backgroundColor: '#fffbeb' }}>
          <p className="text-sm font-semibold mb-3" style={{ color: '#92400e' }}>
            🔒 Admin Only — Not visible to teachers or students
          </p>
          <Field label="Company Notes" adminOnly>
            <textarea rows={4} className={inputClass} value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Commercial agreements, special terms, history..." />
          </Field>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={() => router.push('/admin/companies')}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving}
            className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: '#FF8303' }}>
            {saving ? 'Creating...' : 'Create Company'}
          </button>
        </div>
      </div>
    </div>
  )
}
