'use client'

import { useState, useMemo, useRef } from 'react'
import { StudySheet, WordRow, ExerciseRow, SheetContent, Attachment } from './LibraryAdminClient'

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  sheet: StudySheet | null   // null = create mode
  onClose: () => void
  onSaved: () => Promise<void>
}

type FormTab = 'metadata' | 'vocabulary' | 'exercises' | 'files' | 'access'

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEVELS = ['A1', 'A1+', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1', 'C1+', 'C2']

const ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]

const ACCEPTED_EXTENSIONS = '.pdf,.doc,.docx,.ppt,.pptx'
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

function newWordRow(): WordRow {
  return { id: crypto.randomUUID(), word: '', pos: '', definition: '', example: '', audio_url: '' }
}

function newExerciseRow(): ExerciseRow {
  return {
    id: crypto.randomUUID(),
    question: '',
    options: ['', '', '', ''],
    correct_index: 0,
    explanation: '',
  }
}

function rolesToPreset(roles: string[]): string {
  if (!roles || roles.length === 0) return 'all'
  if (roles.includes('admin') && roles.length === 1) return 'admin'
  if (roles.includes('teacher_exam') && !roles.includes('teacher')) return 'exam'
  return 'all'
}

function presetToRoles(preset: string): string[] {
  if (preset === 'exam') return ['teacher_exam']
  if (preset === 'admin') return ['admin']
  return ['teacher', 'teacher_exam']
}

function fileTypeLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'application/msword') return 'DOC'
  if (mimeType.includes('wordprocessingml')) return 'DOCX'
  if (mimeType === 'application/vnd.ms-powerpoint') return 'PPT'
  if (mimeType.includes('presentationml')) return 'PPTX'
  return mimeType.split('/')[1]?.toUpperCase() ?? 'FILE'
}

function DifficultyButton({ value, selected, onClick }: { value: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: selected ? '2px solid #FF8303' : '2px solid #e5e7eb',
        backgroundColor: selected ? '#FF8303' : 'white',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
        {[1, 2, 3].map(n => (
          <span key={n} style={{
            display: 'inline-block',
            width: '5px',
            height: n === 1 ? '5px' : n === 2 ? '9px' : '13px',
            borderRadius: '2px',
            backgroundColor: n <= value
              ? (selected ? 'white' : '#FF8303')
              : (selected ? 'rgba(255,255,255,0.35)' : '#e5e7eb'),
          }} />
        ))}
      </span>
      <span style={{ fontSize: '13px', color: selected ? 'white' : '#6b7280', fontWeight: 500 }}>
        {value === 1 ? 'Easy' : value === 2 ? 'Medium' : 'Hard'}
      </span>
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SheetFormModal({ sheet, onClose, onSaved }: Props) {
  const isEdit = sheet !== null

  // Stable ID for this sheet — used as storage path for file uploads
  const sheetId = useMemo(() => isEdit ? sheet!.id : crypto.randomUUID(), [])

  // ── Active tab ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<FormTab>('metadata')

  // ── Metadata fields ───────────────────────────────────────────────────────
  const [title, setTitle] = useState(sheet?.title ?? '')
  const [category, setCategory] = useState<'vocabulary' | 'grammar'>(
    (sheet?.category as 'vocabulary' | 'grammar') ?? 'vocabulary'
  )
  const [level, setLevel] = useState(sheet?.level ?? 'A1')
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>((sheet?.difficulty as 1 | 2 | 3) ?? 1)
  const [introText, setIntroText] = useState(sheet?.intro_text ?? '')

  // ── Vocabulary rows ───────────────────────────────────────────────────────
  const [words, setWords] = useState<WordRow[]>(() => {
    const existing = sheet?.content?.words
    return existing && existing.length > 0 ? existing : [newWordRow()]
  })

  // ── Exercise rows ─────────────────────────────────────────────────────────
  const [exercises, setExercises] = useState<ExerciseRow[]>(() => {
    const existing = sheet?.content?.exercises
    return existing && existing.length > 0 ? existing : []
  })

  // ── Attachments ───────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    const existing = sheet?.attachments
    return Array.isArray(existing) ? existing : []
  })
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Access control ────────────────────────────────────────────────────────
  const [rolesPreset, setRolesPreset] = useState<string>(
    rolesToPreset(sheet?.allowed_roles ?? [])
  )

  // ── Save state ────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Word helpers ──────────────────────────────────────────────────────────
  const updateWord = (id: string, field: keyof WordRow, value: string) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, [field]: value } : w))
  }

  const addWord = () => setWords(prev => [...prev, newWordRow()])

  const removeWord = (id: string) => {
    setWords(prev => prev.filter(w => w.id !== id))
  }

  const moveWord = (index: number, direction: 'up' | 'down') => {
    setWords(prev => {
      const next = [...prev]
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  // ── Exercise helpers ──────────────────────────────────────────────────────
  const updateExercise = (id: string, field: keyof Omit<ExerciseRow, 'options'>, value: string | number) => {
    setExercises(prev => prev.map(ex => ex.id === id ? { ...ex, [field]: value } : ex))
  }

  const updateOption = (exId: string, optIndex: number, value: string) => {
    setExercises(prev => prev.map(ex => {
      if (ex.id !== exId) return ex
      const opts: [string, string, string, string] = [...ex.options] as [string, string, string, string]
      opts[optIndex] = value
      return { ...ex, options: opts }
    }))
  }

  const addExercise = () => setExercises(prev => [...prev, newExerciseRow()])

  const removeExercise = (id: string) => setExercises(prev => prev.filter(ex => ex.id !== id))

  const moveExercise = (index: number, direction: 'up' | 'down') => {
    setExercises(prev => {
      const next = [...prev]
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  // ── File upload helpers ───────────────────────────────────────────────────
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    setUploadError(null)

    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setUploadError(`"${file.name}" is not a supported file type. Please upload PDF, DOC, DOCX, PPT, or PPTX files.`)
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        setUploadError(`"${file.name}" exceeds the 10 MB limit.`)
        continue
      }

      setUploading(true)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('sheet_id', sheetId)

      const res = await fetch('/api/admin/library/upload', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setUploadError(body.error ?? `Failed to upload "${file.name}". Please try again.`)
        setUploading(false)
        break
      }

      const data: Attachment = await res.json()
      setAttachments(prev => [...prev, data])
      setUploading(false)
    }

    // Reset file input so the same file can be re-selected if needed
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleFileRemove = async (attachment: Attachment) => {
    // Optimistically remove from UI
    setAttachments(prev => prev.filter(a => a.url !== attachment.url))

    // Fire-and-forget storage deletion
    fetch('/api/admin/library/upload', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet_id: sheetId, filename: attachment.name }),
    }).catch(() => {/* ignore */})
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required.'); setActiveTab('metadata'); return }
    if (!level) { setError('Level is required.'); setActiveTab('metadata'); return }

    setSaving(true)
    setError(null)

    const content: SheetContent = {
      words: category === 'vocabulary' ? words.filter(w => w.word.trim()) : [],
      exercises: exercises.filter(ex => ex.question.trim()),
    }

    const payload: Record<string, unknown> = {
      title: title.trim(),
      category,
      level,
      difficulty,
      intro_text: introText.trim() || null,
      content,
      allowed_roles: presetToRoles(rolesPreset),
      is_active: true,
      attachments,
    }

    // For create mode, supply the pre-generated ID so storage paths align
    if (!isEdit) {
      payload.id = sheetId
    }

    const url = isEdit ? `/api/admin/library/${sheet!.id}` : '/api/admin/library'
    const method = isEdit ? 'PATCH' : 'POST'

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'Something went wrong. Please try again.')
      setSaving(false)
      return
    }

    setSaving(false)
    await onSaved()
  }

  // ── Tab bar ───────────────────────────────────────────────────────────────
  const tabs: { key: FormTab; label: string }[] = [
    { key: 'metadata', label: 'Metadata' },
    { key: 'vocabulary', label: `Vocabulary (${words.length})` },
    { key: 'exercises', label: `Exercises (${exercises.length})` },
    { key: 'files', label: `Files (${attachments.length})` },
    { key: 'access', label: 'Access' },
  ]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900">
            {isEdit ? 'Edit Study Sheet' : 'New Study Sheet'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-6 pt-4 border-b border-gray-200 flex-shrink-0">
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors"
              style={activeTab === tab.key
                ? { backgroundColor: '#FF8303', color: 'white' }
                : { color: '#4b5563' }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-5">

          {/* ── METADATA TAB ── */}
          {activeTab === 'metadata' && (
            <div className="space-y-5">

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Business Email Vocabulary"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                  <select
                    value={category}
                    onChange={e => setCategory(e.target.value as 'vocabulary' | 'grammar')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
                  >
                    <option value="vocabulary">Vocabulary</option>
                    <option value="grammar">Grammar</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Level *</label>
                  <select
                    value={level}
                    onChange={e => setLevel(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
                  >
                    {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Difficulty *</label>
                <div className="flex gap-2">
                  {([1, 2, 3] as const).map(n => (
                    <DifficultyButton
                      key={n}
                      value={n}
                      selected={difficulty === n}
                      onClick={() => setDifficulty(n)}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Introduction / Learning Objectives
                </label>
                <textarea
                  value={introText}
                  onChange={e => setIntroText(e.target.value)}
                  placeholder="Briefly describe what students will learn from this sheet…"
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none"
                />
              </div>
            </div>
          )}

          {/* ── VOCABULARY TAB ── */}
          {activeTab === 'vocabulary' && (
            <div className="space-y-4">
              {category !== 'vocabulary' && (
                <p className="text-sm text-gray-400 italic">
                  Vocabulary lists are for Vocabulary sheets only. Switch the category on the Metadata tab if needed.
                </p>
              )}
              {category === 'vocabulary' && (
                <>
                  {/* Column headers */}
                  <div className="grid text-xs font-medium text-gray-400 uppercase gap-2"
                    style={{ gridTemplateColumns: '1.5rem 1.5fr 6rem 2fr 2fr 1.5rem 1.5rem 1.5rem' }}>
                    <span>#</span>
                    <span>Word</span>
                    <span>Part of speech</span>
                    <span>Definition</span>
                    <span>Example sentence</span>
                    <span />
                    <span />
                    <span />
                  </div>

                  {words.map((w, i) => (
                    <div key={w.id} className="grid gap-2 items-start"
                      style={{ gridTemplateColumns: '1.5rem 1.5fr 6rem 2fr 2fr 1.5rem 1.5rem 1.5rem' }}>
                      <span className="text-xs text-gray-400 pt-2 text-center">{i + 1}</span>
                      <input
                        type="text"
                        value={w.word}
                        onChange={e => updateWord(w.id, 'word', e.target.value)}
                        placeholder="Word"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={w.pos}
                        onChange={e => updateWord(w.id, 'pos', e.target.value)}
                        placeholder="noun, verb…"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={w.definition}
                        onChange={e => updateWord(w.id, 'definition', e.target.value)}
                        placeholder="Definition"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={w.example}
                        onChange={e => updateWord(w.id, 'example', e.target.value)}
                        placeholder="Example sentence"
                        className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                      />
                      <button
                        type="button"
                        onClick={() => moveWord(i, 'up')}
                        disabled={i === 0}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm pt-1.5"
                        title="Move up"
                      >↑</button>
                      <button
                        type="button"
                        onClick={() => moveWord(i, 'down')}
                        disabled={i === words.length - 1}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm pt-1.5"
                        title="Move down"
                      >↓</button>
                      <button
                        type="button"
                        onClick={() => removeWord(w.id)}
                        disabled={words.length === 1}
                        className="text-red-400 hover:text-red-600 disabled:opacity-20 text-sm pt-1.5"
                        title="Remove row"
                      >✕</button>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addWord}
                    className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 hover:border-orange-300 w-full justify-center"
                  >
                    + Add word
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── EXERCISES TAB ── */}
          {activeTab === 'exercises' && (
            <div className="space-y-6">
              {exercises.length === 0 && (
                <p className="text-sm text-gray-400">
                  No exercises yet. Click Add Question to create the first one.
                </p>
              )}

              {exercises.map((ex, i) => (
                <div key={ex.id} className="border border-gray-200 rounded-lg p-4 space-y-3">

                  {/* Exercise header */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-400 uppercase">Question {i + 1}</span>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => moveExercise(i, 'up')} disabled={i === 0}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm">↑</button>
                      <button type="button" onClick={() => moveExercise(i, 'down')} disabled={i === exercises.length - 1}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm">↓</button>
                      <button type="button" onClick={() => removeExercise(ex.id)}
                        className="text-red-400 hover:text-red-600 text-sm">✕ Remove</button>
                    </div>
                  </div>

                  {/* Question text */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Question</label>
                    <input
                      type="text"
                      value={ex.question}
                      onChange={e => updateExercise(ex.id, 'question', e.target.value)}
                      placeholder="e.g. What does 'delegate' mean?"
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900"
                    />
                  </div>

                  {/* Answer options */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Options — click ✓ to mark the correct answer
                    </label>
                    <div className="space-y-2">
                      {ex.options.map((opt, optIdx) => (
                        <div key={optIdx} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => updateExercise(ex.id, 'correct_index', optIdx)}
                            className="w-7 h-7 rounded-full border-2 text-xs font-bold flex items-center justify-center flex-shrink-0 transition-colors"
                            style={ex.correct_index === optIdx
                              ? { backgroundColor: '#16a34a', borderColor: '#16a34a', color: 'white' }
                              : { borderColor: '#d1d5db', color: '#9ca3af' }}
                            title="Mark as correct"
                          >
                            {ex.correct_index === optIdx ? '✓' : String.fromCharCode(65 + optIdx)}
                          </button>
                          <input
                            type="text"
                            value={opt}
                            onChange={e => updateOption(ex.id, optIdx, e.target.value)}
                            placeholder={`Option ${String.fromCharCode(65 + optIdx)}`}
                            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-900"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Explanation */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Explanation (shown after student answers)
                    </label>
                    <textarea
                      value={ex.explanation}
                      onChange={e => updateExercise(ex.id, 'explanation', e.target.value)}
                      placeholder="Why is this the correct answer?"
                      rows={2}
                      className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-900 resize-none"
                    />
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addExercise}
                className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 hover:border-orange-300 w-full justify-center"
              >
                + Add question
              </button>
            </div>
          )}

          {/* ── FILES TAB ── */}
          {activeTab === 'files' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Attach PDF, Word, or PowerPoint files to this study sheet. Students can download them directly. Max 10 MB per file.
              </p>

              {/* Upload button */}
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS}
                  multiple
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 hover:border-orange-300 w-full justify-center disabled:opacity-50"
                >
                  {uploading ? (
                    <>
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Uploading…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Upload files
                    </>
                  )}
                </button>
                {uploadError && (
                  <p className="text-xs text-red-500 mt-2">{uploadError}</p>
                )}
              </div>

              {/* Attachment list */}
              {attachments.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No files attached yet.</p>
              ) : (
                <div className="space-y-2">
                  {attachments.map((att, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 bg-gray-50"
                    >
                      {/* File type badge */}
                      <span
                        className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0"
                        style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                      >
                        {fileTypeLabel(att.type)}
                      </span>

                      {/* Name + download */}
                      <span className="flex-1 min-w-0 text-sm text-gray-700 truncate">{att.name}</span>
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline flex-shrink-0"
                        style={{ color: '#FF8303' }}
                      >
                        Download
                      </a>

                      {/* Remove */}
                      <button
                        type="button"
                        onClick={() => handleFileRemove(att)}
                        className="text-red-400 hover:text-red-600 text-sm flex-shrink-0"
                        title="Remove file"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── ACCESS TAB ── */}
          {activeTab === 'access' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                Controls which teacher roles can see and assign this sheet on the Teacher Portal.
              </p>

              <div className="space-y-3">
                {[
                  {
                    value: 'all',
                    label: 'All Teachers',
                    description: 'Any teacher with an active account can see and assign this sheet.',
                    color: '#16a34a',
                  },
                  {
                    value: 'exam',
                    label: 'Teacher+Exam Only',
                    description: 'Only teachers with the Teacher+Exam role can access this sheet. Useful for exam prep content.',
                    color: '#2563eb',
                  },
                  {
                    value: 'admin',
                    label: 'Admin Only',
                    description: 'Not visible to any teacher. Admin can still assign it directly to students.',
                    color: '#6b7280',
                  },
                ].map(opt => (
                  <label
                    key={opt.value}
                    className="flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors"
                    style={{
                      borderColor: rolesPreset === opt.value ? opt.color : '#e5e7eb',
                      backgroundColor: rolesPreset === opt.value ? `${opt.color}08` : 'white',
                    }}
                  >
                    <input
                      type="radio"
                      name="access"
                      value={opt.value}
                      checked={rolesPreset === opt.value}
                      onChange={() => setRolesPreset(opt.value)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{opt.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 flex-shrink-0">
          {error && <p className="text-sm text-red-500">{error}</p>}
          {!error && <span />}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-50"
              style={{ backgroundColor: '#FF8303' }}
            >
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Sheet'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
