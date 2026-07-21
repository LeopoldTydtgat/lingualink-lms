'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

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

// Bordered section card — matches the Teacher Detail Overview tab's card style.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card-elevated p-5 space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="block rounded-full" style={{ width: '3px', height: '18px', backgroundColor: '#FF8303' }} />
        <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
      </div>
      {children}
    </div>
  )
}

const inputClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm text-gray-800 transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"
const selectClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"

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

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit() {
    if (!form.name.trim()) { toast.error('Company name is required.'); return }

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

      toast.success('Company created!')
      setTimeout(() => { router.push(`/admin/companies/${data.id}`); router.refresh() }, 800)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong.', { duration: 6000 })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* Header */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <button onClick={() => router.push('/admin/companies')}
          className="text-sm text-gray-500 hover:text-gray-700">
          ← Companies
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">Add Company</h1>
      </div>

      {/* Single scrolling form — one card per section.
          pb-28 keeps the last field clear of the sticky action bar. */}
      <div className="max-w-6xl mx-auto space-y-6 pb-28">

        {/* 1. Company Details */}
        <Section title="Company Details">
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
        </Section>

        {/* 2. Contact Details */}
        <Section title="Contact Details">
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
        </Section>

        {/* 3. Settings */}
        <Section title="Settings">
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
        </Section>

        {/* 4. Company Notes — amber, admin-only */}
        <div className="rounded-xl border p-5 space-y-4"
          style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}>
          <h2 className="font-semibold" style={{ color: '#92400e' }}>
            🔒 Admin Only — Not visible to teachers or students
          </h2>
          <Field label="Company Notes" adminOnly>
            <textarea rows={4} className={inputClass} value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Commercial agreements, special terms, history..." />
          </Field>
        </div>
      </div>

      {/* Sticky action bar — sticks to the bottom of the scrolling main area */}
      <div className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}>
        <button
          onClick={() => router.push('/admin/companies')}
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
          {saving ? 'Creating...' : 'Create Company'}
        </button>
      </div>
    </div>
  )
}
