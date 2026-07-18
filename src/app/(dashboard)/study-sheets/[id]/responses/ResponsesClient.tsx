'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  AlertTriangle,
} from 'lucide-react'

export type QuestionResult = {
  qid: string
  questionText: string | null
  options: string[]
  studentAnswer: string | null
  correctAnswer: string | null
  isCorrect: boolean | null
  contentMismatch: boolean
}

export type ActivityResponses = {
  activityId: string
  activityTitle: string
  isGradable: boolean
  attempted: boolean
  score: number | null
  questions: QuestionResult[]
}

export type StudentResponses = {
  studentId: string
  studentName: string
  completed: boolean
  attemptedActivityCount: number
  totalActivityCount: number
  avgScore: number | null
  latestAssignedAt: string | null
  latestAttemptAt: string | null
  activities: ActivityResponses[]
}

type Props = {
  sheetTitle: string
  sheetCategory: string | null
  sheetLevel: string | null
  students: StudentResponses[]
}

// Locked portal palette.
const PRIMARY = '#FF8303'
const INCORRECT = '#FD5602'
const MISMATCH = '#FFB942'
const GREEN_BG = '#DCFCE7'
const GREEN_FG = '#15803D'

// Deterministic across the SSR/CSR boundary (explicit UTC, Intl only - no
// toISOString / toLocaleTimeString). Matches the UpcomingClassesClient pattern.
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d)
}

function StatusBadge({ student }: { student: StudentResponses }) {
  if (student.attemptedActivityCount === 0) {
    return (
      <span
        className="px-2 py-0.5 rounded-full text-xs font-medium"
        style={{ backgroundColor: '#f3f4f6', color: '#9ca3af' }}
      >
        Not started
      </span>
    )
  }
  if (student.completed) {
    return (
      <span
        className="px-2 py-0.5 rounded-full text-xs font-medium"
        style={{ backgroundColor: GREEN_BG, color: GREEN_FG }}
      >
        Completed
      </span>
    )
  }
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ backgroundColor: '#FFF3E0', color: PRIMARY }}
    >
      In progress
    </span>
  )
}

function QuestionRow({ q }: { q: QuestionResult }) {
  // Content changed since the attempt (NEW371): show the answer as-recorded and
  // flag it - never a correct/incorrect verdict against questions that moved.
  if (q.contentMismatch) {
    return (
      <div
        className="rounded-lg p-3"
        style={{ backgroundColor: '#FFF7EA', border: `1px solid ${MISMATCH}` }}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: MISMATCH }} />
          <div className="min-w-0">
            <p className="text-sm font-medium" style={{ color: '#111827' }}>
              {q.questionText ?? 'This question is no longer in the worksheet'}
            </p>
            <p className="text-sm mt-1" style={{ color: '#4b5563' }}>
              Answer given:{' '}
              <span style={{ color: '#111827' }}>{q.studentAnswer ?? 'No answer'}</span>
            </p>
            <p className="text-xs mt-1.5" style={{ color: '#92660A' }}>
              Content changed since this attempt - the answer shown may not match the current questions.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const correct = q.isCorrect === true
  const accent = correct ? GREEN_FG : INCORRECT
  const bg = correct ? '#F6FBF7' : '#FFF5F0'

  return (
    <div className="rounded-lg p-3" style={{ backgroundColor: bg, border: `1px solid ${accent}22` }}>
      <div className="flex items-start gap-2">
        {correct ? (
          <Check className="w-4 h-4 mt-0.5 shrink-0" style={{ color: GREEN_FG }} />
        ) : (
          <X className="w-4 h-4 mt-0.5 shrink-0" style={{ color: INCORRECT }} />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: '#111827' }}>
            {q.questionText ?? 'Question'}
          </p>
          <p className="text-sm mt-1" style={{ color: '#4b5563' }}>
            Answer given:{' '}
            <span style={{ color: correct ? GREEN_FG : INCORRECT, fontWeight: 500 }}>
              {q.studentAnswer ?? 'No answer'}
            </span>
          </p>
          {!correct && q.correctAnswer !== null && (
            <p className="text-sm mt-1" style={{ color: '#4b5563' }}>
              Correct answer:{' '}
              <span style={{ color: GREEN_FG, fontWeight: 500 }}>{q.correctAnswer}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ActivityBlock({ activity, showAll }: { activity: ActivityResponses; showAll: boolean }) {
  if (!activity.attempted) {
    return (
      <div className="py-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium" style={{ color: '#111827' }}>
            {activity.activityTitle}
          </span>
          <span className="text-xs" style={{ color: '#9ca3af' }}>
            {activity.isGradable ? 'Not started' : 'Not an auto-graded activity'}
          </span>
        </div>
      </div>
    )
  }

  const visible = showAll
    ? activity.questions
    : activity.questions.filter(q => q.isCorrect !== true)

  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: '#111827' }}>
          {activity.activityTitle}
        </span>
        {activity.score !== null && (
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: '#f3f4f6', color: '#4b5563' }}
          >
            Score {activity.score}%
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-xs" style={{ color: '#9ca3af' }}>
          Every answer was correct.
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map(q => (
            <QuestionRow key={q.qid} q={q} />
          ))}
        </div>
      )}
    </div>
  )
}

function StudentRow({ student }: { student: StudentResponses }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const canExpand = student.attemptedActivityCount > 0

  return (
    <div className="rounded-xl shadow-sm" style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6' }}>
      <button
        type="button"
        onClick={() => canExpand && setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        style={{ cursor: canExpand ? 'pointer' : 'default' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          {canExpand ? (
            open ? (
              <ChevronDown className="w-4 h-4 shrink-0" style={{ color: '#9ca3af' }} />
            ) : (
              <ChevronRight className="w-4 h-4 shrink-0" style={{ color: '#9ca3af' }} />
            )
          ) : (
            <span className="w-4 h-4 shrink-0" />
          )}
          <span className="font-medium text-sm truncate" style={{ color: '#111827' }}>
            {student.studentName}
          </span>
          <StatusBadge student={student} />
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-xs" style={{ color: '#4b5563' }}>
            {student.attemptedActivityCount}/{student.totalActivityCount} activities
          </span>
          <span className="text-sm font-semibold" style={{ color: '#111827', minWidth: '52px', textAlign: 'right' }}>
            {student.avgScore !== null ? `${student.avgScore}%` : '—'}
          </span>
          <span className="text-xs hidden sm:inline" style={{ color: '#9ca3af', minWidth: '96px', textAlign: 'right' }}>
            {student.latestAttemptAt ? formatDate(student.latestAttemptAt) : '—'}
          </span>
        </div>
      </button>

      {open && canExpand && (
        <div style={{ borderTop: '1px solid #f3f4f6' }} className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#9ca3af' }}>
              Responses
            </span>
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              className="text-xs font-medium px-2.5 py-1 rounded-md border"
              style={{ borderColor: '#E0DFDC', color: PRIMARY, backgroundColor: 'white' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#FFF7EA')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'white')}
            >
              {showAll ? 'Show only items to review' : 'Show all answers'}
            </button>
          </div>
          <div className="divide-y divide-gray-100">
            {student.activities.map(a => (
              <ActivityBlock key={a.activityId} activity={a} showAll={showAll} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ResponsesClient({ sheetTitle, sheetCategory, sheetLevel, students }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/study-sheets"
          prefetch={false}
          className="inline-flex items-center gap-1.5 text-sm mb-3"
          style={{ color: '#4b5563' }}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Study Library
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold" style={{ color: '#111827' }}>{sheetTitle}</h1>
            <p className="text-sm mt-1" style={{ color: '#4b5563' }}>Student responses</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {sheetCategory && (
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
                style={{ backgroundColor: '#f3f4f6', color: '#4b5563' }}
              >
                {sheetCategory}
              </span>
            )}
            {sheetLevel && (
              <span
                className="px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ backgroundColor: '#FFF3E0', color: PRIMARY }}
              >
                {sheetLevel}
              </span>
            )}
          </div>
        </div>
      </div>

      {students.length === 0 ? (
        <div
          className="rounded-xl px-6 py-12 text-center text-sm shadow-sm"
          style={{ backgroundColor: '#ffffff', border: '1px solid #f3f4f6', color: '#9ca3af' }}
        >
          No students have this worksheet assigned yet.
        </div>
      ) : (
        <div className="space-y-3">
          {students.map(s => (
            <StudentRow key={s.studentId} student={s} />
          ))}
        </div>
      )}
    </div>
  )
}
