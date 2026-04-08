'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────

type StaffMember = { id: string; full_name: string }
type LinkedOption = { id: string; full_name: string }

type TaskFormProps = {
  mode: 'create' | 'edit'
  taskId?: string
  // Pre-fill when opening from teacher or student detail page
  prefillLinkedType?: 'teacher' | 'student'
  prefillLinkedId?: string
  prefillLinkedName?: string
}

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const REASON_OPTIONS = [
  { value: 'warning', label: 'Warning' },
  { value: 'training', label: 'Training Required' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'payment', label: 'Payment Issue' },
  { value: 'general', label: 'General' },
  { value: 'hr_note', label: 'HR Note' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function TaskForm({
  mode,
  taskId,
  prefillLinkedType,
  prefillLinkedId,
  prefillLinkedName,
}: TaskFormProps) {
  const router = useRouter()

  // Form state
  const [title, setTitle] = useState('')
  const [linkedType, setLinkedType] = useState<string>(prefillLinkedType ?? '')
  const [linkedId, setLinkedId] = useState<string>(prefillLinkedId ?? '')
  const [assignedTo, setAssignedTo] = useState<string>('')
  const [dueDate, setDueDate] = useState<string>('')
  const [priority, setPriority] = useState<string>('medium')
  const [followUpReason, setFollowUpReason] = useState<string>('')
  const [notes, setNotes] = useState<string>('')

  // Supporting data
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [teacherOptions, setTeacherOptions] = useState<LinkedOption[]>([])
  const [studentOptions, setStudentOptions] = useState<LinkedOption[]>([])

  // UI state
  const [loading, setLoading] = useState(mode === 'edit')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Load staff and linked entity options ──
  useEffect(() => {
    async function loadSupportingData() {
      try {
        // Staff members (admin/staff roles) for the "Assigned To" dropdown
        const staffRes = await fetch('/api/admin/staff')
        if (staffRes.ok) {
          const staffData = await staffRes.json()
          setStaffMembers(staffData.staff ?? [])
          // Set default assigned_to to current user (API returns current user as first if default)
          if (staffData.currentUserId && !assignedTo) {
            setAssignedTo(staffData.currentUserId)
          }
        }

        // Teachers for linked entity dropdown
        const teacherRes = await fetch('/api/admin/teachers?minimal=true')
        if (teacherRes.ok) {
          const tData = await teacherRes.json()
          setTeacherOptions(tData.teachers ?? [])
        }

        // Students for linked entity dropdown
        const studentRes = await fetch('/api/admin/students?minimal=true')
        if (studentRes.ok) {
          const sData = await studentRes.json()
          setStudentOptions(sData.students ?? [])
        }
      } catch {
        // Non-fatal — form still works, dropdowns may be empty
      }
    }
    loadSupportingData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load existing task for edit mode ──
  useEffect(() => {
    if (mode !== 'edit' || !taskId) return

    async function loadTask() {
      try {
        const res = await fetch(`/api/admin/tasks?id=${taskId}`)
        if (!res.ok) throw new Error('Failed to load task')
        const data = await res.json()
        // The list endpoint doesn't support fetch by id directly —
        // we load all and find the one we need. For a small dataset this is fine.
        // Alternatively add a GET /api/admin/tasks/[id] endpoint if the list grows large.
        const task = data.tasks?.[0]
        if (!task) throw new Error('Task not found')

        setTitle(task.title)
        setLinkedType(task.linked_entity_type ?? '')
        setLinkedId(task.linked_entity_id ?? '')
        setAssignedTo(task.assigned_to ?? '')
        setDueDate(task.due_date ?? '')
        setPriority(task.priority)
        setFollowUpReason(task.follow_up_reason)
        setNotes(task.notes ?? '')
      } catch (err: any) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    loadTask()
  }, [mode, taskId])

  // ── When linked type changes, reset the linked id ──
  function handleLinkedTypeChange(type: string) {
    setLinkedType(type)
    // Only reset if not coming from prefill
    if (!prefillLinkedId) setLinkedId('')
  }

  // ── Submit ──
  async function handleSubmit() {
    setError(null)

    if (!title.trim()) { setError('Please enter a task title.'); return }
    if (!priority) { setError('Please select a priority.'); return }
    if (!followUpReason) { setError('Please select a follow-up reason.'); return }

    setSaving(true)

    const payload = {
      title,
      linked_entity_type: linkedType || null,
      linked_entity_id: linkedId || null,
      assigned_to: assignedTo || undefined,
      due_date: dueDate || null,
      priority,
      follow_up_reason: followUpReason,
      notes,
    }

    try {
      let res: Response
      if (mode === 'create') {
        res = await fetch('/api/admin/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        res = await fetch(`/api/admin/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save task')

      router.push('/admin/tasks')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Which linked entity list to show ──
  const linkedOptions = linkedType === 'teacher' ? teacherOptions : linkedType === 'student' ? studentOptions : []

  if (loading) {
    return <div style={{ padding: '60px', textAlign: 'center', color: '#9ca3af', fontSize: '14px' }}>Loading…</div>
  }

  return (
    <div style={{ padding: '32px', maxWidth: '640px' }}>

      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '13px', padding: 0, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          ← Back to Tasks
        </button>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: 0 }}>
          {mode === 'create' ? 'New Task' : 'Edit Task'}
        </h1>
      </div>

      {error && (
        <div style={{ backgroundColor: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px', fontSize: '14px' }}>
          {error}
        </div>
      )}

      <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '28px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Title */}
        <div>
          <label style={labelStyle}>Title <span style={{ color: '#ef4444' }}>*</span></label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Follow up on missed report"
            style={inputStyle}
          />
        </div>

        {/* Priority + Reason row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <label style={labelStyle}>Priority <span style={{ color: '#ef4444' }}>*</span></label>
            <select value={priority} onChange={e => setPriority(e.target.value)} style={inputStyle}>
              <option value="">Select…</option>
              {PRIORITY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Follow-up Reason <span style={{ color: '#ef4444' }}>*</span></label>
            <select value={followUpReason} onChange={e => setFollowUpReason(e.target.value)} style={inputStyle}>
              <option value="">Select…</option>
              {REASON_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Assigned To */}
        <div>
          <label style={labelStyle}>Assigned To</label>
          <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} style={inputStyle}>
            <option value="">Defaults to Shannon</option>
            {staffMembers.map(s => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))}
          </select>
        </div>

        {/* Due Date */}
        <div>
          <label style={labelStyle}>Due Date</label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Linked To */}
        <div>
          <label style={labelStyle}>Linked To (optional)</label>
          {/* If pre-filled from a detail page, show read-only */}
          {prefillLinkedId && prefillLinkedName ? (
            <div style={{ ...inputStyle, backgroundColor: '#f9fafb', color: '#374151', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: '#9ca3af', marginRight: '8px', textTransform: 'capitalize' }}>
                {prefillLinkedType}:
              </span>
              {prefillLinkedName}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px' }}>
              <select
                value={linkedType}
                onChange={e => handleLinkedTypeChange(e.target.value)}
                style={inputStyle}
              >
                <option value="">None</option>
                <option value="teacher">Teacher</option>
                <option value="student">Student</option>
              </select>
              {linkedType ? (
                <select
                  value={linkedId}
                  onChange={e => setLinkedId(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Select {linkedType}…</option>
                  {linkedOptions.map(o => (
                    <option key={o.id} value={o.id}>{o.full_name}</option>
                  ))}
                </select>
              ) : (
                <div style={{ ...inputStyle, backgroundColor: '#f9fafb', color: '#9ca3af' }}>
                  Select a type first
                </div>
              )}
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <label style={labelStyle}>Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Add any relevant details, context, or instructions…"
            rows={4}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.5' }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', paddingTop: '8px' }}>
          <button
            onClick={handleSubmit}
            disabled={saving}
            style={{
              backgroundColor: '#FF8303',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              padding: '10px 24px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Create Task' : 'Save Changes'}
          </button>
          <button
            onClick={() => router.back()}
            disabled={saving}
            style={{
              backgroundColor: '#fff',
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: '8px',
              padding: '10px 24px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Shared input styles ───────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 600,
  color: '#374151',
  marginBottom: '6px',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  padding: '8px 12px',
  fontSize: '14px',
  color: '#111827',
  backgroundColor: '#fff',
  boxSizing: 'border-box',
}
