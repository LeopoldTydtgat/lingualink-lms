'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Volume2, CheckCircle, ChevronRight } from 'lucide-react'
import MaterialFileViewer from '@/components/study/MaterialFileViewer'
import DifficultyBars from '@/components/study/DifficultyBars'
import { categoryBadgeStyle } from '@/lib/study/categoryBadge'

// -- Types --------------------------------------------------------------------

interface VocabWord {
  word: string
  part_of_speech: string
  definition: string
  example: string
}

export interface ActivitySummary {
  id: string
  type: string
  title: string | null
  status: 'not_started' | 'pending_review' | 'done'
  score: number | null
}

interface Attachment {
  name: string
  url: string
  type: string
}

interface Sheet {
  id: string
  title: string
  category: string | null
  level: string | null
  difficulty: number
  content: { words?: VocabWord[] } | null
  attachments: Attachment[] | null
}

interface Props {
  sheet: Sheet
  activities: ActivitySummary[]
  assignmentId: string | null
  assignmentMarkedDone: boolean
}

function activityTypeLabel(type: string): string {
  if (type === 'mcq') return 'Quiz'
  if (type === 'writing_task') return 'Writing task'
  return 'Activity'
}

// -- Main Component -----------------------------------------------------------

export default function StudySheetClient({
  sheet,
  activities,
  assignmentId,
  assignmentMarkedDone,
}: Props) {
  const router = useRouter()

  const words: VocabWord[] = sheet.content?.words ?? []

  // Which view is active - vocabulary list or activities. Default to the vocab
  // tab only when the sheet has words; otherwise open straight to activities.
  const [activeTab, setActiveTab] = useState<'vocab' | 'activities'>(
    words.length > 0 ? 'vocab' : 'activities'
  )

  const [markingDone, setMarkingDone] = useState(false)
  const [markedDone, setMarkedDone] = useState(false)
  const [markError, setMarkError] = useState('')

  const totalActivities = activities.length
  const allActivitiesDone =
    totalActivities > 0 && activities.every((a) => a.status === 'done')

  // -- Handlers ---------------------------------------------------------------

  // Mark the whole assignment as done - independent of the per-activity flow.
  // Only reachable in an assignment context (the button is not rendered
  // otherwise).
  async function handleMarkAsDone() {
    setMarkingDone(true)
    setMarkError('')

    try {
      const res = await fetch(`/api/student/assignments/${assignmentId}/mark-done`, {
        method: 'POST',
      })

      if (res.ok) {
        setMarkedDone(true)
        router.refresh()
        return
      }

      // An already-done assignment is reported as a success signal, not a hard
      // error.
      const data = await res.json().catch(() => ({}))
      if (data.alreadyDone) {
        setMarkedDone(true)
        router.refresh()
      } else {
        setMarkError(data.error ?? 'Failed to mark as done')
      }
    } catch (err: unknown) {
      setMarkError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setMarkingDone(false)
    }
  }

  // -- Render -----------------------------------------------------------------

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-5 transition-colors"
      >
        <ArrowLeft size={16} />
        Back to Study
      </button>

      {/* Sheet header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          {sheet.category && (
            <span
              className="px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize"
              style={categoryBadgeStyle(sheet.category)}
            >
              {sheet.category}
            </span>
          )}
          {sheet.level && <span className="text-sm text-gray-500">{sheet.level}</span>}
          {sheet.difficulty != null && <DifficultyBars count={sheet.difficulty} />}
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{sheet.title}</h1>
      </div>

      {/* File viewer - shown whenever the sheet has attachments, before the tabs */}
      {(sheet.attachments?.length ?? 0) > 0 && (
        <MaterialFileViewer
          attachments={sheet.attachments ?? []}
          sheetId={sheet.id}
          mode="plain"
          wrapperClassName="mb-6 space-y-4"
          cardClassName="border border-gray-200 rounded-xl overflow-hidden bg-white"
          cardStyle={{}}
        />
      )}

      {/* Tab toggle */}
      <div className="flex gap-2 border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('vocab')}
          className="flex items-center justify-center pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeTab === 'vocab'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303', minWidth: '160px' }
              : { color: '#6b7280', borderBottom: '2px solid transparent', minWidth: '160px' }
          }
        >
          Vocabulary List
          {words.length > 0 && (
            <span className="ml-1.5 text-xs text-gray-400">({words.length})</span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('activities')}
          className="flex items-center justify-center pb-3 px-1 text-sm font-medium transition-colors"
          style={
            activeTab === 'activities'
              ? { color: '#FF8303', borderBottom: '2px solid #FF8303', minWidth: '160px' }
              : { color: '#6b7280', borderBottom: '2px solid transparent', minWidth: '160px' }
          }
        >
          Activities
          {totalActivities > 0 && (
            <span className="ml-1.5 text-xs text-gray-400">({totalActivities})</span>
          )}
        </button>
      </div>

      {/* -- VOCABULARY TAB ------------------------------------------------- */}
      {activeTab === 'vocab' && (
        <div>
          {words.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">
              No vocabulary words added to this sheet yet.
            </p>
          ) : (
            <div className="rounded-xl overflow-hidden bg-white shadow-sm" style={{ border: '1px solid #f3f4f6' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Word</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 hidden sm:table-cell">
                      Part of Speech
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">Definition</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 hidden md:table-cell">
                      Example
                    </th>
                    <th className="px-4 py-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {words.map((w, idx) => (
                    <tr
                      key={idx}
                      className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                      style={{ borderBottom: '1px solid #f3f4f6' }}
                    >
                      <td className="px-4 py-3 font-semibold text-gray-900">{w.word}</td>
                      <td className="px-4 py-3 text-gray-500 italic hidden sm:table-cell">
                        {w.part_of_speech}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{w.definition}</td>
                      <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{w.example}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => {
                            if ('speechSynthesis' in window) {
                              const utt = new SpeechSynthesisUtterance(w.word)
                              utt.lang = 'en-GB'
                              window.speechSynthesis.speak(utt)
                            }
                          }}
                          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                          title={`Hear pronunciation of "${w.word}"`}
                        >
                          <Volume2 size={14} className="text-gray-400" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Prompt to do activities */}
          {totalActivities > 0 && (
            <div
              className="mt-6 p-4 rounded-xl flex items-center justify-between"
              style={
                allActivitiesDone
                  ? { border: '1px solid #f3f4f6', backgroundColor: '#f9fafb' }
                  : { border: '1px solid #ffedd5', backgroundColor: '#fff7ed' }
              }
            >
              <p className="text-sm text-gray-700">
                Ready to test yourself?{' '}
                {totalActivities === 1 ? (
                  <>There is <strong>1</strong> activity for this sheet.</>
                ) : (
                  <>There are <strong>{totalActivities}</strong> activities for this sheet.</>
                )}
              </p>
              <button
                onClick={() => setActiveTab('activities')}
                className="ml-4 flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold"
                style={
                  allActivitiesDone
                    ? { backgroundColor: '#FFF0E0', color: '#FF8303', border: '1px solid #FFD9A8' }
                    : { backgroundColor: '#FF8303', color: '#ffffff' }
                }
              >
                {allActivitiesDone ? 'Review Activities' : 'View Activities'} <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* -- ACTIVITIES TAB -------------------------------------------------- */}
      {activeTab === 'activities' && (
        <div>
          {totalActivities === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">
              {words.length > 0 && assignmentId !== null
                ? 'This sheet has no separate activities - study the Vocabulary List, then mark it as done below.'
                : words.length > 0
                ? 'This sheet has no separate activities - study the Vocabulary List.'
                : 'No activities for this sheet yet.'}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {activities.map((a) => (
                <Link
                  key={a.id}
                  href={
                    assignmentId
                      ? `/student/activities/${a.id}?assignment=${assignmentId}`
                      : `/student/activities/${a.id}`
                  }
                  prefetch={false}
                  className="flex items-center justify-between gap-3 bg-white rounded-xl p-4 shadow-sm transition-shadow hover:shadow"
                  style={{ border: '1px solid #f3f4f6' }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {a.title || 'Activity'}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">{activityTypeLabel(a.type)}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {a.status === 'pending_review' && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
                        style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}
                      >
                        Pending review
                      </span>
                    )}
                    {a.status === 'done' && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
                        style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}
                      >
                        Completed{a.score != null ? ` ${a.score}%` : ''}
                      </span>
                    )}
                    <ChevronRight size={16} className="text-gray-400" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mark as done - sheet-level assignment completion. Practice context
          (no assignment) has no sheet-level state; the per-activity pills
          carry it instead. */}
      {assignmentId !== null && (
        assignmentMarkedDone || markedDone ? (
          <div
            className="mt-8 p-4 rounded-xl flex items-start gap-3"
            style={{ backgroundColor: '#f0fdf4', border: '1px solid #f3f4f6', borderLeft: '3px solid #16A34A' }}
          >
            <CheckCircle size={18} className="text-green-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-green-700">Completed</p>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <button
              onClick={handleMarkAsDone}
              disabled={markingDone}
              className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#FF8303' }}
            >
              {markingDone ? 'Saving...' : 'Mark as done'}
            </button>
            {markError && (
              <p className="text-sm text-red-600 mt-2">{markError}</p>
            )}
          </div>
        )
      )}
    </div>
  )
}
