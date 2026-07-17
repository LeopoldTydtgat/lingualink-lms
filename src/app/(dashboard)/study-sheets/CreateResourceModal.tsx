'use client'

import { useState, useRef, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X, Trash2, FileText, Upload } from 'lucide-react'

// Teacher "Add Resource" flow - a single form, one action. Metadata plus any
// number of locally-staged files; one Create button creates the sheet and then
// uploads each staged file against the returned id. Teacher-owned sheets are
// always private staff material server-side; nothing here can change that.
// category and level are optional: a teacher private resource may omit both,
// which stores NULL for each. All state-dependent colours are inline style props.

type Props = { onClose: () => void }

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx'
const ACCEPT_EXT = ['.pdf', '.doc', '.docx', '.ppt', '.pptx']

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.4)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
}

const panel: CSSProperties = {
  backgroundColor: 'white',
  borderRadius: '12px',
  width: '100%',
  maxWidth: '480px',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 500,
  color: '#374151',
  marginBottom: '4px',
}

const fieldStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid #E0DFDC',
  fontSize: '14px',
  color: '#111827',
  backgroundColor: 'white',
}

function hasAcceptedExt(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPT_EXT.some(ext => lower.endsWith(ext))
}

export default function CreateResourceModal({ onClose }: Props) {
  const router = useRouter()

  // Metadata - category/level use '' to mean "None" (omitted on submit).
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [introText, setIntroText] = useState('')

  // Files staged locally; uploaded only after the sheet row is created.
  const [staged, setStaged] = useState<File[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Submission state.
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // Once the row exists we must never POST again (a second create would make a
  // duplicate). When some file uploads fail we hold the modal open on this flag
  // to report which files, offering only a Close that refreshes the list.
  const [created, setCreated] = useState(false)
  const [failedUploads, setFailedUploads] = useState<string[]>([])

  // Shared staging path used by the native picker and drag-and-drop.
  function stageFiles(files: File[]) {
    setFileError(null)
    if (files.length === 0) return
    setStaged(prev => {
      const next = [...prev]
      for (const f of files) {
        if (!hasAcceptedExt(f.name)) {
          setFileError(`"${f.name}" is not a supported file type.`)
          continue
        }
        if (f.size > MAX_FILE_SIZE) {
          setFileError(`"${f.name}" exceeds the 10 MB limit.`)
          continue
        }
        if (next.some(s => s.name === f.name)) continue
        next.push(f)
      }
      return next
    })
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(e.target.files ?? []))
    // Reset so the same file can be re-selected after removal.
    if (fileRef.current) fileRef.current.value = ''
  }

  function removeStaged(name: string) {
    setStaged(prev => prev.filter(f => f.name !== name))
  }

  function finishAndClose() {
    router.refresh()
    onClose()
  }

  async function handleCreate() {
    if (created) return
    setCreateError(null)
    if (!title.trim()) {
      setCreateError('Title is required.')
      return
    }
    setCreating(true)
    try {
      // Send only the fields that are set. Omitting category/level lets the route
      // insert NULL (the sentinel for a resource with no category/level).
      const payload: Record<string, unknown> = { title: title.trim() }
      if (category) payload.category = category
      if (level) payload.level = level
      if (difficulty !== '') payload.difficulty = Number(difficulty)
      if (introText.trim()) payload.intro_text = introText.trim()

      const res = await fetch('/api/teacher/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status !== 201) {
        let msg = 'Could not create the resource.'
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {}
        setCreateError(msg)
        setCreating(false)
        return
      }

      const data = await res.json()
      const sheetId = data.id as string
      // The row now exists - never create it again.
      setCreated(true)

      // Upload staged files one at a time against the new id.
      const failed: string[] = []
      for (const file of staged) {
        try {
          const form = new FormData()
          form.append('file', file)
          form.append('sheet_id', sheetId)
          const up = await fetch('/api/teacher/library/upload', { method: 'POST', body: form })
          if (!up.ok) failed.push(file.name)
        } catch {
          failed.push(file.name)
        }
      }

      setCreating(false)

      if (failed.length > 0) {
        // The sheet was created; only some files failed. Keep the modal open to
        // say which - Close then refreshes the list.
        setFailedUploads(failed)
        return
      }

      finishAndClose()
    } catch {
      setCreateError('Could not create the resource.')
      setCreating(false)
    }
  }

  return (
    <div style={overlay}>
      <div style={panel}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #E0DFDC',
          }}
        >
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827' }}>Add Resource</h2>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
              Private to you (staff material)
            </p>
          </div>
          <button
            type="button"
            onClick={created ? finishAndClose : onClose}
            aria-label="Close"
            style={{ color: '#9ca3af', padding: '4px' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Title</label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Resource title" />
            </div>

            <div>
              <label style={labelStyle}>Category (optional)</label>
              <select value={category} onChange={e => setCategory(e.target.value)} style={fieldStyle}>
                <option value="">None</option>
                <option value="vocabulary">Vocabulary</option>
                <option value="grammar">Grammar</option>
              </select>
            </div>

            <div>
              <label style={labelStyle}>Level (optional)</label>
              <select value={level} onChange={e => setLevel(e.target.value)} style={fieldStyle}>
                <option value="">None</option>
                {LEVELS.map(l => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={labelStyle}>Difficulty (optional)</label>
              <select value={difficulty} onChange={e => setDifficulty(e.target.value)} style={fieldStyle}>
                <option value="">Not set</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </div>

            <div>
              <label style={labelStyle}>Intro text (optional)</label>
              <textarea
                value={introText}
                onChange={e => setIntroText(e.target.value)}
                rows={3}
                placeholder="Optional description"
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
            </div>

            {/* Files - staged locally, uploaded on Create */}
            <div>
              <label style={labelStyle}>Files (optional)</label>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                multiple
                onChange={handleFilePick}
                style={{ display: 'none' }}
              />
              <div
                onClick={() => { if (!created) fileRef.current?.click() }}
                onMouseEnter={e => {
                  if (created) return
                  e.currentTarget.style.borderColor = '#FF8303'
                  e.currentTarget.style.backgroundColor = '#FFF8F1'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = '#E0DFDC'
                  e.currentTarget.style.backgroundColor = 'white'
                }}
                onDragOver={e => {
                  if (created) return
                  e.preventDefault()
                  e.currentTarget.style.borderColor = '#FF8303'
                  e.currentTarget.style.backgroundColor = '#FFF8F1'
                }}
                onDragLeave={e => {
                  e.currentTarget.style.borderColor = '#E0DFDC'
                  e.currentTarget.style.backgroundColor = 'white'
                }}
                onDrop={e => {
                  e.preventDefault()
                  e.currentTarget.style.borderColor = '#E0DFDC'
                  e.currentTarget.style.backgroundColor = 'white'
                  if (created) return
                  stageFiles(Array.from(e.dataTransfer.files ?? []))
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '24px',
                  borderRadius: '8px',
                  border: '2px dashed #E0DFDC',
                  backgroundColor: 'white',
                  textAlign: 'center',
                  cursor: created ? 'not-allowed' : 'pointer',
                  opacity: created ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '40px',
                    height: '40px',
                    borderRadius: '9999px',
                    backgroundColor: '#FFF3E0',
                  }}
                >
                  <Upload className="w-5 h-5" style={{ color: '#FF8303' }} />
                </span>
                <span style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>
                  Click to upload files
                </span>
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                  PDF, DOC, DOCX, PPT, PPTX - max 10 MB each
                </span>
              </div>
              {fileError && <p style={{ color: '#FD5602', fontSize: '13px', marginTop: '8px' }}>{fileError}</p>}
            </div>

            {staged.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {staged.map(f => {
                  const failed = failedUploads.includes(f.name)
                  return (
                    <div
                      key={f.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '8px 10px',
                        borderRadius: '8px',
                        border: `1px solid ${failed ? '#FD5602' : '#E0DFDC'}`,
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '13px',
                          color: '#111827',
                          minWidth: 0,
                        }}
                      >
                        <FileText className="w-4 h-4 shrink-0" style={{ color: '#9ca3af' }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.name}
                        </span>
                      </span>
                      {failed ? (
                        <span style={{ fontSize: '12px', color: '#FD5602', flexShrink: 0 }}>Failed</span>
                      ) : (
                        !created && (
                          <button
                            type="button"
                            onClick={() => removeStaged(f.name)}
                            aria-label="Remove file"
                            style={{ color: '#FD5602', padding: '4px', flexShrink: 0 }}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {createError && <p style={{ color: '#FD5602', fontSize: '13px' }}>{createError}</p>}
            {failedUploads.length > 0 && (
              <p style={{ color: '#FD5602', fontSize: '13px' }}>
                The resource was created, but these files did not upload: {failedUploads.join(', ')}. Open the resource
                later to add them again.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            padding: '16px 20px',
            borderTop: '1px solid #E0DFDC',
          }}
        >
          {created ? (
            <Button
              onClick={finishAndClose}
              style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
            >
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={creating}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={creating}
                style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
              >
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
