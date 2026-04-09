'use client'

// src/app/(admin)/admin/announcements/AnnouncementsClient.tsx
// Displays the full list of announcements with quick toggle, edit, and delete.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'

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
  created_at: string
}

const AUDIENCE_LABELS: Record<string, string> = {
  all_teachers: 'All Teachers',
  all_students: 'All Students',
  everyone: 'Everyone',
  specific_teacher: 'Specific Teacher',
  specific_student: 'Specific Student',
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1)
    .toString()
    .padStart(2, '0')}/${d.getFullYear()}`
}

export default function AnnouncementsClient({
  announcements: initial,
}: {
  announcements: Announcement[]
}) {
  const router = useRouter()
  const [announcements, setAnnouncements] = useState(initial)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // ── Quick activate / deactivate toggle ─────────────────────────────────────
  const handleToggle = async (id: string, current: boolean) => {
    setTogglingId(id)
    const { error } = await supabase
      .from('announcements')
      .update({ is_active: !current })
      .eq('id', id)

    if (!error) {
      setAnnouncements((prev) =>
        prev.map((a) => (a.id === id ? { ...a, is_active: !current } : a))
      )
    }
    setTogglingId(null)
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm('Delete this announcement? This cannot be undone.')) return
    setDeletingId(id)

    const { error } = await supabase
      .from('announcements')
      .delete()
      .eq('id', id)

    if (!error) {
      setAnnouncements((prev) => prev.filter((a) => a.id !== id))
    } else {
      alert('Failed to delete announcement.')
    }
    setDeletingId(null)
  }

  const active = announcements.filter((a) => a.is_active)
  const inactive = announcements.filter((a) => !a.is_active)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Announcements</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Banners displayed on Teacher and Student portals
          </p>
        </div>
        <Link
          href="/admin/announcements/new"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#FF8303' }}
        >
          <Plus size={16} />
          New Announcement
        </Link>
      </div>

      {announcements.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg font-medium">No announcements yet</p>
          <p className="text-sm mt-1">Create one to display a banner on the portals.</p>
        </div>
      )}

      {/* Active announcements */}
      {active.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Active ({active.length})
          </h2>
          <div className="space-y-3">
            {active.map((a) => (
              <AnnouncementRow
                key={a.id}
                announcement={a}
                onToggle={handleToggle}
                onDelete={handleDelete}
                isToggling={togglingId === a.id}
                isDeleting={deletingId === a.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Inactive announcements */}
      {inactive.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Inactive ({inactive.length})
          </h2>
          <div className="space-y-3">
            {inactive.map((a) => (
              <AnnouncementRow
                key={a.id}
                announcement={a}
                onToggle={handleToggle}
                onDelete={handleDelete}
                isToggling={togglingId === a.id}
                isDeleting={deletingId === a.id}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ── Individual row ────────────────────────────────────────────────────────────
function AnnouncementRow({
  announcement: a,
  onToggle,
  onDelete,
  isToggling,
  isDeleting,
}: {
  announcement: Announcement
  onToggle: (id: string, current: boolean) => void
  onDelete: (id: string) => void
  isToggling: boolean
  isDeleting: boolean
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-4">
        {/* Left: content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold text-sm text-gray-900 truncate">
              {a.title || '(No title)'}
            </span>

            {/* Active badge */}
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={
                a.is_active
                  ? { backgroundColor: '#dcfce7', color: '#166534' }
                  : { backgroundColor: '#f3f4f6', color: '#6b7280' }
              }
            >
              {a.is_active ? 'Active' : 'Inactive'}
            </span>

            {/* Dismissable badge */}
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
              {a.is_dismissable ? 'Dismissable' : 'Permanent'}
            </span>

            {/* Audience badge */}
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ backgroundColor: '#fff7ed', color: '#c2410c' }}
            >
              {AUDIENCE_LABELS[a.target_audience] ?? a.target_audience}
            </span>
          </div>

          <p className="text-sm text-gray-600 line-clamp-2">{a.message}</p>

          <p className="text-xs text-gray-400 mt-1.5">
            {a.start_date || a.end_date ? (
              <>
                {a.start_date ? `From ${formatDate(a.start_date)}` : 'No start date'}
                {' — '}
                {a.end_date ? `Until ${formatDate(a.end_date)}` : 'No end date'}
              </>
            ) : (
              'No date restrictions'
            )}
          </p>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Toggle button */}
          <button
            onClick={() => onToggle(a.id, a.is_active)}
            disabled={isToggling}
            title={a.is_active ? 'Deactivate' : 'Activate'}
            className="p-1.5 rounded hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            {a.is_active ? (
              <ToggleRight size={20} style={{ color: '#FF8303' }} />
            ) : (
              <ToggleLeft size={20} className="text-gray-400" />
            )}
          </button>

          {/* Edit */}
          <Link
            href={`/admin/announcements/${a.id}/edit`}
            className="p-1.5 rounded hover:bg-gray-100 transition-colors"
            title="Edit"
          >
            <Pencil size={16} className="text-gray-500" />
          </Link>

          {/* Delete */}
          <button
            onClick={() => onDelete(a.id)}
            disabled={isDeleting}
            title="Delete"
            className="p-1.5 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            <Trash2 size={16} className="text-red-400" />
          </button>
        </div>
      </div>
    </div>
  )
}
