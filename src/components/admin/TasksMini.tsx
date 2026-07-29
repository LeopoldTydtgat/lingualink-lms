'use client'

// ─────────────────────────────────────────────────────────────────────────────
// TasksMini — a compact task panel for embedding in teacher/student detail pages
//
// Usage on Teacher Detail:
//   <TasksMini linkedType="teacher" linkedId={teacher.id} linkedName={teacher.full_name} adminTz={adminTz} />
//
// Usage on Student Detail:
//   <TasksMini linkedType="student" linkedId={student.id} linkedName={student.full_name} adminTz={adminTz} />
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'

type Task = {
  id: string
  title: string
  priority: 'low' | 'medium' | 'high'
  follow_up_reason: string
  due_date: string | null
  status: 'open' | 'completed'
  assigned_to_name: string | null
  notes: string | null
}

const REASON_LABEL: Record<string, string> = {
  warning: 'Warning',
  training: 'Training Required',
  onboarding: 'Onboarding',
  payment: 'Payment Issue',
  general: 'General',
  hr_note: 'HR Note',
}

function priorityDot(priority: string) {
  const colours: Record<string, string> = {
    high: '#ef4444',
    medium: '#f59e0b',
    low: '#9ca3af',
  }
  return (
    <span style={{
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: colours[priority] ?? '#9ca3af',
      marginRight: '6px',
      flexShrink: 0,
    }} />
  )
}

// due_date is a DATE-only column (baseline schema `due_date date`) whose only producer is the
// <input type="date"> in TaskForm, which posts a bare 'YYYY-MM-DD'. It is a calendar day, not an
// instant, so it is pinned to UTC and deliberately NOT projected through the admin's zone:
// PostgREST returns 'YYYY-MM-DD', which Date parses as UTC midnight, so a viewer-zone projection
// would move the label off the day that was actually picked (the previous day anywhere west of
// UTC) and would disagree with the date the edit form shows for the same task. Null returns null
// rather than a dash placeholder because the caller only renders this when due_date is set.
function formatDueDate(dateStr: string | null) {
  if (!dateStr) return null
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
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

export default function TasksMini({
  linkedType,
  linkedId,
  linkedName,
  adminTz,
}: {
  linkedType: 'teacher' | 'student'
  linkedId: string
  linkedName: string
  adminTz: string
}) {
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [completing, setCompleting] = useState<string | null>(null)
  const [completeError, setCompleteError] = useState<string | null>(null)

  // Monotonic request token. fetchTasks runs both from the mount/deps effect and as the
  // refetch after a successful complete, so a newer request can start while an older one is
  // still in flight. Without this the older response can land last and overwrite the newer
  // one's rows, or raise the error banner on a result nobody is waiting for any more.
  const tasksRequestIdRef = useRef(0)

  const fetchTasks = useCallback(async () => {
    const requestId = ++tasksRequestIdRef.current
    setLoadError(false)
    try {
      const res = await fetch(`/api/admin/tasks?linkedType=${linkedType}&linkedId=${linkedId}&status=open`)
      if (requestId !== tasksRequestIdRef.current) return
      if (!res.ok) throw new Error('Failed to load tasks')
      // Body parse is a second await - re-check before any write.
      const data = await res.json()
      if (requestId !== tasksRequestIdRef.current) return
      setTasks(data.tasks ?? [])
    } catch {
      if (requestId !== tasksRequestIdRef.current) return
      setTasks([])
      setLoadError(true)
    } finally {
      // Only the newest request may turn the spinner off.
      if (requestId === tasksRequestIdRef.current) setLoading(false)
    }
  }, [linkedType, linkedId])

  useEffect(() => { fetchTasks() }, [fetchTasks])

  async function handleComplete(taskId: string) {
    setCompleting(taskId)
    setCompleteError(null)
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      })
      if (res.ok) {
        await fetchTasks()
      } else {
        setCompleteError('Could not mark the task complete. Please try again.')
      }
    } catch {
      setCompleteError('Could not reach the server, so the task was not completed. Check your connection and try again.')
    } finally {
      setCompleting(null)
    }
  }

  function handleNewTask() {
    const params = new URLSearchParams({
      linkedType,
      linkedId,
      linkedName,
    })
    router.push(`/admin/tasks/new?${params.toString()}`)
  }

  return (
    <div>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#111827', margin: 0 }}>
            Open Tasks
          </h3>
          {tasks.length > 0 && (
            <span style={{
              backgroundColor: '#FF8303',
              color: '#fff',
              fontSize: '11px',
              fontWeight: 700,
              padding: '1px 7px',
              borderRadius: '20px',
            }}>
              {tasks.length}
            </span>
          )}
        </div>
        <button
          onClick={handleNewTask}
          style={{
            backgroundColor: 'transparent',
            color: '#FF8303',
            border: '1px solid #FF8303',
            borderRadius: '6px',
            padding: '5px 12px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + Add Task
        </button>
      </div>

      {completeError && (
        <div style={{
          fontSize: '12px',
          color: '#FD5602',
          backgroundColor: '#FFEEE6',
          borderLeft: '3px solid #FD5602',
          borderRadius: '6px',
          padding: '8px 10px',
          marginBottom: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}>
          <span>{completeError}</span>
          <button
            onClick={() => setCompleteError(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#FD5602', fontSize: '13px', lineHeight: 1, flexShrink: 0 }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: '13px', color: '#9ca3af', padding: '12px 0' }}>Loading…</div>
      ) : loadError ? (
        <div style={{
          fontSize: '13px',
          color: '#FD5602',
          padding: '16px',
          backgroundColor: '#FFEEE6',
          borderLeft: '3px solid #FD5602',
          borderRadius: '8px',
          textAlign: 'center',
        }}>
          Couldn&apos;t load tasks. This is not &quot;no tasks&quot; — try refreshing.
        </div>
      ) : tasks.length === 0 ? (
        <div style={{
          fontSize: '13px',
          color: '#9ca3af',
          padding: '16px',
          backgroundColor: '#f9fafb',
          borderRadius: '8px',
          textAlign: 'center',
          border: '1px dashed #e5e7eb',
        }}>
          No open tasks
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {tasks.map(task => {
            const overdue = isOverdue(task, adminTz)
            return (
              <div
                key={task.id}
                style={{
                  backgroundColor: '#fff',
                  border: `1px solid ${overdue ? '#fca5a5' : '#e5e7eb'}`,
                  borderLeft: `3px solid ${task.priority === 'high' ? '#ef4444' : task.priority === 'medium' ? '#f59e0b' : '#d1d5db'}`,
                  borderRadius: '8px',
                  padding: '12px 14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                      {priorityDot(task.priority)}
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {task.title}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#6b7280', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                      <span>{REASON_LABEL[task.follow_up_reason] ?? task.follow_up_reason}</span>
                      {task.assigned_to_name && <span>→ {task.assigned_to_name}</span>}
                      {task.due_date && (
                        <span style={{ color: overdue ? '#ef4444' : '#6b7280' }}>
                          Due {formatDueDate(task.due_date)}{overdue ? ' — Overdue' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleComplete(task.id)}
                    disabled={completing === task.id}
                    style={{
                      backgroundColor: '#f0fdf4',
                      color: '#15803d',
                      border: '1px solid #bbf7d0',
                      borderRadius: '5px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: completing === task.id ? 'not-allowed' : 'pointer',
                      opacity: completing === task.id ? 0.6 : 1,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {completing === task.id ? 'Completing…' : '✓ Done'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Link to all tasks for this entity */}
      {tasks.length > 0 && (
        <button
          onClick={() => router.push(`/admin/tasks?linkedType=${linkedType}&linkedId=${linkedId}`)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#6b7280',
            fontSize: '12px',
            marginTop: '10px',
            padding: 0,
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
          }}
        >
          View all tasks for this {linkedType} →
        </button>
      )}
    </div>
  )
}
