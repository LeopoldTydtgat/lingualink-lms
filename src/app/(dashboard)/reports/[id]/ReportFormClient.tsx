'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import AssignStudySheetsModal from '@/components/shared/AssignStudySheetsModal'

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
  'A1', 'A1+',
  'A2', 'A2+',
  'B1', 'B1+',
  'B2', 'B2+',
  'C1', 'C1+',
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

export default function ReportFormClient({ report, profile, isAdmin, assignedSheetIds, assignedSheets }: Props) {
  const router = useRouter()
  const supabase = createClient()

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

  const isEditable = report.status === 'pending' || report.status === 'reopened'

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
      setError('Please provide at least 150 characters of feedback before submitting.')
      return
    }

    setSaving(true)
    setError(null)

    const { error: saveError } = await supabase
      .from('reports')
      .update({
        did_class_happen: didClassHappen,
        no_show_type: didClassHappen ? null : noShowType,
        feedback_text: didClassHappen ? feedbackText : null,
        additional_details: additionalDetails || null,
        level_data: didClassHappen ? levelData : null,
        student_confirmed: didClassHappen ? studentConfirmed : null,
        impersonation_note: didClassHappen && !studentConfirmed ? impersonationNote : null,
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', report.id)

    setSaving(false)

    if (saveError) {
      setError('Failed to save report. Please try again.')
      console.error(saveError)
      return
    }

    router.push('/reports')
    router.refresh()
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">

      <a
        href="/reports"
        className="text-sm text-gray-500 hover:text-gray-700 mb-6 inline-block"
      >
        &larr; Back to reports
      </a>

      {/* Student header */}
      <div className="flex items-center gap-4 mb-8">
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
          {report.status === 'reopened' && (
            <span className="text-xs text-orange-600 font-medium">Reopened by admin</span>
          )}
          {report.status === 'flagged' && (
            <span className="text-xs text-red-600 font-medium">Flagged — report overdue</span>
          )}
        </div>
      </div>

      {/* Read-only notice */}
      {!isEditable && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6 text-sm text-gray-600">
          This report has been submitted and cannot be edited.
          {isAdmin && report.status === 'flagged' && (
            <span className="ml-2 text-orange-600 font-medium">
              As admin you can reopen this report from the reports list.
            </span>
          )}
        </div>
      )}

      {/* Did the class take place? */}
      <section className="mb-8">
        <h2 className="text-base font-semibold text-gray-800 mb-3">Did the class take place?</h2>
        <div className="flex gap-3">
          <button
            disabled={!isEditable}
            onClick={() => setDidClassHappen(true)}
            style={
              didClassHappen === true
                ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                : { backgroundColor: 'white', color: '#374151' }
            }
            className="px-6 py-2 rounded-lg text-sm font-semibold border border-gray-300 transition-colors"
          >
            Yes
          </button>
          <button
            disabled={!isEditable}
            onClick={() => setDidClassHappen(false)}
            style={
              didClassHappen === false
                ? { backgroundColor: '#FD5602', borderColor: '#FD5602', color: 'white' }
                : { backgroundColor: 'white', color: '#374151' }
            }
            className="px-6 py-2 rounded-lg text-sm font-semibold border border-gray-300 transition-colors"
          >
            No
          </button>
        </div>
      </section>

      {/* YES — class happened */}
      {didClassHappen === true && (
        <>
          {/* Student identity confirmation */}
          <section className="mb-8">
            <h2 className="text-base font-semibold text-gray-800 mb-3">Student Confirmation</h2>
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
          </section>

          {/* Feedback box */}
          <section className="mb-8">
            <h2 className="text-base font-semibold text-gray-800 mb-1">
              Class Recap, Feedback &amp; Next Steps
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              This will appear as the recap on the next class card.
            </p>
            <textarea
              disabled={!isEditable}
              value={feedbackText}
              onChange={e => setFeedbackText(e.target.value)}
              rows={5}
              maxLength={1000}
              placeholder="Summarise what was covered, how the student performed, and what to focus on next time..."
              className={[
                'w-full border border-gray-300 rounded-xl px-4 py-3 text-sm',
                'focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none',
                !isEditable ? 'bg-gray-50 text-gray-500' : '',
              ].join(' ')}
            />
            <p className="text-xs text-gray-400 text-right mt-1">{feedbackText.length} / 1000</p>
    {feedbackText.length < 150 && (
      <p className="text-xs text-red-500 mt-1">
        Minimum 150 characters required ({150 - feedbackText.length} remaining)
      </p>
    )}
          </section>

          {/* Study sheet assignment */}
          <section className="mb-8">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Study Sheets for Next Time</h2>
            <p className="text-xs text-gray-500 mb-3">
              Assign vocabulary or grammar sheets for the student to review.
            </p>
            {currentAssignedIds.length > 0 && (
              <ul className="mb-3 space-y-1">
                {currentAssignedIds.map(id => {
                  const sheet = currentAssignedSheets.find(s => s.id === id)
                  return (
                    <li key={id} className="text-sm text-gray-700 flex items-center gap-2">
                      <span style={{ color: '#FF8303' }}>•</span>
                      {sheet?.title ?? 'Unknown sheet'}
                    </li>
                  )
                })}
              </ul>
            )}
            {isEditable && (
              <button
                onClick={() => setShowAssignModal(true)}
                className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border transition-colors"
                style={{ color: '#FF8303', borderColor: '#FF8303', backgroundColor: '#fff7ed' }}
              >
                + Assign Study Sheets
              </button>
            )}
          </section>

          {/* Student level assessment */}
          <section className="mb-8">
            <h2 className="text-base font-semibold text-gray-800 mb-1">Student Level Assessment</h2>
            <p className="text-xs text-gray-500 mb-4">Select a CEFR level for each skill.</p>
            <div className="flex flex-col gap-4">
              {SKILLS.map(skill => (
                <div key={skill.key}>
                  <p className="text-sm font-medium text-gray-700 mb-2">{skill.label}</p>
                  <div className="flex flex-wrap gap-2">
                    {CEFR_LEVELS.map(level => (
                      <button
                        key={level}
                        disabled={!isEditable}
                        onClick={() => setSkillLevel(skill.key, level)}
                        style={
                          levelData[skill.key] === level
                            ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                            : { backgroundColor: 'white', color: '#4B5563' }
                        }
                        className="px-3 py-1 rounded-md text-xs font-semibold border border-gray-300 transition-colors"
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* CEFR guidance */}
            <div className="mt-6 bg-gray-50 border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-600 mb-3 uppercase tracking-wide">CEFR Level Guide</p>
              <div className="flex flex-col gap-2">
                {Object.entries(CEFR_DESCRIPTIONS).map(([level, desc]) => (
                  <div key={level} className="flex gap-3 text-xs text-gray-600">
                    <span className="font-bold text-gray-800 w-6 shrink-0">{level}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {/* NO — class did not happen */}
      {didClassHappen === false && (
        <section className="mb-8">
          <h2 className="text-base font-semibold text-gray-800 mb-3">What happened?</h2>
          <div className="flex flex-col gap-3 mb-4">
            <button
              disabled={!isEditable}
              onClick={() => setNoShowType('student')}
              style={
                noShowType === 'student'
                  ? { borderColor: '#FF8303', backgroundColor: '#fff7ed' }
                  : { backgroundColor: 'white' }
              }
              className="text-left px-4 py-3 rounded-xl border border-gray-300 text-sm transition-colors"
            >
              <p className="font-semibold text-gray-800">Student no-show</p>
            </button>
            <button
              disabled={!isEditable}
              onClick={() => setNoShowType('teacher')}
              style={
                noShowType === 'teacher'
                  ? { borderColor: '#FD5602', backgroundColor: '#fff1f0' }
                  : { backgroundColor: 'white' }
              }
              className="text-left px-4 py-3 rounded-xl border border-gray-300 text-sm transition-colors"
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
        <section className="mb-8">
          <h2 className="text-base font-semibold text-gray-800 mb-1">
            Additional Details
            {didClassHappen === false && <span className="text-red-500 ml-1">*</span>}
          </h2>
          {didClassHappen === false && (
            <p className="text-xs text-gray-500 mb-3">Required — please document what happened.</p>
          )}
          <textarea
            disabled={!isEditable}
            value={additionalDetails}
            onChange={e => setAdditionalDetails(e.target.value)}
            rows={3}
            placeholder="Any additional notes..."
            className={[
              'w-full border border-gray-300 rounded-xl px-4 py-3 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none',
              !isEditable ? 'bg-gray-50 text-gray-500' : '',
            ].join(' ')}
          />
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
          className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-colors cursor-pointer"
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
