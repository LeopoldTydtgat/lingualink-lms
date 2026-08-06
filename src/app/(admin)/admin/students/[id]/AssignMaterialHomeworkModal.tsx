'use client'

import { useState } from 'react'
import type { MaterialSheetOption } from './StudentDetailClient'

// Admin assign-teaching-material modal.
//
// Deliberately NOT the teacher modal
// (src/app/(dashboard)/study-sheets/[id]/AssignMaterialModal.tsx): that one
// sources its student list from GET /api/teacher/material-assignments, which is
// scoped to the caller's own students. Here the student is already fixed by the
// page, and an admin may assign to ANY current student, so there is no picker
// and no teacher-scoped read.
//
// Nothing in this file is a security control. Every check below only spares the
// admin a round trip; POST /api/admin/material-assignments re-validates all of
// it behind requireAdmin().

type Props = {
  studentId: string
  studentName: string
  /** Active, audience='staff' sheets, fetched server-side by the page. */
  sheets: MaterialSheetOption[]
  onClose: () => void
  /** Called after a successful grant, so the parent can re-read the section. */
  onAssigned: () => void
}

// Only PDFs can be assigned: the file route rebuilds the document page by page
// and refuses anything else, so a non-PDF grant could never be served.
function pdfIndexes(sheet: MaterialSheetOption): number[] {
  return sheet.attachments
    .map((att, idx) => ({ att, idx }))
    .filter(({ att }) => att.type === 'application/pdf')
    .map(({ idx }) => idx)
}

export default function AssignMaterialHomeworkModal({
  studentId,
  studentName,
  sheets,
  onClose,
  onAssigned,
}: Props) {
  const [sheetId, setSheetId] = useState('')
  const [attachmentIndex, setAttachmentIndex] = useState<number | null>(null)
  const [pageStart, setPageStart] = useState('')
  const [pageEnd, setPageEnd] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const selectedSheet = sheets.find((s) => s.id === sheetId) ?? null
  const attachments = selectedSheet?.attachments ?? []
  const pdfCount = selectedSheet ? pdfIndexes(selectedSheet).length : 0

  function handleSheetChange(nextSheetId: string) {
    setSubmitError(null)
    setSheetId(nextSheetId)
    setPageStart('')
    setPageEnd('')

    // Auto-select when the chosen sheet holds exactly one PDF; otherwise force a
    // deliberate pick rather than leaving a stale index from the previous sheet
    // pointing at a different file.
    const next = sheets.find((s) => s.id === nextSheetId) ?? null
    const pdfs = next ? pdfIndexes(next) : []
    setAttachmentIndex(pdfs.length === 1 ? pdfs[0] : null)
  }

  async function handleAssign() {
    setSubmitError(null)

    if (!sheetId) {
      setSubmitError('Choose a teaching material.')
      return
    }
    if (attachmentIndex === null) {
      setSubmitError('Choose a file to assign.')
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
      const res = await fetch('/api/admin/material-assignments', {
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

      // 409 (already assigned) and the 422 codes (ATTACHMENT_NOT_PDF,
      // PDF_LOAD_FAILED, PAGE_RANGE_UNSATISFIABLE) all carry a message written
      // for a human - surface it verbatim. A non-JSON body (proxy error page,
      // empty response) must not throw past that handling.
      let data: { error?: string | null }
      try {
        data = await res.json()
      } catch {
        data = { error: null }
      }

      if (!res.ok) {
        if (data.error) {
          setSubmitError(data.error)
        } else if (res.status === 409) {
          setSubmitError('This student already has a live assignment for this file. Revoke it first.')
        } else {
          setSubmitError('Could not assign this file. Please try again.')
        }
        return
      }

      onAssigned()
      onClose()
    } catch {
      setSubmitError('Could not reach the server, so nothing was assigned. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass =
    'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
  const canSubmit = Boolean(sheetId) && attachmentIndex !== null && !submitting

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
    >
      <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Assign teaching material</h3>
        <p className="text-sm text-gray-500 mb-4">
          {studentName} will see this in their Study tab, and only the pages granted here.
        </p>

        {/* Material */}
        <label className="block text-sm font-medium text-gray-700 mb-1">Teaching material</label>
        <select
          value={sheetId}
          onChange={(e) => handleSheetChange(e.target.value)}
          disabled={submitting}
          className={`${inputClass} mb-4 disabled:opacity-50`}
        >
          <option value="">Choose teaching material...</option>
          {sheets.map((sheet) => {
            const hasPdf = pdfIndexes(sheet).length > 0
            return (
              <option key={sheet.id} value={sheet.id} disabled={!hasPdf}>
                {hasPdf ? sheet.title : `${sheet.title} (no PDF)`}
              </option>
            )
          })}
        </select>

        {/* File — hidden entirely when the sheet has exactly one PDF: the
            auto-select logic in handleSheetChange already picked it, so
            there is nothing left to choose. */}
        {!selectedSheet ? (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1">File</label>
            <p className="text-sm text-gray-400 mb-4">Choose a teaching material first.</p>
          </>
        ) : pdfCount === 0 ? (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1">File</label>
            <p className="text-sm text-gray-400 mb-4">This material has no files to assign.</p>
          </>
        ) : pdfCount >= 2 ? (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              This material has multiple files - choose one
            </label>
            <select
              value={attachmentIndex === null ? '' : String(attachmentIndex)}
              onChange={(e) =>
                setAttachmentIndex(e.target.value === '' ? null : Number(e.target.value))
              }
              disabled={submitting}
              className={`${inputClass} mb-4 disabled:opacity-50`}
            >
              <option value="">Choose a file...</option>
              {attachments.map((att, idx) => {
                const isPdf = att.type === 'application/pdf'
                return (
                  <option key={`${att.name}-${idx}`} value={String(idx)} disabled={!isPdf}>
                    {isPdf ? att.name : `${att.name} (PDF only)`}
                  </option>
                )
              })}
            </select>
          </>
        ) : null}

        {/* Page range */}
        <label className="block text-sm font-medium text-gray-700 mb-1">Pages (optional)</label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="from page"
            value={pageStart}
            onChange={(e) => setPageStart(e.target.value)}
            disabled={submitting}
            className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 disabled:opacity-50"
          />
          <span className="text-sm text-gray-400">to</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="to page"
            value={pageEnd}
            onChange={(e) => setPageEnd(e.target.value)}
            disabled={submitting}
            className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 disabled:opacity-50"
          />
        </div>
        <p className="text-xs text-gray-400 mt-1.5 mb-4">
          Leave both empty to assign the whole document.
        </p>

        {submitError && (
          <div
            className="text-sm rounded-lg px-4 py-3 mb-4"
            style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}
          >
            {submitError}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleAssign}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:cursor-not-allowed"
            style={canSubmit ? { backgroundColor: '#FF8303' } : { backgroundColor: '#E5E7EB', color: '#9CA3AF' }}
          >
            {submitting ? 'Assigning...' : 'Assign homework'}
          </button>
        </div>
      </div>
    </div>
  )
}
