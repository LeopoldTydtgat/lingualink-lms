'use client'

import React, { useState } from 'react'
import { format } from 'date-fns'
import { useRouter } from 'next/navigation'
import AssignStudySheetsModal from '@/components/shared/AssignStudySheetsModal'
import { submitReport } from '../actions'

// --- Types ---

type Student = {
  id: string
  full_name: string
  photo_url: string | null
}

type Lesson = {
  id: string
  scheduled_at: string
  duration_minutes: number
  student: Student
  teacher: { id: string; full_name: string }
}

type Report = {
  id: string
  status: string
  did_class_happen: boolean | null
  no_show_type: string | null
  feedback_text: string | null
  additional_details: string | null
  level_data: Record<string, string> | null
  student_confirmed: boolean | null
  impersonation_note: string | null
  deadline_at: string | null
  completed_at: string | null
  flagged_at: string | null
  lesson: Lesson
}

type Props = {
  report: Report
  profile: { id: string; full_name: string; role: string }
  isAdmin: boolean
  assignedSheetIds: string[]
  assignedSheets: { id: string; title: string }[]
}

const CEFR_LEVELS = [
  'A1',
  'A2',
  'B1',
  'B2',
  'C1',
  'C2',
]

const SKILLS = [
  { key: 'grammar', label: 'Grammar' },
  { key: 'expression', label: 'Expression' },
  { key: 'comprehension', label: 'Comprehension' },
  { key: 'vocabulary', label: 'Vocabulary' },
  { key: 'accent', label: 'Accent' },
  { key: 'overall_spoken', label: 'Overall Spoken Level' },
  { key: 'overall_written', label: 'Overall Written Level' },
]

const CEFR_DESCRIPTIONS: Record<string, string> = {
  A1: 'Can understand and use very basic expressions. Introduces themselves and asks/answers simple questions.',
  A2: 'Can understand sentences on familiar topics. Communicates in simple routine tasks.',
  B1: 'Can understand main points on familiar matters. Can deal with most travel situations. Produces simple connected text.',
  B2: 'Can understand complex text on concrete and abstract topics. Communicates with a degree of fluency and spontaneity.',
  C1: 'Can understand demanding, longer texts. Expresses ideas fluently and spontaneously without much searching.',
  C2: 'Can understand virtually everything heard or read. Expresses themselves spontaneously, very fluently and precisely.',
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; fg: string }> = {
  completed: { label: 'Report submitted', bg: '#DCFCE7', fg: '#15803D' },
  pending: { label: 'Pending', bg: '#FFF8E8', fg: '#B45309' },
  flagged: { label: 'Flagged — overdue', bg: '#FFEEE6', fg: '#FD5602' },
  reopened: { label: 'Reopened by admin', bg: '#FFF0E0', fg: '#C2410C' },
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
      <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
      <h2 style={{ fontSize: '15px', fontWeight: '600', color: '#111827', margin: 0 }}>{children}</h2>
    </div>
  )
}

const cardStyle: React.CSSProperties = { border: '1px solid #f3f4f6' }
const cardClass = 'bg-white rounded-xl shadow-sm p-5 mb-6'

function LevelTrack({
  value,
  onChange,
  editable,
}: {
  value: string | undefined
  onChange?: (level: string) => void
  editable: boolean
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const selectedIndex = value ? CEFR_LEVELS.indexOf(value) : -1

  return (
    <div className="flex flex-1" style={{ maxWidth: `${CEFR_LEVELS.length * 72}px` }}>
      {CEFR_LEVELS.map((level, i) => {
        const isFilled = selectedIndex >= 0 && i <= selectedIndex
        const isSelected = i === selectedIndex
        const isHovered = editable && !isFilled && hoverIndex === i

        const style: React.CSSProperties = {
          position: 'relative',
          zIndex: isSelected ? 1 : 0,
          flex: 1,
          maxWidth: '72px',
          height: '36px',
          marginLeft: i === 0 ? 0 : '-1px',
          border: '1px solid',
          borderColor: isSelected ? '#FF8303' : isFilled ? '#FFD9A8' : '#d1d5db',
          backgroundColor: isFilled ? '#FFF3E0' : isHovered ? '#FAFAFA' : 'white',
          color: isFilled ? '#FF8303' : '#9CA3AF',
          fontWeight: isSelected ? 700 : 600,
        }

        return (
          <button
            key={level}
            type="button"
            disabled={!editable}
            onClick={() => onChange?.(level)}
            onMouseEnter={() => editable && !isFilled && setHoverIndex(i)}
            onMouseLeave={() => editable && setHoverIndex(null)}
            style={style}
            className={[
              'flex items-center justify-center text-xs font-semibold transition-colors',
              i === 0 ? 'rounded-l-lg' : '',
              i === CEFR_LEVELS.length - 1 ? 'rounded-r-lg' : '',
              editable ? 'cursor-pointer' : 'cursor-default',
            ].join(' ')}
          >
            {level}
          </button>
        )
      })}
    </div>
  )
}

export default function ReportFormClient({ report, profile, isAdmin, assignedSheetIds, assignedSheets }: Props) {
  const router = useRouter()

  const lesson = report.lesson
  const student = lesson?.student

  const [didClassHappen, setDidClassHappen] = useState<boolean | null>(report.did_class_happen)
  const [noShowType, setNoShowType] = useState<string>(report.no_show_type ?? '')
  const [feedbackText, setFeedbackText] = useState(report.feedback_text ?? '')
  const [additionalDetails, setAdditionalDetails] = useState(report.additional_details ?? '')
  const [levelData, setLevelData] = useState<Record<string, string>>(report.level_data ?? {})
  const [studentConfirmed, setStudentConfirmed] = useState<boolean>(
    report.student_confirmed ?? true
  )
  const [impersonationNote, setImpersonationNote] = useState<string>(
    report.impersonation_note ?? ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [currentAssignedIds, setCurrentAssignedIds] = useState<string[]>(assignedSheetIds)
  const [currentAssignedSheets, setCurrentAssignedSheets] = useState<{ id: string; title: string }[]>(assignedSheets)
  const [showGuide, setShowGuide] = useState(false)

  const isEditable = report.status === 'pending' || report.status === 'reopened'
  const statusInfo = STATUS_CONFIG[report.status] ?? STATUS_CONFIG.pending

  function setSkillLevel(skillKey: string, level: string) {
    setLevelData(prev => ({ ...prev, [skillKey]: level }))
  }

  async function handleSave() {
    if (didClassHappen === null) {
      setError('Please select whether the class took place.')
      return
    }
    if (!didClassHappen && !noShowType) {
      setError('Please select what happened.')
      return
    }
    if (!didClassHappen && !additionalDetails.trim()) {
      setError('Please provide additional details about what happened.')
      return
    }
    // If teacher unchecked the confirmation, require a note
    if (didClassHappen && !studentConfirmed && !impersonationNote.trim()) {
      setError('Please provide a note about who attended the class.')
      return
    }
    if (didClassHappen && feedbackText.trim().length < 150) {
      // No setError here: the inline counter beneath the recap field already shows this
      // message in the right place. The shared banner sits at the bottom (under Additional
      // Details) and would misleadingly read as if Additional Details were at fault.
      return
    }

    setSaving(true)
    setError(null)

    const result = await submitReport(report.id, {
      did_class_happen: didClassHappen,
      no_show_type: didClassHappen ? null : (noShowType as 'student' | 'teacher'),
      feedback_text: didClassHappen ? feedbackText : null,
      additional_details: additionalDetails || null,
      level_data: didClassHappen ? levelData : null,
      student_confirmed: didClassHappen ? studentConfirmed : null,
      impersonation_note: didClassHappen && !studentConfirmed ? impersonationNote : null,
    })

    setSaving(false)

    if (result.error) {
      setError(result.error)
      console.error('submitReport failed:', result.error)
      return
    }

    router.push('/reports')
    router.refresh()
  }

  return (
    <div className="p-6">

      <a
        href="/reports"
        className="text-sm text-gray-500 hover:text-gray-700 mb-6 inline-block"
      >
        &larr; Back to reports
      </a>

      {/* Header card */}
      <div className={cardClass} style={cardStyle}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            {student?.photo_url ? (
              <img
                src={student.photo_url}
                alt={student.full_name}
                className="w-14 h-14 rounded-full object-cover"
              />
            ) : (
              <div className="w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-xl">
                {student?.full_name?.charAt(0) ?? '?'}
              </div>
            )}
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {student?.full_name ?? 'Unknown student'}
              </h1>
              <p className="text-sm text-gray-500">
                {lesson?.scheduled_at
                  ? format(new Date(lesson.scheduled_at), 'EEEE d MMMM yyyy · HH:mm')
                  : 'Unknown time'}
                {' · '}
                {lesson?.duration_minutes ?? 60} min
              </p>
            </div>
          </div>
          <div className="text-right">
            <span
              className="text-xs font-semibold px-2.5 py-0.5 rounded-full"
              style={{ backgroundColor: statusInfo.bg, color: statusInfo.fg }}
            >
              {statusInfo.label}
            </span>
            {report.status === 'completed' && report.completed_at && (
              <p className="text-xs text-gray-400 mt-1">
                Submitted on {format(new Date(report.completed_at), 'd MMM yyyy · HH:mm')}
              </p>
            )}
            {isAdmin && report.status === 'flagged' && (
              <p className="text-xs text-gray-400 mt-1">
                As admin you can reopen this report from the reports list.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Did the class take place? (+ Student Confirmation sub-block) */}
      <section className={cardClass} style={cardStyle}>
        <SectionHeader>Did the class take place?</SectionHeader>
        <div className="flex gap-3">
          <button
            disabled={!isEditable}
            onClick={() => setDidClassHappen(true)}
            style={
              didClassHappen === true
                ? { backgroundColor: '#FFF3E0', color: '#FF8303', borderColor: '#FFD9A8' }
                : { backgroundColor: 'white', color: '#374151', borderColor: '#d1d5db' }
            }
            className="px-6 py-2 rounded-lg text-sm font-semibold border transition-colors"
          >
            Yes
          </button>
          <button
            disabled={!isEditable}
            onClick={() => setDidClassHappen(false)}
            style={
              didClassHappen === false
                ? { backgroundColor: '#fff1f0', color: '#FD5602', borderColor: '#FD5602' }
                : { backgroundColor: 'white', color: '#374151', borderColor: '#d1d5db' }
            }
            className="px-6 py-2 rounded-lg text-sm font-semibold border transition-colors"
          >
            No
          </button>
        </div>

        {didClassHappen === true && (
          <div style={{ borderTop: '1px solid #f3f4f6', marginTop: '20px', paddingTop: '20px' }}>
            <p style={{ fontSize: '13px', fontWeight: 600, color: '#111827', marginBottom: '8px' }}>
              Student Confirmation
            </p>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                disabled={!isEditable}
                checked={studentConfirmed}
                onChange={e => {
                  setStudentConfirmed(e.target.checked)
                  if (e.target.checked) setImpersonationNote('')
                }}
                className="mt-0.5 w-4 h-4 rounded accent-orange-500 cursor-pointer"
              />
              <span className="text-sm text-gray-700">
                I confirm that <strong>{student?.full_name ?? 'the student'}</strong> personally
                attended this class.
              </span>
            </label>

            {/* Note field — shown only when unchecked */}
            {!studentConfirmed && (
              <div className="mt-4">
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 mb-3">
                  Please make a note of who attended and report this to admin or your teacher
                  advisor as soon as possible.
                </div>
                <textarea
                  disabled={!isEditable}
                  value={impersonationNote}
                  onChange={e => setImpersonationNote(e.target.value)}
                  rows={3}
                  placeholder="Who attended this class instead? Please provide as much detail as possible..."
                  className={[
                    'w-full border border-amber-300 rounded-xl px-4 py-3 text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none',
                    !isEditable ? 'bg-gray-50 text-gray-500' : 'bg-white',
                  ].join(' ')}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {/* YES — class happened */}
      {didClassHappen === true && (
        <>
          {/* Feedback box */}
          <section className={cardClass} style={cardStyle}>
            <SectionHeader>Class Recap, Feedback &amp; Next Steps</SectionHeader>
            <p className="text-xs text-gray-500 mb-3">
              This will appear as the recap on the next class card.
            </p>
            {isEditable ? (
              <>
                <textarea
                  disabled={!isEditable}
                  value={feedbackText}
                  onChange={e => setFeedbackText(e.target.value)}
                  rows={5}
                  maxLength={1000}
                  placeholder="Summarise what was covered, how the student performed, and what to focus on next time..."
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none"
                />
                <p className="text-xs text-gray-400 text-right mt-1">{feedbackText.length} / 1000</p>
              </>
            ) : (
              <p className="whitespace-pre-wrap text-sm text-gray-700">{feedbackText}</p>
            )}
            {isEditable && feedbackText.trim().length < 150 && (
              <p className="text-xs text-red-500 mt-1">
                Minimum 150 characters required ({150 - feedbackText.trim().length} remaining)
              </p>
            )}
          </section>

          {/* Study sheet assignment */}
          <section className={cardClass} style={cardStyle}>
            <SectionHeader>Study Sheets for Next Time</SectionHeader>
            <p className="text-xs text-gray-500 mb-3">
              Assign vocabulary or grammar sheets for the student to review.
            </p>
            {currentAssignedIds.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {currentAssignedIds.map(id => {
                  const sheet = currentAssignedSheets.find(s => s.id === id)
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center rounded-full text-xs font-medium px-3 py-1"
                      style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                    >
                      {sheet?.title ?? 'Unknown sheet'}
                    </span>
                  )
                })}
              </div>
            )}
            {isEditable && (
              <button
                onClick={() => setShowAssignModal(true)}
                className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border transition-colors"
                style={{ color: '#FF8303', borderColor: '#FFD9A8', backgroundColor: '#FFF3E0' }}
              >
                + Assign Study Sheets
              </button>
            )}
          </section>

          {/* Student level assessment */}
          <section className={cardClass} style={cardStyle}>
            <SectionHeader>Student Level Assessment</SectionHeader>
            <p className="text-xs text-gray-500 mb-4">Select a CEFR level for each skill.</p>

            {/* Collapsible CEFR guide */}
            <div className="mb-5">
              <button
                type="button"
                onClick={() => setShowGuide(v => !v)}
                className="w-full flex items-center justify-between bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-left"
              >
                <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">CEFR Level Guide</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    color: '#6B7280',
                    transform: showGuide ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease',
                  }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showGuide && (
                <div className="bg-gray-50 border border-gray-200 border-t-0 rounded-b-xl p-4">
                  <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: '4px 8px', alignItems: 'start' }}>
                    {Object.entries(CEFR_DESCRIPTIONS).map(([level, desc]) => (
                      <React.Fragment key={level}>
                        <span className="text-xs font-bold text-gray-800">{level}</span>
                        <span className="text-xs text-gray-600">{desc}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              {SKILLS.map(skill => (
                <div key={skill.key} className="flex items-center gap-4">
                  <p className="w-40 flex-shrink-0 text-sm font-medium text-gray-700">{skill.label}</p>
                  <LevelTrack
                    value={levelData[skill.key]}
                    onChange={isEditable ? level => setSkillLevel(skill.key, level) : undefined}
                    editable={isEditable}
                  />
                  {!isEditable && (
                    levelData[skill.key] ? (
                      <span
                        className="inline-flex items-center rounded-full text-xs font-semibold px-3 py-1"
                        style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                      >
                        {levelData[skill.key]}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">Not assessed</span>
                    )
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* NO — class did not happen */}
      {didClassHappen === false && (
        <section className={cardClass} style={cardStyle}>
          <SectionHeader>What happened?</SectionHeader>
          <div className="flex flex-col gap-3 mb-4 mt-3">
            <button
              disabled={!isEditable}
              onClick={() => setNoShowType('student')}
              style={
                noShowType === 'student'
                  ? { borderColor: '#FFD9A8', backgroundColor: '#FFF3E0' }
                  : { backgroundColor: 'white', borderColor: '#d1d5db' }
              }
              className="text-left px-4 py-3 rounded-xl border text-sm transition-colors"
            >
              <p className="font-semibold text-gray-800">Student no-show</p>
            </button>
            <button
              disabled={!isEditable}
              onClick={() => setNoShowType('teacher')}
              style={
                noShowType === 'teacher'
                  ? { borderColor: '#FD5602', backgroundColor: '#fff1f0' }
                  : { backgroundColor: 'white', borderColor: '#d1d5db' }
              }
              className="text-left px-4 py-3 rounded-xl border text-sm transition-colors"
            >
              <p className="font-semibold text-gray-800">Teacher no-show</p>
            </button>
          </div>
          {noShowType === 'student' && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-sm text-orange-800 mb-4">
              Your student did not attend this class. You will still be paid for this session.
              Please contact your student as soon as possible to follow up and ensure this does
              not happen again. You are required to complete this report as confirmation that
              you were present and ready for the class.
            </div>
          )}
          {noShowType === 'teacher' && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800 mb-4">
              Please contact your student immediately to apologise for missing the class and
              to explain what happened.
            </div>
          )}
        </section>
      )}

      {/* Additional details */}
      {didClassHappen !== null && (
        <section className={cardClass} style={cardStyle}>
          <SectionHeader>
            Additional Details{didClassHappen === false && <span className="text-red-500 ml-1">*</span>}
          </SectionHeader>
          {didClassHappen === false && (
            <p className="text-xs text-gray-500 mb-3">Required — please document what happened.</p>
          )}
          {isEditable ? (
            <textarea
              disabled={!isEditable}
              value={additionalDetails}
              onChange={e => setAdditionalDetails(e.target.value)}
              rows={3}
              placeholder="Any additional notes..."
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none"
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-gray-700">{additionalDetails || '—'}</p>
          )}
        </section>
      )}

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {/* Save button */}
      {isEditable && (
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ backgroundColor: saving ? '#fdba74' : '#FF8303' }}
          onMouseEnter={!saving ? e => (e.currentTarget.style.backgroundColor = '#e67300') : undefined}
          onMouseLeave={!saving ? e => (e.currentTarget.style.backgroundColor = '#FF8303') : undefined}
          className={`w-full py-3 rounded-xl text-white font-semibold text-sm transition-colors cursor-pointer${!saving ? ' btn-primary-hover' : ''}`}
        >
          {saving ? 'Saving...' : 'Submit Report'}
        </button>
      )}

      {/* Assignment modal */}
      {showAssignModal && student && (
        <AssignStudySheetsModal
          studentName={student.full_name}
          lessonId={lesson.id}
          studentId={student.id}
          alreadyAssigned={currentAssignedIds}
          onClose={() => setShowAssignModal(false)}
          onSaved={(sheets) => {
            setCurrentAssignedIds(sheets.map(s => s.id))
            setCurrentAssignedSheets(sheets)
          }}
        />
      )}

    </div>
  )
}
