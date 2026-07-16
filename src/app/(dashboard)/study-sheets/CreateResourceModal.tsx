'use client'

import { useState, useRef, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X, Upload, Trash2, FileText } from 'lucide-react'

// Teacher "Add Resource" flow. Two phases in one modal:
//   1. create - POST /api/teacher/library returns the new sheet id (201).
//   2. files  - upload/remove files against that id, then Done -> refresh.
// Teacher-owned sheets are always private staff material server-side; nothing
// here can change that. All state-dependent colours are inline style props.

type Attachment = { name: string; type: string }

type Props = { onClose: () => void }

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx'

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

export default function CreateResourceModal({ onClose }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<1 | 2>(1)

  // Phase 1 (create) fields
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [introText, setIntroText] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Phase 2 (files) state
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [files, setFiles] = useState<Attachment[]>([])
  const [selected, setSelected] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleCreate() {
    setCreateError(null)
    if (!title.trim() || !category || !level) {
      setCreateError('Title, category and level are required.')
      return
    }
    setCreating(true)
    try {
      // Omit difficulty when unset so the DB NOT NULL DEFAULT 1 applies; an
      // explicit null would violate the constraint.
      const payload: Record<string, unknown> = {
        title: title.trim(),
        category,
        level,
      }
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
      setSheetId(data.id as string)
      setPhase(2)
      setCreating(false)
    } catch {
      setCreateError('Could not create the resource.')
      setCreating(false)
    }
  }

  async function handleUpload() {
    setUploadError(null)
    if (!selected || !sheetId) {
      setUploadError('Choose a file first.')
      return
    }
    // Client-side size guard before sending; the route enforces it again.
    if (selected.size > MAX_FILE_SIZE) {
      setUploadError('File exceeds the 10 MB limit.')
      return
    }
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', selected)
      form.append('sheet_id', sheetId)
      const res = await fetch('/api/teacher/library/upload', {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        let msg = 'Could not upload the file.'
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {}
        setUploadError(msg)
        setUploading(false)
        return
      }
      // Route returns the attachment {name, type} directly (no url field).
      const att = (await res.json()) as Attachment
      setFiles(prev => [...prev.filter(f => f.name !== att.name), att])
      setSelected(null)
      if (fileRef.current) fileRef.current.value = ''
      setUploading(false)
    } catch {
      setUploadError('Could not upload the file.')
      setUploading(false)
    }
  }

  async function handleRemove(name: string) {
    if (!sheetId) return
    setUploadError(null)
    try {
      const res = await fetch('/api/teacher/library/upload', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_id: sheetId, filename: name }),
      })
      if (!res.ok) {
        let msg = 'Could not remove the file.'
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {}
        setUploadError(msg)
        return
      }
      setFiles(prev => prev.filter(f => f.name !== name))
    } catch {
      setUploadError('Could not remove the file.')
    }
  }

  function finishAndClose() {
    router.refresh()
    onClose()
  }

  function handleHeaderClose() {
    // Once phase 2 is reached the sheet exists, so refresh to surface it.
    if (phase === 2) finishAndClose()
    else onClose()
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
            <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827' }}>
              {phase === 1 ? 'Add Resource' : 'Add Files'}
            </h2>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
              {phase === 1 ? 'Private to you (staff material)' : 'Attach files to your resource'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleHeaderClose}
            aria-label="Close"
            style={{ color: '#9ca3af', padding: '4px' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
          {phase === 1 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={labelStyle}>Title</label>
                <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Resource title" />
              </div>
              <div>
                <label style={labelStyle}>Category</label>
                <select value={category} onChange={e => setCategory(e.target.value)} style={fieldStyle}>
                  <option value="">Select a category</option>
                  <option value="vocabulary">Vocabulary</option>
                  <option value="grammar">Grammar</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Level</label>
                <select value={level} onChange={e => setLevel(e.target.value)} style={fieldStyle}>
                  <option value="">Select a level</option>
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
              {createError && <p style={{ color: '#FD5602', fontSize: '13px' }}>{createError}</p>}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={labelStyle}>Add a file</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPT}
                  onChange={e => setSelected(e.target.files?.[0] ?? null)}
                  style={{ fontSize: '13px', color: '#4b5563' }}
                />
                <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  PDF, DOC, DOCX, PPT, PPTX. Max 10 MB.
                </p>
              </div>
              <div>
                <Button
                  onClick={handleUpload}
                  disabled={uploading || !selected}
                  style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {uploading ? 'Uploading...' : 'Upload'}
                </Button>
              </div>
              {uploadError && <p style={{ color: '#FD5602', fontSize: '13px' }}>{uploadError}</p>}

              {files.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {files.map(f => (
                    <div
                      key={f.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '8px 10px',
                        borderRadius: '8px',
                        border: '1px solid #E0DFDC',
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
                      <button
                        type="button"
                        onClick={() => handleRemove(f.name)}
                        aria-label="Remove file"
                        style={{ color: '#FD5602', padding: '4px', flexShrink: 0 }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
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
          {phase === 1 ? (
            <>
              <Button variant="outline" onClick={onClose}>
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
          ) : (
            <Button
              onClick={finishAndClose}
              style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
            >
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
