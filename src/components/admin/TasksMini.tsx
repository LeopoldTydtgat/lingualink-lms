'use client'

// ─────────────────────────────────────────────────────────────────────────────
// TasksMini — a compact task panel for embedding in teacher/student detail pages
//
// Usage on Teacher Detail:
//   <TasksMini linkedType="teacher" linkedId={teacher.id} linkedName={teacher.full_name} />
//
// Usage on Student Detail:
//   <TasksMini linkedType="student" linkedId={student.id} linkedName={student.full_name} />
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
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

function formatDate(dateStr: string | null) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isOverdue(task: Task) {
  if (!task.due_date || task.status === 'completed') return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(task.due_date) < today
}

export default function TasksMini({
  linkedType,
  linkedId,
  linkedName,
}: {
  linkedType: 'teacher' | 'student'
  linkedId: string
  linkedName: string
}) {
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [completing, setCompleting] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/tasks?linkedType=${linkedType}&linkedId=${linkedId}&status=open`)
      const data = await res.json()
      if (res.ok) setTasks(data.tasks ?? [])
    } finally {
      setLoading(false)
    }
  }, [linkedType, linkedId])

  useEffect(() => { fetchTasks() }, [fetchTasks])

  async function handleComplete(taskId: string) {
    setCompleting(taskId)
    try {
      const res = await fetch(`/api/admin/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      })
      if (res.ok) await fetchTasks()
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

      {loading ? (
        <div style={{ fontSize: '13px', color: '#9ca3af', padding: '12px 0' }}>Loading…</div>
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
            const overdue = isOverdue(task)
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
                          Due {formatDate(task.due_date)}{overdue ? ' — Overdue' : ''}
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
                    {completing === task.id ? '…' : '✓ Done'}
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
