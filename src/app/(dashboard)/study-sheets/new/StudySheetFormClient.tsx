'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'

type Word = {
  word: string
  part_of_speech: string
  definition: string
  example: string
}

type Exercise = {
  question_text: string
  options: string[]
  correct_answer: string
  explanation: string
  duration_minutes: number
}

type Props = {
  mode: 'create'
}

const LEVELS = ['A1', 'A1+', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1', 'C1+', 'C2']
const CATEGORIES = ['vocabulary', 'grammar']

const emptyWord = (): Word => ({
  word: '',
  part_of_speech: '',
  definition: '',
  example: '',
})

const emptyExercise = (): Exercise => ({
  question_text: '',
  options: ['', '', '', ''],
  correct_answer: '',
  explanation: '',
  duration_minutes: 5,
})

export default function StudySheetFormClient({ mode }: Props) {
  const router = useRouter()
  const supabase = createClient()

  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('vocabulary')
  const [level, setLevel] = useState('B1')
  const [difficulty, setDifficulty] = useState(1)
  const [words, setWords] = useState<Word[]>([emptyWord()])
  const [exercises, setExercises] = useState<Exercise[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // ── Word helpers ──────────────────────────────────────────
  function updateWord(index: number, field: keyof Word, value: string) {
    setWords(prev => prev.map((w, i) => i === index ? { ...w, [field]: value } : w))
  }

  function addWord() {
    setWords(prev => [...prev, emptyWord()])
  }

  function removeWord(index: number) {
    setWords(prev => prev.filter((_, i) => i !== index))
  }

  // ── Exercise helpers ──────────────────────────────────────
  function updateExercise(index: number, field: keyof Exercise, value: string | number) {
    setExercises(prev => prev.map((ex, i) => i === index ? { ...ex, [field]: value } : ex))
  }

  function updateOption(exIndex: number, optIndex: number, value: string) {
    setExercises(prev => prev.map((ex, i) => {
      if (i !== exIndex) return ex
      const newOptions = [...ex.options]
      newOptions[optIndex] = value
      return { ...ex, options: newOptions }
    }))
  }

  function addExercise() {
    setExercises(prev => [...prev, emptyExercise()])
  }

  function removeExercise(index: number) {
    setExercises(prev => prev.filter((_, i) => i !== index))
  }

  // ── Save ──────────────────────────────────────────────────
  async function handleSave() {
    if (!title.trim()) {
      setError('Title is required.')
      return
    }

    setSaving(true)
    setError('')

    // Filter out blank words
    const cleanWords = words.filter(w => w.word.trim())

    // Insert the study sheet
    const { data: sheet, error: sheetError } = await supabase
      .from('study_sheets')
      .insert({
        title: title.trim(),
        category,
        level,
        difficulty,
        content: { words: cleanWords },
        is_active: true,
      })
      .select('id')
      .single()

    if (sheetError || !sheet) {
      setError('Failed to save study sheet. Please try again.')
      setSaving(false)
      return
    }

    // Insert exercises if any
    if (exercises.length > 0) {
      const cleanExercises = exercises
        .filter(ex => ex.question_text.trim())
        .map(ex => ({
          study_sheet_id: sheet.id,
          question_text: ex.question_text.trim(),
          options: ex.options.filter(o => o.trim()),
          correct_answer: ex.correct_answer,
          explanation: ex.explanation,
          duration_minutes: ex.duration_minutes,
        }))

      if (cleanExercises.length > 0) {
        const { error: exError } = await supabase
          .from('exercises')
          .insert(cleanExercises)

        if (exError) {
          setError('Sheet saved but exercises failed. Please edit the sheet to add them.')
          setSaving(false)
          return
        }
      }
    }

    router.push(`/study-sheets/${sheet.id}`)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">

      {/* Back */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Study Sheets
      </button>

      <h1 className="text-2xl font-semibold text-gray-900 mb-6">New Study Sheet</h1>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm border border-red-200">
          {error}
        </div>
      )}

      {/* ── Basic info ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Basic Information</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Business Email Vocabulary"
            />
          </div>

          <div className="flex gap-6 flex-wrap">
            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
              <div className="flex gap-2">
                {CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat)}
                    className="px-4 py-2 rounded-lg border text-sm capitalize"
                    style={
                      category === cat
                        ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                        : { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#374151' }
                    }
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Level */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Level</label>
              <div className="flex flex-wrap gap-1">
                {LEVELS.map(l => (
                  <button
                    key={l}
                    onClick={() => setLevel(l)}
                    className="px-3 py-1.5 rounded-md border text-sm"
                    style={
                      level === l
                        ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                        : { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#374151' }
                    }
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Difficulty */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Difficulty</label>
              <div className="flex gap-2">
                {[1, 2, 3].map(d => (
                  <button
                    key={d}
                    onClick={() => setDifficulty(d)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '3px',
                      padding: '6px 14px', borderRadius: '8px',
                      border: `1px solid ${difficulty === d ? '#FF8303' : '#e5e7eb'}`,
                      backgroundColor: difficulty === d ? '#FF8303' : 'white',
                      cursor: 'pointer',
                    }}
                  >
                    {[1, 2, 3].map(n => (
                      <span key={n} style={{ color: difficulty === d ? 'white' : (n <= d ? '#FF8303' : '#e5e7eb'), fontSize: '15px', lineHeight: 1 }}>●</span>
                    ))}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Vocabulary words ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Vocabulary List</h2>
          <button
            onClick={addWord}
            className="flex items-center gap-1 text-sm font-medium"
            style={{ color: '#FF8303' }}
          >
            <Plus className="w-4 h-4" />
            Add Word
          </button>
        </div>

        {words.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">No words added yet.</p>
        ) : (
          <div className="space-y-4">
            {words.map((word, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_2fr_2fr_36px] gap-3 items-start">
                <div>
                  {i === 0 && <label className="block text-xs text-gray-500 mb-1">Word</label>}
                  <Input
                    value={word.word}
                    onChange={e => updateWord(i, 'word', e.target.value)}
                    placeholder="e.g. endeavour"
                  />
                </div>
                <div>
                  {i === 0 && <label className="block text-xs text-gray-500 mb-1">Part of Speech</label>}
                  <Input
                    value={word.part_of_speech}
                    onChange={e => updateWord(i, 'part_of_speech', e.target.value)}
                    placeholder="e.g. verb"
                  />
                </div>
                <div>
                  {i === 0 && <label className="block text-xs text-gray-500 mb-1">Definition</label>}
                  <Input
                    value={word.definition}
                    onChange={e => updateWord(i, 'definition', e.target.value)}
                    placeholder="e.g. To try hard to achieve something"
                  />
                </div>
                <div>
                  {i === 0 && <label className="block text-xs text-gray-500 mb-1">Example Sentence</label>}
                  <Input
                    value={word.example}
                    onChange={e => updateWord(i, 'example', e.target.value)}
                    placeholder="e.g. We will endeavour to reply within 24 hours."
                  />
                </div>
                <div className={i === 0 ? 'mt-5' : ''}>
                  <button
                    onClick={() => removeWord(i)}
                    className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Exercises ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Exercises</h2>
          <button
            onClick={addExercise}
            className="flex items-center gap-1 text-sm font-medium"
            style={{ color: '#FF8303' }}
          >
            <Plus className="w-4 h-4" />
            Add Exercise
          </button>
        </div>

        {exercises.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            No exercises yet. Click Add Exercise to create a multiple choice question.
          </p>
        ) : (
          <div className="space-y-6">
            {exercises.map((ex, i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-700">Exercise {i + 1}</span>
                  <button
                    onClick={() => removeExercise(i)}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Question</label>
                    <Input
                      value={ex.question_text}
                      onChange={e => updateExercise(i, 'question_text', e.target.value)}
                      placeholder="e.g. Which word means 'to try hard to achieve something'?"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Answer Options (4)</label>
                    <div className="space-y-2">
                      {ex.options.map((opt, oi) => (
                        <div key={oi} className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`correct-${i}`}
                            checked={ex.correct_answer === opt && opt.trim() !== ''}
                            onChange={() => updateExercise(i, 'correct_answer', opt)}
                            className="mt-0.5"
                            title="Mark as correct answer"
                          />
                          <Input
                            value={opt}
                            onChange={e => updateOption(i, oi, e.target.value)}
                            placeholder={`Option ${oi + 1}`}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Select the radio button next to the correct answer.</p>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Explanation (shown after answering)</label>
                    <Input
                      value={ex.explanation}
                      onChange={e => updateExercise(i, 'explanation', e.target.value)}
                      placeholder="e.g. 'Endeavour' means to make a serious effort to achieve something."
                    />
                  </div>

                  <div className="w-32">
                    <label className="block text-xs text-gray-500 mb-1">Duration (minutes)</label>
                    <Input
                      type="number"
                      min={1}
                      value={ex.duration_minutes}
                      onChange={e => updateExercise(i, 'duration_minutes', parseInt(e.target.value) || 1)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving}
          style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
        >
          {saving ? 'Saving...' : 'Save Study Sheet'}
        </Button>
      </div>
    </div>
  )
}
