'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useFilterPersistence } from '@/lib/hooks/useFilterPersistence'

// ─── Types ────────────────────────────────────────────────────────────────────

type Task = {
  id: string
  title: string
  linked_entity_type: 'teacher' | 'student' | null
  linked_entity_id: string | null
  linked_entity_name: string | null
  assigned_to: string
  assigned_to_name: string | null
  due_date: string | null
  priority: 'low' | 'medium' | 'high'
  follow_up_reason: string
  notes: string | null
  status: 'open' | 'completed'
  completed_at: string | null
  created_at: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const REASON_LABEL: Record<string, string> = {
  warning: 'Warning',
  training: 'Training Required',
  onboarding: 'Onboarding',
  payment: 'Payment Issue',
  general: 'General',
  hr_note: 'HR Note',
}

function priorityStyle(priority: string) {
  if (priority === 'high') return { backgroundColor: '#FFEEE6', color: '#FD5602' }
  if (priority === 'medium') return { backgroundColor: '#FFF8E8', color: '#B45309' }
  return { backgroundColor: '#f3f4f6', color: '#374151' }
}

// The two dates on a task are NOT the same kind of value, so one shared formatter could
// never have been right for both — they are split here.
//
// due_date is a DATE-only column (baseline schema `due_date date`), and its only producer is
// the <input type="date"> in TaskForm, which posts a bare 'YYYY-MM-DD'. It is a calendar day,
// not an instant, so it is formatted in UTC and deliberately NOT in the admin's zone:
// PostgREST returns 'YYYY-MM-DD', which Date parses as UTC midnight, so re-projecting it
// through a viewer zone would move the label off the day that was actually picked (the
// previous day anywhere west of UTC) and would disagree with the date the edit form shows for
// the same task.
function formatDueDate(dateStr: string | null) {
  if (!dateStr) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(dateStr))
}

// completed_at is a timestamptz INSTANT — the PATCH ?action=complete route stamps it with
// new Date().toISOString() — so it is projected through the viewing admin's zone. Without an
// explicit timeZone this followed whatever zone the browser happened to be in, which showed
// the wrong calendar day either side of midnight for any admin not sitting on UTC.
function formatCompletedAt(dateStr: string | null, timezone: string) {
  if (!dateStr) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(dateStr))
}

// due_date is the same calendar day formatDueDate renders, not an instant, so "overdue" is a
// calendar-day comparison and "today" has to be resolved in the admin's own zone rather than in
// whatever zone the browser happens to sit in. The previous version compared two values that
// were never the same kind: new Date('YYYY-MM-DD') is UTC midnight, while setHours(0, 0, 0, 0)
// is browser-local midnight. Anywhere west of UTC local midnight is the later instant, so a task
// due TODAY compared as earlier than "today" and was badged Overdue a full day early.
// en-CA renders that day as 'YYYY-MM-DD', a zero-padded fixed-width form whose lexical order is
// its chronological order, so a plain string compare is a correct date compare and never builds
// a Date at all. slice(0, 10) is defensive normalisation in case the column ever arrives with a
// time component appended.
function isOverdue(task: Task, timezone: string) {
  if (!task.due_date || task.status === 'completed') return false
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  return task.due_date.slice(0, 10) < todayStr
}

// Filter selects — reference select styling, sized to content rather than full width.
const filterSelectClass = "border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-[13px] text-gray-700 bg-white transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"

// ─── Filter persistence ──────────────────────────────────────────────────────

const FILTERS_STORAGE_KEY = 'll-admin-tasks-filters'

type StoredFilters = {
  status: string
  priority: string
  linkedType: string
}

// 'open' IS this page's default state, deliberately not ''. The hook compares
// against this record to decide when to remove the storage key, so the comparison
// baseline must be the page's real defaults — an all-blank baseline would treat
// the default view as "a filter worth remembering" and write storage on every visit.
const DEFAULT_STORED_FILTERS: StoredFilters = { status: 'open', priority: '', linkedType: '' }

// ─── Component ────────────────────────────────────────────────────────────────

export default function TasksPageClient({ adminTz }: { adminTz: string }) {
  const router = useRouter()

  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState<string>('open')
  const [filterPriority, setFilterPriority] = useState<string>('')
  const [filterLinkedType, setFilterLinkedType] = useState<string>('')

  const persistedFilters: StoredFilters = {
    status: filterStatus,
    priority: filterPriority,
    linkedType: filterLinkedType,
  }

  function parseStoredFilters(raw: unknown): StoredFilters | null {
    if (typeof raw !== 'object' || raw === null) return null
    const { status, priority, linkedType } = raw as Record<string, unknown>
    if (status !== '' && status !== 'open' && status !== 'completed') return null
    if (priority !== '' && priority !== 'high' && priority !== 'medium' && priority !== 'low') return null
    if (linkedType !== '' && linkedType !== 'teacher' && linkedType !== 'student') return null
    return { status, priority, linkedType } as StoredFilters
  }

  function applyStoredFilters(stored: StoredFilters) {
    setFilterStatus(stored.status)
    setFilterPriority(stored.priority)
    setFilterLinkedType(stored.linkedType)
  }

  useFilterPersistence<StoredFilters>({
    storageKey: FILTERS_STORAGE_KEY,
    value: persistedFilters,
    defaultValue: DEFAULT_STORED_FILTERS,
    // false because this page reads no URL params today — the dashboard's ?filter=
    // deep links are silently ignored (existing TODO). If that deep-link wiring
    // ever lands, this must flip to "URL params present", or a stored filter would
    // quietly override the deep link.
    skipRestore: false,
    parse: parseStoredFilters,
    apply: applyStoredFilters,
  })

  // Action feedback
  const [completing, setCompleting] = useState<string | null>(null)
  const [reopening, setReopening] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  // Monotonic request token. fetchTasks runs both from the filter effect and as a
  // post-mutation refetch, so a filter change can land while an older request is
  // still in flight — without this, the older response overwrites the newer
  // filter's rows (or clears its spinner).
  const tasksRequestIdRef = useRef(0)

  const fetchTasks = useCallback(async () => {
    const requestId = ++tasksRequestIdRef.current
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (filterStatus) params.set('status', filterStatus)
    if (filterPriority) params.set('priority', filterPriority)
    if (filterLinkedType) params.set('linkedType', filterLinkedType)

    try {
      const res = await fetch(`/api/admin/tasks?${params.toString()}`)
      if (requestId !== tasksRequestIdRef.current) return
      // Body parse is a second await — re-check before the throw or any write.
      const data = await res.json()
      if (requestId !== tasksRequestIdRef.current) return
      if (!res.ok) throw new Error(data.error || 'Failed to load tasks')
      setTasks(data.tasks)
    } catch (err: any) {
      if (requestId !== tasksRequestIdRef.current) return
      setError(err.message)
    } finally {
      // Only the newest request may turn the spinner off.
      if (requestId === tasksRequestIdRef.current) setLoading(false)
    }
  }, [filterStatus, filterPriority, filterLinkedType])

  useEffect(() => { fetchTasks() }, [fetchTasks])

  async function handleComplete(taskId: string) {
    setCompleting(taskId)
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      })
      if (!res.ok) throw new Error('Failed to complete task')
      await fetchTasks()
    } catch (err: any) {
      toast.error(err.message || 'Failed to complete task', { duration: 6000 })
    } finally {
      setCompleting(null)
    }
  }

  async function handleReopen(taskId: string) {
    setReopening(taskId)
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' }),
      })
      if (!res.ok) throw new Error('Failed to reopen task')
      await fetchTasks()
    } catch (err: any) {
      toast.error(err.message || 'Failed to reopen task', { duration: 6000 })
    } finally {
      setReopening(null)
    }
  }

  async function handleDelete(taskId: string, title: string) {
    if (!confirm(`Delete task "${title}"? This cannot be undone.`)) return
    setDeleting(taskId)
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete task')
      await fetchTasks()
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete task', { duration: 6000 })
    } finally {
      setDeleting(null)
    }
  }

  function navigateToLinked(task: Task) {
    if (!task.linked_entity_id || !task.linked_entity_type) return
    if (task.linked_entity_type === 'teacher') {
      router.push(`/admin/teachers/${task.linked_entity_id}`)
    } else {
      router.push(`/admin/students/${task.linked_entity_id}`)
    }
  }

  const openCount = tasks.filter(t => t.status === 'open').length
  const overdueCount = tasks.filter(t => isOverdue(t, adminTz)).length

  return (
    <div className="p-6">

      {/* ── Page header ── */}
      <div
        className="w-full flex items-center justify-between pb-4 mb-6 border-b"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tasks</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Internal follow-ups and action items
          </p>
        </div>
        <button
          onClick={() => router.push('/admin/tasks/new')}
          className="btn-primary-hover px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: '#FF8303' }}
        >
          + New Task
        </button>
      </div>

      {/* ── Summary pills ── */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="card-elevated px-5 py-3 min-w-[120px]">
          <div className="text-[22px] font-bold text-gray-900">{openCount}</div>
          <div className="text-xs text-gray-500 mt-0.5">Open tasks</div>
        </div>
        {overdueCount > 0 && (
          <div
            className="rounded-lg border px-5 py-3 min-w-[120px]"
            style={{ backgroundColor: '#fee2e2', borderColor: '#fca5a5' }}
          >
            <div className="text-[22px] font-bold" style={{ color: '#991b1b' }}>{overdueCount}</div>
            <div className="text-xs mt-0.5" style={{ color: '#991b1b' }}>Overdue</div>
          </div>
        )}
      </div>

      {/* ── Filters ── */}
      <div className="card-elevated px-5 py-4 mb-5 flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-semibold text-gray-700">Filter:</span>

        {/* Status */}
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className={filterSelectClass}
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="completed">Completed</option>
        </select>

        {/* Priority */}
        <select
          value={filterPriority}
          onChange={e => setFilterPriority(e.target.value)}
          className={filterSelectClass}
        >
          <option value="">All Priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        {/* Linked type */}
        <select
          value={filterLinkedType}
          onChange={e => setFilterLinkedType(e.target.value)}
          className={filterSelectClass}
        >
          <option value="">All Linked Entities</option>
          <option value="teacher">Linked to Teacher</option>
          <option value="student">Linked to Student</option>
        </select>

        {(filterStatus !== 'open' || filterPriority || filterLinkedType) && (
          <button
            onClick={() => { setFilterStatus('open'); setFilterPriority(''); setFilterLinkedType('') }}
            className="text-[13px] font-semibold bg-transparent border-none cursor-pointer"
            style={{ color: '#FF8303' }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Content ── */}
      {error && (
        <div
          className="rounded-lg px-4 py-3 mb-4 text-sm"
          style={{ backgroundColor: '#fee2e2', color: '#991b1b' }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-gray-400">Loading tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-16 text-sm text-gray-400">
          No tasks found.{' '}
          <span
            className="cursor-pointer font-semibold"
            style={{ color: '#FF8303' }}
            onClick={() => router.push('/admin/tasks/new')}
          >
            Create one
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {tasks.map(task => {
            const overdue = isOverdue(task, adminTz)
            return (
              <div
                key={task.id}
                className="card-elevated px-5 py-4"
                style={{
                  // Overdue rows get a red outline; every row keeps its priority/status
                  // accent on the left edge. Both are state-dependent, so they stay inline.
                  borderColor: overdue ? '#fca5a5' : '#E0DFDC',
                  borderLeft: `4px solid ${task.status === 'completed' ? '#d1d5db' : overdue ? '#ef4444' : task.priority === 'high' ? '#ef4444' : task.priority === 'medium' ? '#f59e0b' : '#6b7280'}`,
                  opacity: task.status === 'completed' ? 0.65 : 1,
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">

                  {/* Left: task info */}
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
                      <span
                        className="text-[15px] font-semibold"
                        style={{
                          color: task.status === 'completed' ? '#9ca3af' : '#111827',
                          textDecoration: task.status === 'completed' ? 'line-through' : 'none',
                        }}
                      >
                        {task.title}
                      </span>
                      <span style={{ ...priorityStyle(task.priority), fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                        {PRIORITY_LABEL[task.priority]}
                      </span>
                      {task.status === 'completed' && (
                        <span style={{ backgroundColor: '#DCFCE7', color: '#15803D', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                          Completed
                        </span>
                      )}
                      {overdue && (
                        <span style={{ backgroundColor: '#FFEEE6', color: '#FD5602', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                          Overdue
                        </span>
                      )}
                    </div>

                    {/* Meta row */}
                    <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                      <span>
                        <span className="font-medium">Reason:</span> {REASON_LABEL[task.follow_up_reason] ?? task.follow_up_reason}
                      </span>
                      {task.assigned_to_name && (
                        <span>
                          <span className="font-medium">Assigned to:</span> {task.assigned_to_name}
                        </span>
                      )}
                      {task.due_date && (
                        <span style={{ color: overdue ? '#ef4444' : '#6b7280' }}>
                          <span className="font-medium">Due:</span> {formatDueDate(task.due_date)}
                        </span>
                      )}
                      {task.linked_entity_name && task.linked_entity_type && (
                        <span>
                          <span className="font-medium">Linked:</span>{' '}
                          <span
                            onClick={() => navigateToLinked(task)}
                            className="hover:underline cursor-pointer font-medium"
                            style={{ color: '#FF8303', textUnderlineOffset: '2px' }}
                          >
                            {task.linked_entity_name}
                          </span>
                          <span className="ml-1 text-gray-400">
                            ({task.linked_entity_type === 'teacher' ? 'Teacher' : 'Student'})
                          </span>
                        </span>
                      )}
                      {task.completed_at && (
                        <span>
                          <span className="font-medium">Completed:</span> {formatCompletedAt(task.completed_at, adminTz)}
                        </span>
                      )}
                    </div>

                    {task.notes && (
                      <p className="text-[13px] text-gray-600 mt-2 mb-0 leading-relaxed">
                        {task.notes}
                      </p>
                    )}
                  </div>

                  {/* Right: actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {task.status === 'open' ? (
                      <button
                        onClick={() => handleComplete(task.id)}
                        disabled={completing === task.id}
                        className="rounded-lg border px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
                        style={{
                          backgroundColor: '#f0fdf4',
                          color: '#15803d',
                          borderColor: '#bbf7d0',
                          cursor: completing === task.id ? 'not-allowed' : 'pointer',
                          opacity: completing === task.id ? 0.6 : 1,
                        }}
                      >
                        {completing === task.id ? 'Completing…' : '✓ Complete'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleReopen(task.id)}
                        disabled={reopening === task.id}
                        className="rounded-lg border border-[#E0DFDC] px-3 py-1.5 text-xs font-semibold whitespace-nowrap hover:bg-gray-50"
                        style={{
                          backgroundColor: '#f9fafb',
                          color: '#374151',
                          cursor: reopening === task.id ? 'not-allowed' : 'pointer',
                          opacity: reopening === task.id ? 0.6 : 1,
                        }}
                      >
                        {reopening === task.id ? 'Reopening…' : 'Reopen'}
                      </button>
                    )}
                    <button
                      onClick={() => router.push(`/admin/tasks/${task.id}/edit`)}
                      className="rounded-lg border border-[#E0DFDC] bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 cursor-pointer hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(task.id, task.title)}
                      disabled={deleting === task.id}
                      className="rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold"
                      style={{
                        color: '#dc2626',
                        borderColor: '#fca5a5',
                        cursor: deleting === task.id ? 'not-allowed' : 'pointer',
                        opacity: deleting === task.id ? 0.6 : 1,
                      }}
                    >
                      {deleting === task.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
