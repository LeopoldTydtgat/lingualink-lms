'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Teacher {
  id: string
  full_name: string
  photo_url: string | null
  bio: string | null
  timezone: string | null
}

interface Training {
  id: string
  total_hours: number
  hours_consumed: number
  package_name: string | null
  status: string | null
}

interface Student {
  id: string
  full_name: string
  photo_url: string | null
  timezone: string | null
  training: Training | null
}

interface Props {
  teachers: Teacher[]
  students: Student[]
}

const DURATIONS = [30, 60, 90]

// Build a local YYYY-MM-DDTHH:MM string from year/month/day/hour/minute parts
// Never uses toISOString() — avoids UTC shift on local dates
function buildLocalISOString(year: number, month: number, day: number, hour: number, minute: number): string {
  const mm = month.toString().padStart(2, '0')
  const dd = day.toString().padStart(2, '0')
  const hh = hour.toString().padStart(2, '0')
  const mi = minute.toString().padStart(2, '0')
  return `${year}-${mm}-${dd}T${hh}:${mi}:00`
}

// Generate time slots in 30-min increments from 06:00 to 22:00
function generateTimeSlots(): string[] {
  const slots: string[] = []
  for (let h = 6; h <= 21; h++) {
    slots.push(`${h.toString().padStart(2, '0')}:00`)
    slots.push(`${h.toString().padStart(2, '0')}:30`)
  }
  slots.push('22:00')
  return slots
}

export default function BookingFlowClient({ teachers, students }: Props) {
  const router = useRouter()

  const [step, setStep] = useState(1)
  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null)
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null)
  const [selectedDate, setSelectedDate] = useState('')   // YYYY-MM-DD
  const [selectedTime, setSelectedTime] = useState('')   // HH:MM
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [teacherSearch, setTeacherSearch] = useState('')
  const [studentSearch, setStudentSearch] = useState('')

  const timeSlots = generateTimeSlots()

  // Today's date as YYYY-MM-DD for the min date attribute
  const today = new Date()
  const todayString = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`

  const hoursRequested = selectedDuration ? selectedDuration / 60 : 0
  const hoursRemaining = selectedStudent?.training
    ? selectedStudent.training.total_hours - selectedStudent.training.hours_consumed
    : 0
  const hoursAfterBooking = hoursRemaining - hoursRequested

  async function handleConfirm() {
    if (!selectedTeacher || !selectedStudent || !selectedDuration || !selectedDate || !selectedTime) return
    if (!selectedStudent.training) {
      setError('This student has no active training. Add a training before booking.')
      return
    }

    setSubmitting(true)
    setError('')

    // Parse date and time parts to avoid toISOString() UTC shift
    const [year, month, day] = selectedDate.split('-').map(Number)
    const [hour, minute] = selectedTime.split(':').map(Number)
    const scheduledAt = buildLocalISOString(year, month, day, hour, minute)

    const res = await fetch('/api/admin/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teacher_id: selectedTeacher.id,
        student_id: selectedStudent.id,
        training_id: selectedStudent.training.id,
        scheduled_at: scheduledAt,
        duration_minutes: selectedDuration,
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Something went wrong. Please try again.')
      setSubmitting(false)
      return
    }

    router.push(`/admin/classes/${data.lesson_id}`)
  }

  // ── Step indicators ───────────────────────────────────────────────────────
  const steps = ['Teacher', 'Student', 'Duration', 'Date & Time', 'Confirm']

  return (
    <div style={{ padding: '32px', maxWidth: '720px' }}>

      {/* Back link */}
      <button
        onClick={() => step > 1 ? setStep(step - 1) : router.push('/admin/classes')}
        style={{ fontSize: '14px', color: '#FF8303', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '20px', padding: 0 }}
      >
        ← {step > 1 ? 'Back' : 'Back to Classes'}
      </button>

      <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111827', marginBottom: '8px' }}>
        Book a Class
      </h1>

      {/* Step progress bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '32px' }}>
        {steps.map((label, i) => {
          const stepNum = i + 1
          const isComplete = step > stepNum
          const isActive = step === stepNum
          return (
            <div key={label} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: '4px',
                borderRadius: '2px',
                backgroundColor: isComplete || isActive ? '#FF8303' : '#E5E7EB',
                marginBottom: '6px',
              }} />
              <span style={{
                fontSize: '11px',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? '#FF8303' : isComplete ? '#374151' : '#9CA3AF',
              }}>
                {label}
              </span>
            </div>
          )
        })}
      </div>

      {/* ── STEP 1: Select Teacher ── */}
      {step === 1 && (
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '16px' }}>
            Select a Teacher
          </h2>
          <input
            type="text"
            placeholder="Search teachers..."
            value={teacherSearch}
            onChange={(e) => setTeacherSearch(e.target.value)}
            style={{
              width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
              padding: '8px 10px', fontSize: '14px', outline: 'none',
              marginBottom: '12px', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {teachers
              .filter((t) => t.full_name.toLowerCase().includes(teacherSearch.toLowerCase()))
              .map((teacher) => (
                <div
                  key={teacher.id}
                  onClick={() => { setSelectedTeacher(teacher); setStep(2) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '14px',
                    padding: '14px 16px', borderRadius: '10px', cursor: 'pointer',
                    border: selectedTeacher?.id === teacher.id ? '2px solid #FF8303' : '1px solid #E5E7EB',
                    backgroundColor: selectedTeacher?.id === teacher.id ? '#FFF7ED' : 'white',
                  }}
                >
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '50%',
                    backgroundColor: '#F3F4F6', overflow: 'hidden', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '16px', fontWeight: 700, color: '#6B7280',
                  }}>
                    {teacher.photo_url
                      ? <img src={teacher.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : teacher.full_name[0]}
                  </div>
                  <div>
                    <p style={{ fontSize: '15px', fontWeight: 600, color: '#111827', margin: 0 }}>{teacher.full_name}</p>
                    {teacher.timezone && (
                      <p style={{ fontSize: '12px', color: '#6B7280', margin: '2px 0 0' }}>{teacher.timezone}</p>
                    )}
                  </div>
                </div>
              ))}
            {teachers.filter((t) => t.full_name.toLowerCase().includes(teacherSearch.toLowerCase())).length === 0 && (
              <p style={{ fontSize: '14px', color: '#9CA3AF', textAlign: 'center', padding: '24px' }}>No teachers found.</p>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 2: Select Student ── */}
      {step === 2 && (
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '16px' }}>
            Select a Student
          </h2>
          <input
            type="text"
            placeholder="Search students..."
            value={studentSearch}
            onChange={(e) => setStudentSearch(e.target.value)}
            style={{
              width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
              padding: '8px 10px', fontSize: '14px', outline: 'none',
              marginBottom: '12px', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {students
              .filter((s) => s.full_name.toLowerCase().includes(studentSearch.toLowerCase()))
              .map((student) => {
                const remaining = student.training
                  ? student.training.total_hours - student.training.hours_consumed
                  : 0
                const noTraining = !student.training
                return (
                  <div
                    key={student.id}
                    onClick={() => { if (!noTraining) { setSelectedStudent(student); setStep(3) } }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '14px',
                      padding: '14px 16px', borderRadius: '10px',
                      cursor: noTraining ? 'not-allowed' : 'pointer',
                      border: selectedStudent?.id === student.id ? '2px solid #FF8303' : '1px solid #E5E7EB',
                      backgroundColor: noTraining ? '#F9FAFB' : selectedStudent?.id === student.id ? '#FFF7ED' : 'white',
                      opacity: noTraining ? 0.6 : 1,
                    }}
                  >
                    <div style={{
                      width: '44px', height: '44px', borderRadius: '50%',
                      backgroundColor: '#F3F4F6', overflow: 'hidden', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '16px', fontWeight: 700, color: '#6B7280',
                    }}>
                      {student.photo_url
                        ? <img src={student.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : student.full_name[0]}
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: '15px', fontWeight: 600, color: '#111827', margin: 0 }}>{student.full_name}</p>
                      {noTraining
                        ? <p style={{ fontSize: '12px', color: '#DC2626', margin: '2px 0 0' }}>No active training</p>
                        : <p style={{ fontSize: '12px', color: '#6B7280', margin: '2px 0 0' }}>
                            {remaining.toFixed(1)}h remaining · {student.training?.package_name ?? 'Training'}
                          </p>
                      }
                    </div>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* ── STEP 3: Select Duration ── */}
      {step === 3 && (
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '8px' }}>
            Select Duration
          </h2>
          <p style={{ fontSize: '14px', color: '#6B7280', marginBottom: '20px' }}>
            {selectedStudent?.full_name} has <strong>{hoursRemaining.toFixed(1)}h</strong> remaining.
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            {DURATIONS.map((mins) => {
              const hours = mins / 60
              const insufficient = hours > hoursRemaining
              return (
                <button
                  key={mins}
                  disabled={insufficient}
                  onClick={() => { setSelectedDuration(mins); setStep(4) }}
                  style={{
                    flex: 1, padding: '20px 12px', borderRadius: '10px',
                    border: selectedDuration === mins ? '2px solid #FF8303' : '1px solid #E5E7EB',
                    backgroundColor: insufficient ? '#F9FAFB' : selectedDuration === mins ? '#FFF7ED' : 'white',
                    cursor: insufficient ? 'not-allowed' : 'pointer',
                    opacity: insufficient ? 0.5 : 1,
                  }}
                >
                  <p style={{ fontSize: '20px', fontWeight: 700, color: '#111827', margin: 0 }}>{mins}</p>
                  <p style={{ fontSize: '12px', color: '#6B7280', margin: '4px 0 0' }}>minutes</p>
                  {insufficient && (
                    <p style={{ fontSize: '11px', color: '#DC2626', margin: '4px 0 0' }}>Insufficient hours</p>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── STEP 4: Select Date & Time ── */}
      {step === 4 && (
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '20px' }}>
            Select Date &amp; Time
          </h2>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
                Date
              </label>
              <input
                type="date"
                min={todayString}
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{
                  width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
                  padding: '10px 12px', fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '6px' }}>
                Time ({selectedTeacher?.timezone ?? 'select teacher timezone'})
              </label>
              <select
                value={selectedTime}
                onChange={(e) => setSelectedTime(e.target.value)}
                style={{
                  width: '100%', border: '1px solid #D1D5DB', borderRadius: '6px',
                  padding: '10px 12px', fontSize: '14px', outline: 'none',
                  backgroundColor: 'white', boxSizing: 'border-box',
                }}
              >
                <option value="">Select time...</option>
                {timeSlots.map((slot) => (
                  <option key={slot} value={slot}>{slot}</option>
                ))}
              </select>
            </div>
          </div>
          <p style={{ fontSize: '12px', color: '#9CA3AF', marginTop: '12px' }}>
            Time is stored as entered. Ensure you are entering the class time in the teacher&apos;s timezone ({selectedTeacher?.timezone ?? '—'}).
          </p>
          <button
            onClick={() => { if (selectedDate && selectedTime) setStep(5) }}
            disabled={!selectedDate || !selectedTime}
            style={{
              marginTop: '24px', padding: '12px 28px', borderRadius: '8px',
              backgroundColor: selectedDate && selectedTime ? '#FF8303' : '#E5E7EB',
              color: selectedDate && selectedTime ? 'white' : '#9CA3AF',
              border: 'none', fontSize: '14px', fontWeight: 600,
              cursor: selectedDate && selectedTime ? 'pointer' : 'not-allowed',
            }}
          >
            Continue →
          </button>
        </div>
      )}

      {/* ── STEP 5: Confirm ── */}
      {step === 5 && selectedTeacher && selectedStudent && selectedDuration && selectedDate && selectedTime && (
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '20px' }}>
            Confirm Booking
          </h2>

          <div style={{
            backgroundColor: 'white', border: '1px solid #E5E7EB',
            borderRadius: '12px', padding: '24px', marginBottom: '20px',
          }}>
            <Row label="Teacher" value={selectedTeacher.full_name} />
            <Row label="Student" value={selectedStudent.full_name} />
            <Row label="Date" value={selectedDate} />
            <Row label="Time" value={`${selectedTime} (${selectedTeacher.timezone ?? 'unknown timezone'})`} />
            <Row label="Duration" value={`${selectedDuration} minutes`} />
            <div style={{ borderTop: '1px solid #F3F4F6', margin: '12px 0' }} />
            <Row label="Hours to deduct" value={`${hoursRequested.toFixed(1)}h`} />
            <Row label="Hours remaining after" value={`${hoursAfterBooking.toFixed(1)}h`} highlight={hoursAfterBooking < 2} />
          </div>

          {hoursAfterBooking < 2 && hoursAfterBooking >= 0 && (
            <div style={{
              backgroundColor: '#FFF7ED', border: '1px solid #FED7AA',
              borderRadius: '8px', padding: '12px 16px', marginBottom: '16px',
              fontSize: '13px', color: '#92400E',
            }}>
              ⚠️ This student will have less than 2 hours remaining after this booking.
            </div>
          )}

          {error && (
            <div style={{
              backgroundColor: '#FEF2F2', border: '1px solid #FECACA',
              borderRadius: '8px', padding: '12px 16px', marginBottom: '16px',
              fontSize: '13px', color: '#B91C1C',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => setStep(4)}
              style={{
                padding: '12px 24px', borderRadius: '8px', border: '1px solid #D1D5DB',
                backgroundColor: 'white', fontSize: '14px', cursor: 'pointer', color: '#374151',
              }}
            >
              Go Back
            </button>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              style={{
                padding: '12px 28px', borderRadius: '8px', border: 'none',
                backgroundColor: submitting ? '#E5E7EB' : '#FF8303',
                color: submitting ? '#9CA3AF' : 'white',
                fontSize: '14px', fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? 'Booking...' : 'Confirm Booking'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Small helper for the confirm summary rows
function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #F9FAFB' }}>
      <span style={{ fontSize: '13px', color: '#6B7280' }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 600, color: highlight ? '#DC2626' : '#111827' }}>{value}</span>
    </div>
  )
}
