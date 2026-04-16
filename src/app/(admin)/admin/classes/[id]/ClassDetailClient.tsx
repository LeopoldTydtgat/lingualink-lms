'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface LessonDetail {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  cancelled_at: string | null
  cancellation_reason: string | null
  teams_join_url: string | null
  teams_meeting_id: string | null
  teacher_id: string
  student_id: string
  training_id: string
  teacher: { id: string; full_name: string; photo_url: string | null; timezone: string | null } | null
  student: { id: string; full_name: string; photo_url: string | null; timezone: string | null } | null
  training: { id: string; package_name: string | null; total_hours: number; hours_consumed: number } | null
  report: { id: string; status: string } | null
}

interface Props {
  lesson: LessonDetail
}

function getStatusMeta(status: string): { label: string; bg: string; color: string } {
  switch (status) {
    case 'scheduled':     return { label: 'Upcoming',          bg: '#EFF6FF', color: '#1D4ED8' }
    case 'completed':     return { label: 'Completed',         bg: '#F0FDF4', color: '#15803D' }
    case 'cancelled':
    case 'cancelled_by_student':
    case 'cancelled_by_teacher':
                          return { label: 'Cancelled',         bg: '#FEF2F2', color: '#B91C1C' }
    case 'student_no_show': return { label: 'Student No-Show', bg: '#FFF7ED', color: '#C2410C' }
    case 'teacher_no_show': return { label: 'Teacher No-Show', bg: '#FEF2F2', color: '#B91C1C' }
    case 'flagged':       return { label: 'Flagged',           bg: '#FEF9C3', color: '#A16207' }
    default:              return { label: status,              bg: '#F3F4F6', color: '#374151' }
  }
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export default function ClassDetailClient({ lesson }: Props) {
  const router = useRouter()
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelReasonError, setCancelReasonError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const statusMeta = getStatusMeta(lesson.status)
  const isCancellable = ['scheduled'].includes(lesson.status)
  const isCancelled = ['cancelled', 'cancelled_by_student', 'cancelled_by_teacher'].includes(lesson.status)

  async function handleDelete() {
    setDeleting(true)
    setDeleteError('')
    const res = await fetch(`/api/admin/classes/${lesson.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      setDeleteError(data.error ?? 'Failed to delete. Please try again.')
      setDeleting(false)
      return
    }
    window.location.href = '/admin/classes'
  }

  async function handleCancel() {
    setCancelling(true)
    setCancelError('')
    const res = await fetch(`/api/admin/classes/${lesson.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', cancellation_reason: cancelReason }),
    })
    const data = await res.json()
    if (!res.ok) {
      setCancelError(data.error ?? 'Failed to cancel. Please try again.')
      setCancelling(false)
      return
    }
    window.location.href = '/admin/classes'
  }

  function openCancelModal() {
    setCancelReason('')
    setCancelReasonError('')
    setCancelError('')
    setShowCancelModal(true)
  }

  function attemptCancel() {
    if (cancelReason.trim().length < 10) {
      setCancelReasonError('Please provide a reason (minimum 10 characters)')
      return
    }
    setCancelReasonError('')
    handleCancel()
  }

  return (
    <div style={{ padding: '32px', maxWidth: '720px' }}>

      {/* Back */}
      <Link href="/admin/classes" prefetch={false} style={{ fontSize: '14px', color: '#FF8303', textDecoration: 'none' }}>
        ← Back to Classes
      </Link>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: '20px', marginBottom: '28px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', margin: 0 }}>
            Class Detail
          </h1>
          <p style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '4px' }}>ID: {lesson.id}</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span style={{
            padding: '4px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600,
            backgroundColor: statusMeta.bg, color: statusMeta.color,
          }}>
            {statusMeta.label}
          </span>
          <Link href={`/admin/classes/${lesson.id}/edit`} prefetch={false}>
            <button style={{
              padding: '8px 16px', borderRadius: '7px', border: '1px solid #D1D5DB',
              backgroundColor: 'white', fontSize: '13px', fontWeight: 600,
              cursor: 'pointer', color: '#374151',
            }}>
              Edit
            </button>
          </Link>
          {isCancellable && (
            <button
              onClick={openCancelModal}
              style={{
                padding: '8px 16px', borderRadius: '7px', border: 'none',
                backgroundColor: '#FEF2F2', fontSize: '13px', fontWeight: 600,
                cursor: 'pointer', color: '#B91C1C',
              }}
            >
              Cancel Class
            </button>
          )}
          <button
            onClick={() => { setDeleteError(''); setShowDeleteModal(true) }}
            style={{
              padding: '8px 16px', borderRadius: '7px', border: 'none',
              backgroundColor: '#FEF2F2', fontSize: '13px', fontWeight: 600,
              cursor: 'pointer', color: '#991B1B',
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Main details card */}
      <div style={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '24px', marginBottom: '20px' }}>
        <SectionTitle>Class Information</SectionTitle>
        <DetailRow label="Date & Time" value={formatDateTime(lesson.scheduled_at)} />
        <DetailRow label="Duration" value={`${lesson.duration_minutes} minutes`} />
        <DetailRow
          label="Teams Link"
          value={lesson.teams_join_url
            ? <a href={lesson.teams_join_url} target="_blank" rel="noreferrer" style={{ color: '#FF8303' }}>Join Meeting</a>
            : <span style={{ color: '#9CA3AF' }}>Not yet generated</span>
          }
        />
        {lesson.cancellation_reason && (
          <DetailRow label="Cancellation Reason" value={lesson.cancellation_reason} />
        )}
        {lesson.cancelled_at && (
          <DetailRow label="Cancelled At" value={formatDateTime(lesson.cancelled_at)} />
        )}
      </div>

      {/* People card */}
      <div style={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '24px', marginBottom: '20px' }}>
        <SectionTitle>Teacher &amp; Student</SectionTitle>

        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          {/* Teacher */}
          <Link href={`/admin/teachers/${lesson.teacher_id}`} prefetch={false} style={{ textDecoration: 'none', flex: '1 1 200px' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '14px', borderRadius: '10px', border: '1px solid #E5E7EB',
              backgroundColor: '#F9FAFB', cursor: 'pointer',
            }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '50%', backgroundColor: '#E5E7EB',
                overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: '#6B7280',
              }}>
                {lesson.teacher?.photo_url
                  ? <img src={lesson.teacher.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : lesson.teacher?.full_name?.[0] ?? '?'}
              </div>
              <div>
                <p style={{ fontSize: '11px', color: '#9CA3AF', margin: 0 }}>TEACHER</p>
                <p style={{ fontSize: '14px', fontWeight: 600, color: '#111827', margin: '2px 0 0' }}>
                  {lesson.teacher?.full_name ?? '—'}
                </p>
                {lesson.teacher?.timezone && (
                  <p style={{ fontSize: '12px', color: '#6B7280', margin: '2px 0 0' }}>{lesson.teacher.timezone}</p>
                )}
              </div>
            </div>
          </Link>

          {/* Student */}
          <Link href={`/admin/students/${lesson.student_id}`} prefetch={false} style={{ textDecoration: 'none', flex: '1 1 200px' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '14px', borderRadius: '10px', border: '1px solid #E5E7EB',
              backgroundColor: '#F9FAFB', cursor: 'pointer',
            }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '50%', backgroundColor: '#E5E7EB',
                overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: '#6B7280',
              }}>
                {lesson.student?.photo_url
                  ? <img src={lesson.student.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : lesson.student?.full_name?.[0] ?? '?'}
              </div>
              <div>
                <p style={{ fontSize: '11px', color: '#9CA3AF', margin: 0 }}>STUDENT</p>
                <p style={{ fontSize: '14px', fontWeight: 600, color: '#111827', margin: '2px 0 0' }}>
                  {lesson.student?.full_name ?? '—'}
                </p>
                {lesson.training && (
                  <p style={{ fontSize: '12px', color: '#6B7280', margin: '2px 0 0' }}>
                    {(lesson.training.total_hours - lesson.training.hours_consumed).toFixed(1)}h remaining
                  </p>
                )}
              </div>
            </div>
          </Link>
        </div>
      </div>

      {/* Report card */}
      <div style={{ backgroundColor: 'white', border: '1px solid #E5E7EB', borderRadius: '12px', padding: '24px' }}>
        <SectionTitle>Class Report</SectionTitle>
        {lesson.report ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '14px', color: '#374151', margin: 0 }}>
                Status: <strong style={{ textTransform: 'capitalize' }}>{lesson.report.status}</strong>
              </p>
            </div>
            <Link href={`/admin/reports?lesson_id=${lesson.id}`} prefetch={false}>
              <button style={{
                padding: '8px 16px', borderRadius: '7px', border: 'none',
                backgroundColor: '#FF8303', color: 'white', fontSize: '13px',
                fontWeight: 600, cursor: 'pointer',
              }}>
                View Report
              </button>
            </Link>
          </div>
        ) : (
          <p style={{ fontSize: '14px', color: '#9CA3AF', margin: 0 }}>
            No report submitted yet.
          </p>
        )}
      </div>

      {/* Delete modal */}
      {showDeleteModal && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '12px', padding: '28px',
            width: '440px', maxWidth: '90vw',
          }}>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', marginTop: 0 }}>
              Delete This Class?
            </h3>
            {!isCancelled ? (
              <>
                <p style={{ fontSize: '14px', color: '#B91C1C', marginBottom: '20px' }}>
                  Only cancelled classes can be deleted. Please cancel the class first.
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowDeleteModal(false)}
                    style={{
                      padding: '9px 18px', borderRadius: '7px', border: '1px solid #D1D5DB',
                      backgroundColor: 'white', fontSize: '13px', cursor: 'pointer', color: '#374151',
                    }}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: '14px', color: '#6B7280' }}>
                  Are you sure you want to delete this class? This cannot be undone.
                </p>
                {deleteError && (
                  <p style={{ fontSize: '13px', color: '#B91C1C', marginBottom: '12px' }}>{deleteError}</p>
                )}
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowDeleteModal(false)}
                    disabled={deleting}
                    style={{
                      padding: '9px 18px', borderRadius: '7px', border: '1px solid #D1D5DB',
                      backgroundColor: 'white', fontSize: '13px', cursor: deleting ? 'not-allowed' : 'pointer', color: '#374151',
                    }}
                  >
                    Go Back
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    style={{
                      padding: '9px 18px', borderRadius: '7px', border: 'none',
                      backgroundColor: deleting ? '#E5E7EB' : '#DC2626',
                      color: deleting ? '#9CA3AF' : 'white',
                      fontSize: '13px', fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {deleting ? 'Deleting...' : 'Yes, Delete Class'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Cancel modal */}
      {showCancelModal && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: '12px', padding: '28px',
            width: '440px', maxWidth: '90vw',
          }}>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', marginTop: 0 }}>
              Cancel This Class?
            </h3>
            <p style={{ fontSize: '14px', color: '#6B7280' }}>
              The student&apos;s hours will be refunded. This action cannot be undone.
            </p>
            <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
              Reason
            </label>
            <textarea
              value={cancelReason}
              onChange={(e) => { setCancelReason(e.target.value); setCancelReasonError('') }}
              placeholder="e.g. Teacher unavailable due to illness"
              rows={3}
              style={{
                width: '100%', border: `1px solid ${cancelReasonError ? '#FCA5A5' : '#D1D5DB'}`, borderRadius: '6px',
                padding: '8px 10px', fontSize: '14px', outline: 'none',
                resize: 'none', boxSizing: 'border-box', marginBottom: '6px',
              }}
            />
            {cancelReasonError && (
              <p style={{ fontSize: '12px', color: '#B91C1C', marginBottom: '10px', marginTop: 0 }}>
                {cancelReasonError}
              </p>
            )}
            {cancelError && (
              <p style={{ fontSize: '13px', color: '#B91C1C', marginBottom: '12px' }}>{cancelError}</p>
            )}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowCancelModal(false)}
                style={{
                  padding: '9px 18px', borderRadius: '7px', border: '1px solid #D1D5DB',
                  backgroundColor: 'white', fontSize: '13px', cursor: 'pointer', color: '#374151',
                }}
              >
                Go Back
              </button>
              <button
                onClick={attemptCancel}
                disabled={cancelling}
                style={{
                  padding: '9px 18px', borderRadius: '7px', border: 'none',
                  backgroundColor: cancelling ? '#E5E7EB' : '#DC2626',
                  color: cancelling ? '#9CA3AF' : 'white',
                  fontSize: '13px', fontWeight: 600, cursor: cancelling ? 'not-allowed' : 'pointer',
                }}
              >
                {cancelling ? 'Cancelling...' : 'Yes, Cancel Class'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: '13px', fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 0, marginBottom: '16px' }}>
      {children}
    </h2>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #F3F4F6' }}>
      <span style={{ fontSize: '13px', color: '#6B7280' }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: '#111827', textAlign: 'right' }}>{value}</span>
    </div>
  )
}
