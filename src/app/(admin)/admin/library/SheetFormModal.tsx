'use client'

import { useState, useEffect } from 'react'
import { StudySheet, WordRow, ExerciseRow, SheetContent } from './LibraryAdminClient'

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  sheet: StudySheet | null   // null = create mode
  onClose: () => void
  onSaved: () => Promise<void>
}

type FormTab = 'metadata' | 'vocabulary' | 'exercises' | 'access'

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEVELS = ['A1', 'A1+', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1', 'C1+', 'C2']

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

function ChilliButton({ value, active, onClick }: { value: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg border text-sm transition-colors"
      style={active
        ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
        : { borderColor: '#d1d5db', color: '#6b7280' }}
    >
      {'🌶️'.repeat(value)}
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SheetFormModal({ sheet, onClose, onSaved }: Props) {
  const isEdit = sheet !== null

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

    const payload = {
      title: title.trim(),
      category,
      level,
      difficulty,
      intro_text: introText.trim() || null,
      content,
      allowed_roles: presetToRoles(rolesPreset),
      is_active: true,
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
                    <ChilliButton
                      key={n}
                      value={n}
                      active={difficulty === n}
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
