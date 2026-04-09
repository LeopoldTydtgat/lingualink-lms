'use client'

import { useState } from 'react'
import { Save, AlertCircle, CheckCircle2, Mail, Clock, FileText, CreditCard, AlertTriangle, Ban } from 'lucide-react'

// Shape of the settings object we receive from the API
interface SettingsValues {
  min_available_hours: string
  admin_email: string
  invoice_upload_start: string
  invoice_upload_end: string
  payment_timeline_days: string
  low_balance_threshold: string
  default_cancellation_window: string
}

interface Props {
  initialSettings: Partial<SettingsValues>
}

// Default values to use when a setting is not yet in the database
const DEFAULTS: SettingsValues = {
  min_available_hours: '10',
  admin_email: '',
  invoice_upload_start: '1',
  invoice_upload_end: '10',
  payment_timeline_days: '15',
  low_balance_threshold: '2',
  default_cancellation_window: '24',
}

export default function SettingsClient({ initialSettings }: Props) {
  // Merge database values over defaults so every field has a value
  const [values, setValues] = useState<SettingsValues>({
    ...DEFAULTS,
    ...initialSettings,
  })

  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  function handleChange(key: keyof SettingsValues, value: string) {
    setValues(prev => ({ ...prev, [key]: value }))
    // Clear any previous save status when the user starts editing
    if (saveStatus !== 'idle') setSaveStatus('idle')
  }

  async function handleSave() {
    setSaving(true)
    setSaveStatus('idle')
    setErrorMessage('')

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })

      const data = await res.json()

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to save settings')
        setSaveStatus('error')
      } else {
        setSaveStatus('success')
        // Auto-clear the success message after 3 seconds
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    } catch {
      setErrorMessage('Network error — please try again')
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8">

      {/* ── Section: Contact ─────────────────────────────────────────── */}
      <SettingSection
        icon={<Mail className="h-5 w-5" style={{ color: '#FF8303' }} />}
        title="Contact"
        description="The support email address displayed to teachers and students across the portal."
      >
        <SettingRow
          label="Admin support email"
          hint="Shown in portal footers and notification emails as the contact address."
        >
          <input
            type="email"
            value={values.admin_email}
            onChange={e => handleChange('admin_email', e.target.value)}
            placeholder="e.g. support@lingualinkonline.com"
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2"
            
          />
        </SettingRow>
      </SettingSection>

      {/* ── Section: Teacher Availability ────────────────────────────── */}
      <SettingSection
        icon={<Clock className="h-5 w-5" style={{ color: '#FF8303' }} />}
        title="Teacher Availability"
        description="Alert thresholds used when monitoring teacher schedules."
      >
        <SettingRow
          label="Minimum available hours per week"
          hint="If a teacher's weekly availability drops below this number, an alert appears on the admin dashboard."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={60}
              value={values.min_available_hours}
              onChange={e => handleChange('min_available_hours', e.target.value)}
              className="w-24 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2"
            />
            <span className="text-sm text-gray-500">hours / week</span>
          </div>
        </SettingRow>
      </SettingSection>

      {/* ── Section: Billing & Invoices ───────────────────────────────── */}
      <SettingSection
        icon={<FileText className="h-5 w-5" style={{ color: '#FF8303' }} />}
        title="Billing &amp; Invoices"
        description="Controls the invoice upload window and payment timeline shown to teachers."
      >
        <SettingRow
          label="Invoice upload window"
          hint="The days of the month during which teachers can upload their invoice. Outside this window, the upload option is hidden."
        >
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">From day</span>
              <input
                type="number"
                min={1}
                max={28}
                value={values.invoice_upload_start}
                onChange={e => handleChange('invoice_upload_start', e.target.value)}
                className="w-20 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">to day</span>
              <input
                type="number"
                min={1}
                max={28}
                value={values.invoice_upload_end}
                onChange={e => handleChange('invoice_upload_end', e.target.value)}
                className="w-20 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2"
              />
              <span className="text-sm text-gray-500">of each month</span>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label="Payment timeline"
          hint="How many days after receiving a teacher's invoice Shannon aims to process payment."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={90}
              value={values.payment_timeline_days}
              onChange={e => handleChange('payment_timeline_days', e.target.value)}
              className="w-24 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2"
            />
            <span className="text-sm text-gray-500">days after invoice receipt</span>
          </div>
        </SettingRow>
      </SettingSection>

      {/* ── Section: Student Hours ────────────────────────────────────── */}
      <SettingSection
        icon={<AlertTriangle className="h-5 w-5" style={{ color: '#FF8303' }} />}
        title="Student Hours"
        description="The threshold that triggers low-balance warnings for students."
      >
        <SettingRow
          label="Low balance warning threshold"
          hint="When a student's remaining hours drop to or below this number, a warning appears on their portal and the admin dashboard."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              value={values.low_balance_threshold}
              onChange={e => handleChange('low_balance_threshold', e.target.value)}
              className="w-24 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2"
            />
            <span className="text-sm text-gray-500">hours remaining</span>
          </div>
        </SettingRow>
      </SettingSection>

      {/* ── Section: Cancellation Policy ─────────────────────────────── */}
      <SettingSection
        icon={<Ban className="h-5 w-5" style={{ color: '#FF8303' }} />}
        title="Cancellation Policy"
        description="The default cancellation window applied to all new student accounts. Individual students can be overridden in Student Management."
      >
        <SettingRow
          label="Default cancellation window"
          hint="Students who cancel within this window lose their hours. This default applies to all private students. B2B students can be set to 48 hours individually."
        >
          <div className="flex gap-3">
            {['24', '48'].map(option => {
              const isSelected = values.default_cancellation_window === option
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => handleChange('default_cancellation_window', option)}
                  className="px-5 py-2 rounded-md text-sm font-medium border transition-colors"
                  style={
                    isSelected
                      ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: '#ffffff' }
                      : { backgroundColor: '#ffffff', borderColor: '#d1d5db', color: '#4b5563' }
                  }
                >
                  {option} hours
                </button>
              )
            })}
          </div>
        </SettingRow>
      </SettingSection>

      {/* ── Save button + inline feedback ────────────────────────────── */}
      <div className="flex items-center justify-end gap-4 pt-2">

        {/* Feedback shown right beside the button so it's always visible */}
        {saveStatus === 'success' && (
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#166534' }}>
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Saved successfully.
          </div>
        )}

        {saveStatus === 'error' && (
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#991b1b' }}>
            <AlertCircle className="h-4 w-4 shrink-0" />
            {errorMessage}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 rounded-md text-sm font-medium text-white transition-opacity disabled:opacity-60"
          style={{ backgroundColor: '#FF8303' }}
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>

    </div>
  )
}

// ── Reusable layout components ─────────────────────────────────────────────

function SettingSection({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* Section header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100" style={{ backgroundColor: '#fafafa' }}>
        {icon}
        <div>
          <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        </div>
      </div>
      {/* Settings rows */}
      <div className="divide-y divide-gray-100">
        {children}
      </div>
    </div>
  )
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="px-6 py-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-8">
      {/* Label + hint */}
      <div className="sm:w-72 shrink-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="text-xs text-gray-400 mt-1 leading-relaxed">{hint}</p>
      </div>
      {/* Input area */}
      <div className="flex-1">
        {children}
      </div>
    </div>
  )
}
