'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ExternalLink, Upload, CheckCircle, UserPlus } from 'lucide-react'
import type { Annotation } from '@/components/pdf/PdfViewer'
import MaterialFileViewer from '@/components/study/MaterialFileViewer'
import DifficultyBars from '@/components/study/DifficultyBars'
import { categoryBadgeStyle } from '@/lib/study/categoryBadge'
import type { PreppedActivity } from '@/lib/study/prepActivities'
import AssignMaterialModal from './AssignMaterialModal'

type Word = {
  word: string
  part_of_speech: string
  definition: string
  example: string
}

type Attachment = {
  name: string
  url: string
  type: string
}

type StudySheet = {
  id: string
  title: string
  category: string | null
  level: string | null
  difficulty: number
  content: { words?: Word[] } | null
  attachments: Attachment[] | null
  audience: 'staff' | 'student'
  // Bodies of the listening / reading categories - same shapes the student
  // sheet view renders. Optional: a sheet in any other category carries
  // neither, and older rows may have them null.
  links?: { title: string; url: string }[] | null
  reading_text?: string | null
}

type Props = {
  sheet: StudySheet
  activities: PreppedActivity[]
  isAdmin: boolean
  isOwned: boolean
  annotationsByName: Record<string, Annotation[]>
  // The lesson the seeded marks above belong to (null: no class was live when
  // this page loaded). Forwarded to the annotatable viewer only, so an autosave
  // fired from a tab left open across a lesson change is refused server-side
  // instead of writing the previous class's marks onto the new one.
  liveLessonId: string | null
  live?: boolean
}

const TYPE_LABELS: Record<string, string> = {
  mcq: 'Multiple choice',
  gap_fill: 'Gap fill',
  matching: 'Matching',
  reorder: 'Reorder',
  flashcards: 'Flashcards',
  listening: 'Listening',
  writing_task: 'Writing task',
  speaking_task: 'Speaking task',
  scenario: 'Scenario',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ')
}

// Static teacher-facing prep card: the resolved activity with its correct
// answer marked. In the (live) window the correctAnswer/explanation are null
// (never resolved), so nothing here reveals the key.
function ActivityCard({ activity }: { activity: PreppedActivity }) {
  return (
    <div className="rounded-xl p-5 bg-white shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {activity.title && <h3 className="font-medium text-gray-900">{activity.title}</h3>}
        <span
          className="px-2 py-0.5 rounded-full text-xs font-medium"
          style={{ backgroundColor: '#f3f4f6', color: '#4b5563' }}
        >
          {typeLabel(activity.type)}
        </span>
      </div>

      {!activity.gradable ? (
        <p className="text-sm text-gray-400">Not an auto-graded activity — no preview available.</p>
      ) : (
        <div className="space-y-5">
          {activity.questions.map((q, qi) => (
            <div key={q.id}>
              <p className="font-medium text-gray-900 mb-3 text-sm">
                {qi + 1}. {q.text}
              </p>
              <div className="space-y-2">
                {q.options.map((opt) => {
                  const isCorrect =
                    q.correctAnswer !== null && opt.trim() === q.correctAnswer.trim()
                  return (
                    <div
                      key={opt}
                      className="px-4 py-2.5 rounded-lg border text-sm flex items-center gap-2"
                      style={
                        isCorrect
                          ? { backgroundColor: '#DCFCE7', borderColor: '#15803D', color: '#15803D' }
                          : { backgroundColor: '#ffffff', borderColor: '#e5e7eb', color: '#374151' }
                      }
                    >
                      {isCorrect && <CheckCircle size={14} className="flex-shrink-0" />}
                      {opt}
                    </div>
                  )
                })}
              </div>
              {q.explanation && (
                <div
                  className="rounded-lg p-3 text-sm mt-3"
                  style={{ backgroundColor: '#FFFBEB', borderLeft: '4px solid #FFB942', color: '#92400e' }}
                >
                  {q.explanation}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StudySheetDetailClient({
  sheet,
  activities,
  isOwned,
  annotationsByName,
  liveLessonId,
  live = false,
}: Props) {
  const router = useRouter()
  const words: Word[] = sheet.content?.words ?? []
  const attachments = sheet.attachments ?? []
  const isTeachingMaterial = sheet.audience === 'staff'

  // Listening / reading bodies, derived defensively: the columns are free-form
  // (jsonb / text) and this file must not depend on the admin route's
  // normaliser, so entries without a usable title AND url are dropped rather
  // than rendered as blank rows, and the passage is only treated as present
  // when it is a non-empty string.
  const links = (Array.isArray(sheet.links) ? sheet.links : []).filter(
    (l) =>
      typeof l?.title === 'string' &&
      l.title.trim().length > 0 &&
      typeof l?.url === 'string' &&
      l.url.trim().length > 0
  )
  const readingText = typeof sheet.reading_text === 'string' ? sheet.reading_text.trim() : ''

  // File management is owner-only and hidden inside the chrome-free live window
  // (a mid-class upload/delete makes no sense there and keeps the shared,
  // screen-visible surface read-only).
  const canManageFiles = isOwned && !live

  const [assignOpen, setAssignOpen] = useState(false)

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    setRemoveError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('sheet_id', sheet.id)
      const res = await fetch('/api/teacher/library/upload', { method: 'POST', body: fd })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Upload failed')
      }
      router.refresh()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleRemove(idx: number) {
    const att = attachments[idx]
    if (!att) return
    if (!window.confirm(`Remove "${att.name}"? This cannot be undone.`)) return
    setRemovingName(att.name)
    setRemoveError('')
    setUploadError('')
    try {
      const res = await fetch('/api/teacher/library/upload', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_id: sheet.id, filename: att.name }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Remove failed')
      }
      router.refresh()
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemovingName(null)
    }
  }

  return (
    <div className={live ? 'space-y-6 p-6 max-w-5xl mx-auto' : 'space-y-6'}>

      {/* Back button - hidden in the live window (NEW255 c-ii): in the chrome-free
          (live) route it would navigate into the chromed dashboard mid-class. */}
      {!live && (
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Study Sheets
        </button>
      )}

      {/* Header */}
      <div className="bg-white rounded-xl p-6 shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">{sheet.title}</h1>
            <div className="flex items-center gap-3">
              {sheet.category && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                  style={categoryBadgeStyle(sheet.category)}
                >
                  {sheet.category}
                </span>
              )}
              {sheet.level && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                >
                  {sheet.level}
                </span>
              )}
              {sheet.difficulty != null && <DifficultyBars count={sheet.difficulty} />}
            </div>
          </div>
          {/* Live window entry - prep page only (NEW255 d). Opens the chrome-free
              (live) page in a named popup so the teacher can window-share just the
              PDF in Teams. Hidden in the live window itself via the same {!live} gate. */}
          {!live && (
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Assign teaching material as homework. Gated on audience='staff'
                  only, deliberately NOT on isOwned: the material_assignments
                  INSERT policy decides who may assign, and admin-library
                  materials (owner_id null) are assignable by design. */}
              {isTeachingMaterial && (
                <button
                  type="button"
                  onClick={() => setAssignOpen(true)}
                  className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md flex-shrink-0 transition-opacity hover:opacity-80"
                  style={{ color: '#FF8303', border: '1px solid #FF8303', backgroundColor: '#fff7ed' }}
                  title="Assign a PDF from this sheet to one of your students"
                >
                  <UserPlus className="w-4 h-4" />
                  Assign to student
                </button>
              )}
              <button
                type="button"
                onClick={() => window.open(`/live-annotate/${sheet.id}`, 'live-annotate', 'popup')}
                className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md flex-shrink-0 transition-opacity hover:opacity-80"
                style={{ color: '#FF8303', border: '1px solid #FF8303', backgroundColor: '#fff7ed' }}
                title="Open this sheet in a separate window to screen-share in Teams"
              >
                <ExternalLink className="w-4 h-4" />
                Open Live Window
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Files — its own titled card, above the vocabulary list */}
      <div className="bg-white rounded-xl shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">Files</h2>
            <p className="text-sm text-gray-500 mt-0.5">Attached materials</p>
          </div>
          {canManageFiles && (
            <label
              className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md flex-shrink-0 cursor-pointer transition-opacity hover:opacity-80"
              style={{ color: '#FF8303', border: '1px solid #FF8303', backgroundColor: '#fff7ed' }}
              title="Upload a PDF, DOC, DOCX, PPT or PPTX"
            >
              <Upload className="w-4 h-4" />
              {uploading ? 'Uploading…' : 'Add file'}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.ppt,.pptx"
                disabled={uploading}
                onChange={handleUpload}
              />
            </label>
          )}
        </div>
        <div className="p-6">
          {attachments.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-6">
              No files attached{canManageFiles ? '. Use “Add file” to upload one.' : '.'}
            </p>
          ) : (
            <MaterialFileViewer
              attachments={attachments}
              sheetId={sheet.id}
              mode="annotatable"
              annotationsByName={annotationsByName}
              liveLessonId={liveLessonId}
              cardClassName="rounded-lg overflow-hidden bg-white"
              cardStyle={{ border: '1px solid #E0DFDC' }}
              onRemove={canManageFiles ? handleRemove : undefined}
              removingName={removingName}
            />
          )}
          {(uploadError || removeError) && (
            <p className="text-sm mt-3" style={{ color: '#FD5602' }}>
              {uploadError || removeError}
            </p>
          )}
        </div>
      </div>

      {/* Links - the listening category's body, mirroring the student sheet view
          in this page's card shell. Same !isTeachingMaterial gate as the
          vocabulary/activities sections: staff sheets are lesson PDFs. */}
      {!isTeachingMaterial && sheet.category === 'listening' && links.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Links</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {links.length} {links.length === 1 ? 'link' : 'links'}
            </p>
          </div>
          <div className="p-6 space-y-3">
            {links.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-3 rounded-lg p-4 transition-shadow hover:shadow"
                style={{ border: '1px solid #E0DFDC' }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{l.title}</p>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{l.url}</p>
                </div>
                <ExternalLink className="w-4 h-4 flex-shrink-0 text-gray-400" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Reading passage - the reading category's body. whitespace-pre-wrap so the
          paragraph breaks the author typed survive the render. */}
      {!isTeachingMaterial && sheet.category === 'reading' && readingText.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Reading passage</h2>
            <p className="text-sm text-gray-500 mt-0.5">Text for this sheet</p>
          </div>
          <div className="p-6">
            <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              {readingText}
            </div>
          </div>
        </div>
      )}

      {/* Vocabulary table - teaching-material sheets (audience='staff') are lesson
          PDFs; vocabulary/activities do not apply and are hidden entirely. */}
      {!isTeachingMaterial && words.length > 0 && (
        <div className="bg-white rounded-xl overflow-hidden shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Vocabulary List</h2>
            <p className="text-sm text-gray-500 mt-0.5">{words.length} words</p>
          </div>
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Word</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Part of Speech</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Definition</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Example</th>
              </tr>
            </thead>
            <tbody>
              {words.map((word, i) => (
                <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900 text-sm">{word.word}</td>
                  <td className="px-6 py-4 text-sm text-gray-500 italic">{word.part_of_speech}</td>
                  <td className="px-6 py-4 text-sm text-gray-700">{word.definition}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">&ldquo;{word.example}&rdquo;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Activities section (canonical activities table; replaces legacy exercises) */}
      {!isTeachingMaterial && (
        <div>
          <h2 className="font-semibold text-gray-900 mb-4">
            Activities
            <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold align-middle" style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}>{activities.length}</span>
          </h2>

          {activities.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm px-6 py-12 text-center text-gray-400 text-sm" style={{ border: '1px solid #f3f4f6' }}>
              No activities yet
            </div>
          ) : (
            <div className="space-y-4">
              {activities.map((activity) => (
                <ActivityCard key={activity.id} activity={activity} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mounted only while open, so its GET never fires on a normal prep-page
          load - and never at all in the live window, where the button is gated
          out entirely. */}
      {assignOpen && (
        <AssignMaterialModal
          sheetId={sheet.id}
          sheetTitle={sheet.title}
          attachments={attachments}
          onClose={() => setAssignOpen(false)}
        />
      )}
    </div>
  )
}
