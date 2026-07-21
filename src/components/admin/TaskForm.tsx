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

// ─── Layout helpers ───────────────────────────────────────────────────────────

// Bordered section card — matches the Teacher/Student form pattern.
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

function Field({ label, required, children }: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: '#4b5563' }}>
        {label}
        {required && <span style={{ color: '#ef4444' }}> *</span>}
      </label>
      {children}
    </div>
  )
}

const inputClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm text-gray-800 transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"
const selectClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white transition-colors focus:outline-none focus:border-[#FF8303] focus:ring-2 focus:ring-[#FF8303]/15"
// Read-only stand-ins keep the input silhouette with a grey fill.
const readOnlyClass = "w-full border border-[#E0DFDC] rounded-lg px-3 py-1.5 text-sm flex items-center"

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
    return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  }

  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>

      {/* Header */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Tasks
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-2xl font-bold text-gray-900">
          {mode === 'create' ? 'New Task' : 'Edit Task'}
        </h1>
      </div>

      {/* Single scrolling form — one card per section.
          pb-28 keeps the last field clear of the sticky action bar. */}
      <div className="max-w-6xl mx-auto space-y-6 pb-28">

        {error && (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{ backgroundColor: '#fee2e2', color: '#991b1b' }}
          >
            {error}
          </div>
        )}

        {/* 1. Task Details */}
        <Section title="Task Details">
          <Field label="Title" required>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Follow up on missed report"
              className={inputClass}
            />
          </Field>

          {/* Priority + Reason row */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Priority" required>
              <select value={priority} onChange={e => setPriority(e.target.value)} className={selectClass}>
                <option value="">Select…</option>
                {PRIORITY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Follow-up Reason" required>
              <select value={followUpReason} onChange={e => setFollowUpReason(e.target.value)} className={selectClass}>
                <option value="">Select…</option>
                {REASON_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Assigned To">
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className={selectClass}>
              <option value="">Defaults to Shannon</option>
              {staffMembers.map(s => (
                <option key={s.id} value={s.id}>{s.full_name}</option>
              ))}
            </select>
          </Field>

          <Field label="Due Date">
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className={inputClass}
            />
          </Field>
        </Section>

        {/* 2. Link & Notes */}
        <Section title="Link & Notes">
          <Field label="Linked To (optional)">
            {/* If pre-filled from a detail page, show read-only */}
            {prefillLinkedId && prefillLinkedName ? (
              <div className={readOnlyClass} style={{ backgroundColor: '#f9fafb', color: '#374151' }}>
                <span className="text-xs text-gray-400 mr-2 capitalize">
                  {prefillLinkedType}:
                </span>
                {prefillLinkedName}
              </div>
            ) : (
              <div className="grid gap-2" style={{ gridTemplateColumns: '140px 1fr' }}>
                <select
                  value={linkedType}
                  onChange={e => handleLinkedTypeChange(e.target.value)}
                  className={selectClass}
                >
                  <option value="">None</option>
                  <option value="teacher">Teacher</option>
                  <option value="student">Student</option>
                </select>
                {linkedType ? (
                  <select
                    value={linkedId}
                    onChange={e => setLinkedId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Select {linkedType}…</option>
                    {linkedOptions.map(o => (
                      <option key={o.id} value={o.id}>{o.full_name}</option>
                    ))}
                  </select>
                ) : (
                  <div className={readOnlyClass} style={{ backgroundColor: '#f9fafb', color: '#9ca3af' }}>
                    Select a type first
                  </div>
                )}
              </div>
            )}
          </Field>

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add any relevant details, context, or instructions…"
              rows={4}
              className={`${inputClass} leading-relaxed`}
              style={{ resize: 'vertical' }}
            />
          </Field>
        </Section>
      </div>

      {/* Sticky action bar — sticks to the bottom of the scrolling main area */}
      <div className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}>
        <button
          onClick={() => router.back()}
          disabled={saving}
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
          {saving ? 'Saving…' : mode === 'create' ? 'Create Task' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
