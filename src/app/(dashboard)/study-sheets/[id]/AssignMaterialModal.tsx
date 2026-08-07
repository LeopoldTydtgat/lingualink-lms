'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Check, Trash2 } from 'lucide-react'

// Assign-teaching-material modal (Build Item 2).
//
// Issues and revokes material_assignments grants for ONE study sheet. Every
// authorisation decision lives in the two API routes it calls
// (/api/teacher/material-assignments and .../[id]) - and, underneath those, in
// the material_assignments RLS policies. Nothing here is a security control:
// the client-side page-range checks only spare the teacher a round trip, and
// the server re-validates every one of them.

type Attachment = { name: string; type: string }

type StudentOption = { id: string; full_name: string }

type LiveAssignment = {
  id: string
  student_id: string
  student_name: string | null
  attachment_index: number
  attachment_name: string
  page_start: number | null
  page_end: number | null
  assigned_at: string
}

type Props = {
  sheetId: string
  sheetTitle: string
  attachments: Attachment[]
  // Pre-selects a student when the caller already knows which one (the class
  // report form opens this from a lesson). Purely a convenience: the student
  // list, and the grant itself, are still decided by the API route.
  initialStudentId?: string
  onClose: () => void
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
}

// Date-only, in the viewer's own zone, via Intl - never toISOString().slice(),
// which reports the UTC calendar day and is a day off for anyone east or west
// of UTC around midnight. This component only ever mounts from a click, so it
// never renders on the server and cannot hydrate-mismatch on locale.
function formatAssignedAt(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, DATE_FORMAT).format(parsed)
}

function rangeLabel(assignment: LiveAssignment): string {
  if (assignment.page_start === null || assignment.page_end === null) return 'Whole document'
  return `Pages ${assignment.page_start}-${assignment.page_end}`
}

export default function AssignMaterialModal({
  sheetId,
  sheetTitle,
  attachments,
  initialStudentId,
  onClose,
}: Props) {
  // Only PDFs can be assigned: the file route rebuilds the document page by page
  // and refuses anything else, so a non-PDF grant could never be served.
  const pdfOptions = attachments
    .map((att, idx) => ({ att, idx }))
    .filter(({ att }) => att.type === 'application/pdf')

  const [attachmentIndex, setAttachmentIndex] = useState<number | null>(
    pdfOptions.length === 1 ? pdfOptions[0].idx : null
  )
  const [studentId, setStudentId] = useState(initialStudentId ?? '')
  const [pageStart, setPageStart] = useState('')
  const [pageEnd, setPageEnd] = useState('')

  const [students, setStudents] = useState<StudentOption[]>([])
  const [assignments, setAssignments] = useState<LiveAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [success, setSuccess] = useState('')
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  // Newest-assignment highlight: id of the row to fade, and a flag that flips
  // shortly after it is set so the backgroundColor transition actually runs
  // (a style applied and changed in the same paint never animates).
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [highlightFaded, setHighlightFaded] = useState(false)

  // Single loader, reused for the initial fetch and after every mutation. A
  // failure ALWAYS surfaces: an empty list is never used to stand in for an
  // error the teacher was not told about. Returns the freshly loaded
  // assignments (or null on failure) so callers can act on the up-to-date
  // list without waiting on a re-render to read state back.
  const load = useCallback(async () => {
    setLoadError('')
    try {
      const res = await fetch(
        `/api/teacher/material-assignments?sheet_id=${encodeURIComponent(sheetId)}`
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadError(
          typeof body.error === 'string' && body.error
            ? body.error
            : 'Could not load the assignment list. Please try again.'
        )
        return null
      }
      const nextAssignments: LiveAssignment[] = Array.isArray(body.assignments) ? body.assignments : []
      setStudents(Array.isArray(body.students) ? body.students : [])
      setAssignments(nextAssignments)
      return nextAssignments
    } catch {
      setLoadError('Could not load the assignment list. Please try again.')
      return null
    } finally {
      setLoading(false)
    }
  }, [sheetId])

  useEffect(() => {
    void load()
  }, [load])

  // A prefilled student the loaded list does not contain must be dropped. A
  // controlled <select> whose value matches no <option> deselects every option
  // and renders blank - it does NOT fall back to the "Choose a student..."
  // placeholder - and Assign would stay enabled on an id the route will refuse.
  // Options are only ever built from `students`, so a teacher-made choice can
  // never trip this.
  useEffect(() => {
    if (loading || !studentId) return
    if (students.some(s => s.id === studentId)) return
    setStudentId('')
  }, [loading, students, studentId])

  // Kick off the fade once a row is marked for highlighting.
  useEffect(() => {
    if (!highlightId) return
    setHighlightFaded(false)
    const timer = setTimeout(() => setHighlightFaded(true), 50)
    return () => clearTimeout(timer)
  }, [highlightId])

  // Belt-and-braces: drop the pending auto-clear timer on unmount too, not
  // just when a new submit starts.
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current)
    }
  }, [])

  async function handleAssign() {
    // A new submit always wins: never let a stale 4s auto-clear from a
    // previous assign fire in the middle of (or after) this one.
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current)
      successTimeoutRef.current = null
    }
    setSubmitError('')
    setSuccess('')
    setConfirmingId(null)

    if (attachmentIndex === null) {
      setSubmitError('Choose a file to assign.')
      return
    }
    if (!studentId) {
      setSubmitError('Choose a student.')
      return
    }

    // Mirrors MaterialAssignmentCreateSchema, which mirrors the DB CHECK. The
    // server stays the authority - this is only a faster, friendlier failure.
    const rawStart = pageStart.trim()
    const rawEnd = pageEnd.trim()
    let startValue: number | null = null
    let endValue: number | null = null

    if (rawStart !== '' || rawEnd !== '') {
      if (rawStart === '' || rawEnd === '') {
        setSubmitError('Give both a first and a last page, or leave both empty for the whole document.')
        return
      }
      startValue = Number(rawStart)
      endValue = Number(rawEnd)
      if (!Number.isInteger(startValue) || !Number.isInteger(endValue)) {
        setSubmitError('Page numbers must be whole numbers.')
        return
      }
      if (startValue < 1) {
        setSubmitError('The first page must be 1 or higher.')
        return
      }
      if (endValue < startValue) {
        setSubmitError('The last page cannot come before the first page.')
        return
      }
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/teacher/material-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_id: studentId,
          study_sheet_id: sheetId,
          attachment_index: attachmentIndex,
          page_start: startValue,
          page_end: endValue,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 409 (already assigned) and 422 (page range / not a PDF) carry a
        // message written for the teacher - show it verbatim.
        setSubmitError(
          typeof body.error === 'string' && body.error
            ? body.error
            : 'Could not assign this file. Please try again.'
        )
        return
      }

      const assigned = students.find(s => s.id === studentId)
      const name = assigned ? assigned.full_name : 'the student'
      setSuccess(`Assigned to ${name}. You can assign another student or close.`)
      successTimeoutRef.current = setTimeout(() => {
        setSuccess('')
        successTimeoutRef.current = null
      }, 4000)

      // Captured before the form clears below, so the just-submitted grant
      // can still be matched against the reloaded list.
      const submittedStudentId = studentId
      const submittedAttachmentIndex = attachmentIndex

      // Clear the student and range so an accidental second click cannot
      // re-submit the same grant (which the unique index would 409 anyway).
      setStudentId('')
      setPageStart('')
      setPageEnd('')

      const reloaded = await load()

      let newId: string | null =
        typeof body.assignment?.id === 'string' ? body.assignment.id : null
      if (!newId && reloaded) {
        const match = reloaded.find(
          a => a.student_id === submittedStudentId && a.attachment_index === submittedAttachmentIndex
        )
        if (match) newId = match.id
      }
      if (newId) {
        setHighlightId(newId)
      }
    } catch {
      setSubmitError('Could not assign this file. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(assignment: LiveAssignment) {
    setRevokeError('')
    setSuccess('')
    setRevokingId(assignment.id)
    try {
      const res = await fetch(`/api/teacher/material-assignments/${assignment.id}`, {
        method: 'DELETE',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRevokeError(
          typeof body.error === 'string' && body.error
            ? body.error
            : 'Could not revoke this assignment. Please try again.'
        )
        return
      }
      await load()
    } catch {
      setRevokeError('Could not revoke this assignment. Please try again.')
    } finally {
      setRevokingId(null)
      setConfirmingId(null)
    }
  }

  const busy = submitting || revokingId !== null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid #E0DFDC' }}
        >
          <div className="min-w-0">
            <h2 className="font-semibold" style={{ color: '#111827' }}>Assign to Student</h2>
            <p className="text-sm mt-0.5 truncate" style={{ color: '#9ca3af' }}>{sheetTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-2 flex-shrink-0 transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ color: '#9ca3af' }}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5 thin-scroll">

          {/* File */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151' }}>
              File
            </label>
            {attachments.length === 0 ? (
              <p className="text-sm" style={{ color: '#9ca3af' }}>
                This sheet has no files to assign.
              </p>
            ) : (
              <select
                value={attachmentIndex === null ? '' : String(attachmentIndex)}
                onChange={e => setAttachmentIndex(e.target.value === '' ? null : Number(e.target.value))}
                disabled={busy}
                className="w-full rounded-md text-sm px-3 py-2 border disabled:opacity-50"
                style={{ borderColor: '#E0DFDC', color: '#111827', backgroundColor: '#ffffff' }}
              >
                <option value="" disabled>Choose a file...</option>
                {attachments.map((att, idx) => {
                  const isPdf = att.type === 'application/pdf'
                  return (
                    <option key={`${att.name}-${idx}`} value={String(idx)} disabled={!isPdf}>
                      {isPdf ? att.name : `${att.name} (PDF only)`}
                    </option>
                  )
                })}
              </select>
            )}
            {attachments.length > 0 && pdfOptions.length === 0 && (
              <p className="text-xs mt-1.5" style={{ color: '#9ca3af' }}>
                Only PDF files can be assigned as homework.
              </p>
            )}
          </div>

          {/* Student */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151' }}>
              Student
            </label>
            {loading ? (
              <p className="text-sm" style={{ color: '#9ca3af' }}>Loading students...</p>
            ) : students.length === 0 ? (
              <p className="text-sm" style={{ color: '#9ca3af' }}>
                You have no students to assign to yet.
              </p>
            ) : (
              <select
                value={studentId}
                onChange={e => setStudentId(e.target.value)}
                disabled={busy}
                className="w-full rounded-md text-sm px-3 py-2 border disabled:opacity-50"
                style={{ borderColor: '#E0DFDC', color: '#111827', backgroundColor: '#ffffff' }}
              >
                <option value="" disabled>Choose a student...</option>
                {students.map(student => (
                  <option key={student.id} value={student.id}>{student.full_name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Page range */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151' }}>
              Pages (optional)
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="from page"
                value={pageStart}
                onChange={e => setPageStart(e.target.value)}
                disabled={busy}
                className="w-32 rounded-md text-sm px-3 py-2 border disabled:opacity-50"
                style={{ borderColor: '#E0DFDC', color: '#111827' }}
              />
              <span className="text-sm" style={{ color: '#9ca3af' }}>to</span>
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="to page"
                value={pageEnd}
                onChange={e => setPageEnd(e.target.value)}
                disabled={busy}
                className="w-32 rounded-md text-sm px-3 py-2 border disabled:opacity-50"
                style={{ borderColor: '#E0DFDC', color: '#111827' }}
              />
            </div>
            <p className="text-xs mt-1.5" style={{ color: '#9ca3af' }}>
              Leave both empty to assign the whole document. The student only ever receives the
              pages you grant here.
            </p>
          </div>

          {submitError && (
            <p className="text-sm" style={{ color: '#FD5602' }}>{submitError}</p>
          )}
          {success && (
            <div
              className="flex items-center gap-1.5 text-sm font-medium rounded-md px-3 py-2"
              style={{ backgroundColor: '#f0fdf4', border: '1px solid #16a34a', color: '#16a34a' }}
            >
              <Check className="w-4 h-4" />
              {success}
            </div>
          )}

          {/* Live assignments for this sheet */}
          <div className="pt-2" style={{ borderTop: '1px solid #E0DFDC' }}>
            <h3 className="text-sm font-semibold mb-2 mt-3" style={{ color: '#111827' }}>
              Current assignments
            </h3>

            {loadError ? (
              <p className="text-sm" style={{ color: '#FD5602' }}>{loadError}</p>
            ) : loading ? (
              <p className="text-sm" style={{ color: '#9ca3af' }}>Loading...</p>
            ) : assignments.length === 0 ? (
              <p className="text-sm" style={{ color: '#9ca3af' }}>
                Nothing from this sheet is assigned right now.
              </p>
            ) : (
              <div className="space-y-2">
                {assignments.map(assignment => {
                  const isRevoking = revokingId === assignment.id
                  const isHighlighted = assignment.id === highlightId
                  return (
                    <div
                      key={assignment.id}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg"
                      style={{
                        border: '1px solid #E0DFDC',
                        backgroundColor: isHighlighted ? (highlightFaded ? '#ffffff' : '#f0fdf4') : undefined,
                        transition: isHighlighted ? 'background-color 1.5s ease' : undefined,
                      }}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: '#111827' }}>
                          {assignment.student_name ?? 'Unknown student'}
                        </p>
                        <p className="text-xs truncate" style={{ color: '#9ca3af' }}>
                          {assignment.attachment_name} &middot; {rangeLabel(assignment)} &middot;{' '}
                          {formatAssignedAt(assignment.assigned_at)}
                        </p>
                      </div>
                      {assignment.id === confirmingId ? (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs" style={{ color: '#4b5563' }}>
                            Revoke for {assignment.student_name ?? 'this student'}?
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRevoke(assignment)}
                            disabled={busy}
                            className="text-xs font-semibold px-2.5 py-1 rounded-md flex-shrink-0 transition-opacity hover:opacity-80 disabled:opacity-50"
                            style={{ color: 'white', backgroundColor: '#FD5602' }}
                          >
                            {isRevoking ? 'Revoking...' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            disabled={busy}
                            className="text-xs font-semibold px-2.5 py-1 rounded-md flex-shrink-0 transition-opacity hover:opacity-80 disabled:opacity-50"
                            style={{ color: '#6b7280', border: '1px solid #E0DFDC', backgroundColor: '#ffffff' }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(assignment.id)}
                          disabled={busy}
                          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md flex-shrink-0 transition-opacity hover:opacity-80 disabled:opacity-50"
                          style={{ color: '#6b7280', border: '1px solid #E0DFDC', backgroundColor: '#ffffff' }}
                          title="Revoke this assignment"
                        >
                          <Trash2 size={12} />
                          Revoke
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {revokeError && (
              <p className="text-sm mt-2" style={{ color: '#FD5602' }}>{revokeError}</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="px-6 py-4 flex items-center justify-end gap-3"
          style={{ borderTop: '1px solid #E0DFDC' }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-md border transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ borderColor: '#E0DFDC', color: '#4b5563', backgroundColor: 'white' }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleAssign}
            disabled={busy || loading || attachmentIndex === null || !studentId}
            className="px-5 py-2 text-sm rounded-md text-white font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ backgroundColor: '#FF8303' }}
          >
            {submitting ? 'Assigning...' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}
