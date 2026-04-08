'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

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
  if (priority === 'high') return { backgroundColor: '#fee2e2', color: '#991b1b' }
  if (priority === 'medium') return { backgroundColor: '#fef3c7', color: '#92400e' }
  return { backgroundColor: '#f3f4f6', color: '#374151' }
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isOverdue(task: Task) {
  if (!task.due_date || task.status === 'completed') return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(task.due_date) < today
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminTasksPage() {
  const router = useRouter()

  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState<string>('open')
  const [filterPriority, setFilterPriority] = useState<string>('')
  const [filterLinkedType, setFilterLinkedType] = useState<string>('')

  // Action feedback
  const [completing, setCompleting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (filterStatus) params.set('status', filterStatus)
    if (filterPriority) params.set('priority', filterPriority)
    if (filterLinkedType) params.set('linkedType', filterLinkedType)

    try {
      const res = await fetch(`/api/admin/tasks?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load tasks')
      setTasks(data.tasks)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
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
      alert(err.message)
    } finally {
      setCompleting(null)
    }
  }

  async function handleReopen(taskId: string) {
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' }),
      })
      if (!res.ok) throw new Error('Failed to reopen task')
      await fetchTasks()
    } catch (err: any) {
      alert(err.message)
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
      alert(err.message)
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
  const overdueCount = tasks.filter(t => isOverdue(t)).length

  return (
    <div style={{ padding: '32px', maxWidth: '1200px' }}>

      {/* ── Page header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: 0 }}>Tasks</h1>
          <p style={{ fontSize: '14px', color: '#6b7280', marginTop: '4px' }}>
            Internal follow-ups and action items
          </p>
        </div>
        <button
          onClick={() => router.push('/admin/tasks/new')}
          style={{
            backgroundColor: '#FF8303',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            padding: '10px 20px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + New Task
        </button>
      </div>

      {/* ── Summary pills ── */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 20px', minWidth: '120px' }}>
          <div style={{ fontSize: '22px', fontWeight: 700, color: '#111827' }}>{openCount}</div>
          <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>Open tasks</div>
        </div>
        {overdueCount > 0 && (
          <div style={{ backgroundColor: '#fee2e2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 20px', minWidth: '120px' }}>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#991b1b' }}>{overdueCount}</div>
            <div style={{ fontSize: '12px', color: '#991b1b', marginTop: '2px' }}>Overdue</div>
          </div>
        )}
      </div>

      {/* ── Filters ── */}
      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '10px',
        padding: '16px 20px',
        marginBottom: '20px',
        display: 'flex',
        gap: '12px',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>Filter:</span>

        {/* Status */}
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          style={{ fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '6px', padding: '6px 10px', color: '#374151', backgroundColor: '#fff' }}
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="completed">Completed</option>
        </select>

        {/* Priority */}
        <select
          value={filterPriority}
          onChange={e => setFilterPriority(e.target.value)}
          style={{ fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '6px', padding: '6px 10px', color: '#374151', backgroundColor: '#fff' }}
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
          style={{ fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '6px', padding: '6px 10px', color: '#374151', backgroundColor: '#fff' }}
        >
          <option value="">All Linked Entities</option>
          <option value="teacher">Linked to Teacher</option>
          <option value="student">Linked to Student</option>
        </select>

        {(filterStatus !== 'open' || filterPriority || filterLinkedType) && (
          <button
            onClick={() => { setFilterStatus('open'); setFilterPriority(''); setFilterLinkedType('') }}
            style={{ fontSize: '13px', color: '#FF8303', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Content ── */}
      {error && (
        <div style={{ backgroundColor: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: '#9ca3af', fontSize: '14px' }}>Loading tasks…</div>
      ) : tasks.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: '#9ca3af', fontSize: '14px' }}>
          No tasks found.{' '}
          <span
            style={{ color: '#FF8303', cursor: 'pointer', fontWeight: 600 }}
            onClick={() => router.push('/admin/tasks/new')}
          >
            Create one
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {tasks.map(task => {
            const overdue = isOverdue(task)
            return (
              <div
                key={task.id}
                style={{
                  backgroundColor: '#fff',
                  border: `1px solid ${overdue ? '#fca5a5' : '#e5e7eb'}`,
                  borderLeft: `4px solid ${task.status === 'completed' ? '#d1d5db' : overdue ? '#ef4444' : task.priority === 'high' ? '#ef4444' : task.priority === 'medium' ? '#f59e0b' : '#6b7280'}`,
                  borderRadius: '10px',
                  padding: '16px 20px',
                  opacity: task.status === 'completed' ? 0.65 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>

                  {/* Left: task info */}
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
                      <span style={{ fontSize: '15px', fontWeight: 600, color: task.status === 'completed' ? '#9ca3af' : '#111827', textDecoration: task.status === 'completed' ? 'line-through' : 'none' }}>
                        {task.title}
                      </span>
                      <span style={{ ...priorityStyle(task.priority), fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                        {PRIORITY_LABEL[task.priority]}
                      </span>
                      {task.status === 'completed' && (
                        <span style={{ backgroundColor: '#d1fae5', color: '#065f46', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                          Completed
                        </span>
                      )}
                      {overdue && (
                        <span style={{ backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px' }}>
                          Overdue
                        </span>
                      )}
                    </div>

                    {/* Meta row */}
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: '#6b7280' }}>
                      <span>
                        <span style={{ fontWeight: 500 }}>Reason:</span> {REASON_LABEL[task.follow_up_reason] ?? task.follow_up_reason}
                      </span>
                      {task.assigned_to_name && (
                        <span>
                          <span style={{ fontWeight: 500 }}>Assigned to:</span> {task.assigned_to_name}
                        </span>
                      )}
                      {task.due_date && (
                        <span style={{ color: overdue ? '#ef4444' : '#6b7280' }}>
                          <span style={{ fontWeight: 500 }}>Due:</span> {formatDate(task.due_date)}
                        </span>
                      )}
                      {task.linked_entity_name && task.linked_entity_type && (
                        <span>
                          <span style={{ fontWeight: 500 }}>Linked:</span>{' '}
                          <span
                            onClick={() => navigateToLinked(task)}
                            style={{ color: '#FF8303', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px' }}
                          >
                            {task.linked_entity_name}
                          </span>
                          <span style={{ marginLeft: '4px', color: '#9ca3af' }}>
                            ({task.linked_entity_type === 'teacher' ? 'Teacher' : 'Student'})
                          </span>
                        </span>
                      )}
                      {task.completed_at && (
                        <span>
                          <span style={{ fontWeight: 500 }}>Completed:</span> {formatDate(task.completed_at)}
                        </span>
                      )}
                    </div>

                    {task.notes && (
                      <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '8px', margin: '8px 0 0 0', lineHeight: '1.5' }}>
                        {task.notes}
                      </p>
                    )}
                  </div>

                  {/* Right: actions */}
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                    {task.status === 'open' ? (
                      <button
                        onClick={() => handleComplete(task.id)}
                        disabled={completing === task.id}
                        style={{
                          backgroundColor: '#f0fdf4',
                          color: '#15803d',
                          border: '1px solid #bbf7d0',
                          borderRadius: '6px',
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: completing === task.id ? 'not-allowed' : 'pointer',
                          opacity: completing === task.id ? 0.6 : 1,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {completing === task.id ? '…' : '✓ Complete'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleReopen(task.id)}
                        style={{
                          backgroundColor: '#f9fafb',
                          color: '#374151',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Reopen
                      </button>
                    )}
                    <button
                      onClick={() => router.push(`/admin/tasks/${task.id}/edit`)}
                      style={{
                        backgroundColor: '#fff',
                        color: '#374151',
                        border: '1px solid #d1d5db',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(task.id, task.title)}
                      disabled={deleting === task.id}
                      style={{
                        backgroundColor: '#fff',
                        color: '#dc2626',
                        border: '1px solid #fca5a5',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: deleting === task.id ? 'not-allowed' : 'pointer',
                        opacity: deleting === task.id ? 0.6 : 1,
                      }}
                    >
                      Delete
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
