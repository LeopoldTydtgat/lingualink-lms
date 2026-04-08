'use client'

// src/app/(admin)/admin/announcements/AnnouncementForm.tsx
// Shared form for creating and editing announcements.
// In create mode: announcement prop is undefined.
// In edit mode: announcement prop contains existing data.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import { ArrowLeft, Save } from 'lucide-react'
import Link from 'next/link'

interface Announcement {
  id: string
  title: string
  message: string
  target_audience: string
  target_id: string | null
  is_dismissable: boolean
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

interface PersonOption {
  id: string
  full_name: string
}

interface Props {
  announcement?: Announcement
  teachers: PersonOption[]
  students: PersonOption[]
}

const AUDIENCE_OPTIONS = [
  { value: 'everyone', label: 'Everyone (Teachers + Students)' },
  { value: 'all_teachers', label: 'All Teachers' },
  { value: 'all_students', label: 'All Students' },
  { value: 'specific_teacher', label: 'Specific Teacher' },
  { value: 'specific_student', label: 'Specific Student' },
]

// Strip time from ISO date string for date input value
function toDateInputValue(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

export default function AnnouncementForm({ announcement, teachers, students }: Props) {
  const router = useRouter()
  const isEdit = !!announcement

  const [title, setTitle] = useState(announcement?.title ?? '')
  const [message, setMessage] = useState(announcement?.message ?? '')
  const [targetAudience, setTargetAudience] = useState(
    announcement?.target_audience ?? 'everyone'
  )
  const [targetId, setTargetId] = useState(announcement?.target_id ?? '')
  const [isDismissable, setIsDismissable] = useState(
    announcement?.is_dismissable ?? true
  )
  const [isActive, setIsActive] = useState(announcement?.is_active ?? false)
  const [startDate, setStartDate] = useState(toDateInputValue(announcement?.start_date ?? null))
  const [endDate, setEndDate] = useState(toDateInputValue(announcement?.end_date ?? null))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // Fetch current admin user ID on mount — needed for created_by field
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  const needsTargetId =
    targetAudience === 'specific_teacher' || targetAudience === 'specific_student'

  const handleSave = async () => {
    if (!message.trim()) {
      setError('Message is required.')
      return
    }
    if (needsTargetId && !targetId) {
      setError('Please select a specific person.')
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      title: title.trim() || null,
      message: message.trim(),
      target_audience: targetAudience,
      target_id: needsTargetId ? targetId : null,
      is_dismissable: isDismissable,
      is_active: isActive,
      // Store as midnight UTC for the chosen date
      start_date: startDate ? `${startDate}T00:00:00.000Z` : null,
      end_date: endDate ? `${endDate}T23:59:59.000Z` : null,
      created_by: currentUserId,
    }

    let dbError = null

    if (isEdit) {
      const { error } = await supabase
        .from('announcements')
        .update(payload)
        .eq('id', announcement.id)
      dbError = error
    } else {
      const { error } = await supabase
        .from('announcements')
        .insert(payload)
      dbError = error
    }

    if (dbError) {
      setError(dbError.message)
      setSaving(false)
      return
    }

    router.push('/admin/announcements')
    router.refresh()
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/admin/announcements"
          className="p-1.5 rounded hover:bg-gray-100 transition-colors"
        >
          <ArrowLeft size={18} className="text-gray-500" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">
          {isEdit ? 'Edit Announcement' : 'New Announcement'}
        </h1>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Title <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Platform maintenance scheduled"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
          />
        </div>

        {/* Message */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Message <span className="text-red-500">*</span>
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="The announcement text shown in the banner..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
          />
        </div>

        {/* Target audience */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Target Audience
          </label>
          <select
            value={targetAudience}
            onChange={(e) => {
              setTargetAudience(e.target.value)
              setTargetId('')
            }}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
          >
            {AUDIENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Specific teacher selector */}
        {targetAudience === 'specific_teacher' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Teacher <span className="text-red-500">*</span>
            </label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
            >
              <option value="">— Choose a teacher —</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Specific student selector */}
        {targetAudience === 'specific_student' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select Student <span className="text-red-500">*</span>
            </label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none bg-white"
            >
              <option value="">— Choose a student —</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date range */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Start Date <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              End Date <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
            />
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-3 pt-1">
          <ToggleField
            label="Dismissable"
            description="Users can close this banner. If off, it stays visible until you deactivate it."
            checked={isDismissable}
            onChange={setIsDismissable}
          />
          <ToggleField
            label="Active"
            description="Banner is currently showing on the portal(s). You can activate it later."
            checked={isActive}
            onChange={setIsActive}
          />
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {/* Save button */}
        <div className="pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ backgroundColor: '#FF8303' }}
          >
            <Save size={15} />
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Announcement'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Small toggle field helper ─────────────────────────────────────────────────
function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="relative flex-shrink-0 w-10 h-6 rounded-full transition-colors mt-0.5"
        style={{ backgroundColor: checked ? '#FF8303' : '#d1d5db' }}
      >
        <span
          className="absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform"
          style={{ transform: checked ? 'translateX(18px)' : 'translateX(4px)' }}
        />
      </button>
    </div>
  )
}
