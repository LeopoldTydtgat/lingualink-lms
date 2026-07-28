'use client'

// src/app/(admin)/admin/announcements/AnnouncementsClient.tsx
// Displays the full list of announcements with quick toggle, edit, and delete.
// Writes go through /api/admin/announcements/[id] (requireAdmin + Zod +
// service-role client) — this component never touches the table directly.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

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

// A failed response may carry no JSON body at all (proxy error, HTML 500,
// dropped connection), so the body is never assumed — fall back to a plain
// message rather than throwing inside the error path.
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null)
  return typeof body?.error === 'string' && body.error ? body.error : fallback
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
  // Persistent banner: a toast alone disappears, and a failed write must stay
  // visible next to a list that did NOT change.
  const [actionError, setActionError] = useState<string | null>(null)

  const reportFailure = (msg: string) => {
    setActionError(msg)
    toast.error(msg, { duration: 6000 })
  }

  // ── Quick activate / deactivate toggle ─────────────────────────────────────
  const handleToggle = async (id: string, current: boolean) => {
    setTogglingId(id)
    setActionError(null)

    try {
      const res = await fetch(`/api/admin/announcements/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !current }),
      })

      if (!res.ok) {
        reportFailure(
          await readErrorMessage(res, 'Failed to update announcement.')
        )
        return
      }

      // Only reflect the new state once the server confirms it — the switch
      // must never show a change that was not written.
      setAnnouncements((prev) =>
        prev.map((a) => (a.id === id ? { ...a, is_active: !current } : a))
      )
      router.refresh()
    } catch (err) {
      console.error('Announcement toggle failed:', err)
      reportFailure('Failed to update announcement — the server could not be reached.')
    } finally {
      setTogglingId(null)
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm('Delete this announcement? This cannot be undone.')) return
    setDeletingId(id)
    setActionError(null)

    try {
      const res = await fetch(`/api/admin/announcements/${id}`, {
        method: 'DELETE',
      })

      if (!res.ok) {
        reportFailure(
          await readErrorMessage(res, 'Failed to delete announcement.')
        )
        return
      }

      setAnnouncements((prev) => prev.filter((a) => a.id !== id))
      router.refresh()
    } catch (err) {
      console.error('Announcement delete failed:', err)
      reportFailure('Failed to delete announcement — the server could not be reached.')
    } finally {
      setDeletingId(null)
    }
  }

  const active = announcements.filter((a) => a.is_active)
  const inactive = announcements.filter((a) => !a.is_active)

  return (
    <div className="p-6">
      {/* Header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Banners displayed on Teacher and Student portals
          </p>
        </div>
        <Link
          href="/admin/announcements/new"
          prefetch={false}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#FF8303' }}
        >
          <Plus size={16} />
          New Announcement
        </Link>
      </div>

      {/* Failed write — stays until the next action */}
      {actionError && (
        <div
          role="alert"
          className="mb-6 rounded-lg px-4 py-3 text-sm"
          style={{ backgroundColor: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}
        >
          {actionError}
        </div>
      )}

      {announcements.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg font-medium">No announcements yet</p>
          <p className="text-sm mt-1">Create one to display a banner on the portals.</p>
        </div>
      )}

      {/* Active announcements */}
      {active.length > 0 && (
        <section className="mb-8">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
            <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#6b7280', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>ACTIVE ({active.length})</h2>
          </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
            <h2 style={{ fontSize: '13px', fontWeight: '600', color: '#6b7280', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>INACTIVE ({inactive.length})</h2>
          </div>
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
    <div className="card-elevated p-4">
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
                  ? { backgroundColor: '#DCFCE7', color: '#15803D' }
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
              style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}
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
            {isToggling ? (
              <Loader2 size={20} className="animate-spin text-gray-400" />
            ) : a.is_active ? (
              <ToggleRight size={20} style={{ color: '#FF8303' }} />
            ) : (
              <ToggleLeft size={20} className="text-gray-400" />
            )}
          </button>

          {/* Edit */}
          <Link
            href={`/admin/announcements/${a.id}/edit`}
            prefetch={false}
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
            {isDeleting ? (
              <Loader2 size={16} className="animate-spin text-red-400" />
            ) : (
              <Trash2 size={16} className="text-red-400" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
