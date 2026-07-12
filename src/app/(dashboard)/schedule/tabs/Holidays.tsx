'use client'

import { useState } from 'react'
import { AvailabilityRecord } from '../ScheduleClient'

interface Profile { id: string; full_name: string; role: string }

interface Props {
  profile: Profile
  availability: AvailabilityRecord[]
  onAvailabilityChange: (records: AvailabilityRecord[]) => void
}

// Format a date string for display e.g. "2026-04-10" → "10 Apr 2026"
// Construct from local parts so a YYYY-MM-DD is not parsed as UTC midnight
// and rendered one day early in UTC-negative browsers.
function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  })
}

// Get today's date as YYYY-MM-DD for the date input minimum value
function todayStr(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export default function Holidays({ profile, availability, onAvailabilityChange }: Props) {
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  // Filter down to just holiday records for display
  const holidays = availability.filter(a => a.type === 'holiday')

  async function addHoliday() {
    setError('')

    if (!fromDate || !toDate) {
      setError('Please select both a start and end date.')
      return
    }

    if (toDate < fromDate) {
      setError('End date cannot be before start date.')
      return
    }

    setIsSaving(true)

    // Store holiday as a full-day range in offset-less local format:
    // start_at = fromDate at 00:00:00, end_at = toDate at 23:59:59.
    // All three readers consume this same format consistently.
    const start = `${fromDate}T00:00:00`
    const end = `${toDate}T23:59:59`

    const res = await fetch('/api/teacher/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teacher_id: profile.id,
        type: 'holiday',
        start_at: start,
        end_at: end,
        is_available: false,
      }),
    })

    if (!res.ok) {
      setError('Failed to save. Please try again.')
    } else {
      const data = await res.json()
      onAvailabilityChange([...availability, data as AvailabilityRecord])
      setFromDate('')
      setToDate('')
    }

    setIsSaving(false)
  }

  function deleteHoliday(id: string) {
    setPendingDelete(id)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleteError('')
    const res = await fetch(`/api/teacher/availability/${pendingDelete}`, { method: 'DELETE' })
    if (res.ok) {
      onAvailabilityChange(availability.filter(a => a.id !== pendingDelete))
    } else {
      setDeleteError('Failed to remove this holiday period. Please try again.')
    }
    setPendingDelete(null)
  }

  return (
    <div style={{ maxWidth: '600px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
        <h2 style={{ fontSize: '15px', fontWeight: '600', color: '#111827', margin: 0 }}>Holidays</h2>
      </div>
      <p style={{ fontSize: '13px', color: '#6B7280', marginBottom: '24px' }}>
        Specify periods during which no new classes will be assigned to you.
        Already booked classes are not affected — if you have existing classes during
        this period, you must contact your co-ordinator.
      </p>

      {/* Warning banner */}
      <div style={{
        backgroundColor: '#FFF7ED',
        border: '1px solid #FED7AA',
        borderRadius: '8px',
        padding: '12px 16px',
        marginBottom: '24px',
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
      }}>
        <span style={{ fontSize: '16px', flexShrink: 0 }}>⚠️</span>
        <p style={{ fontSize: '13px', color: '#92400E', margin: 0 }}>
          Adding a holiday period does not automatically cancel existing bookings.
        </p>
      </div>

      {/* Date range picker */}
      <div style={{
        backgroundColor: '#F9FAFB',
        border: '1px solid #E5E7EB',
        borderRadius: '8px',
        padding: '20px',
        marginBottom: '24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
          <h2 style={{ fontSize: '15px', fontWeight: '600', color: '#111827', margin: 0 }}>Add unavailability period</h2>
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: '#6B7280', marginBottom: '4px' }}>
              FROM
            </label>
            <input
              type="date"
              value={fromDate}
              min={todayStr()}
              onChange={e => {
                setFromDate(e.target.value)
                // Default TO to match FROM when empty; otherwise clear it if it's now before FROM
                if (!toDate) setToDate(e.target.value)
                else if (e.target.value > toDate) setToDate('')
              }}
              style={{
                padding: '8px 12px',
                border: '1px solid #E5E7EB',
                borderRadius: '6px',
                fontSize: '13px',
                color: '#111827',
                backgroundColor: '#ffffff',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: '#6B7280', marginBottom: '4px' }}>
              TO
            </label>
            <input
              type="date"
              value={toDate}
              min={fromDate || todayStr()}
              onChange={e => setToDate(e.target.value)}
              style={{
                padding: '8px 12px',
                border: '1px solid #E5E7EB',
                borderRadius: '6px',
                fontSize: '13px',
                color: '#111827',
                backgroundColor: '#ffffff',
              }}
            />
          </div>

          <button
            onClick={addHoliday}
            disabled={isSaving}
            className="btn-primary-hover"
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
            style={{
              padding: '8px 20px',
              backgroundColor: '#FF8303',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: '600',
              cursor: isSaving ? 'wait' : 'pointer',
              opacity: isSaving ? 0.7 : 1,
            }}
          >
            {isSaving ? 'Saving...' : 'Add'}
          </button>
        </div>

        {error && (
          <p style={{ fontSize: '12px', color: '#DC2626', marginTop: '8px' }}>{error}</p>
        )}
      </div>

      {/* Planned unavailability list */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <div style={{ width: '3px', height: '16px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
          <h2 style={{ fontSize: '15px', fontWeight: '600', color: '#111827', margin: 0 }}>Planned Unavailability</h2>
        </div>

        {deleteError && (
          <p style={{ fontSize: '12px', color: '#DC2626', marginBottom: '8px' }}>{deleteError}</p>
        )}

        {holidays.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#9CA3AF' }}>
            No holiday periods added yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {holidays
              .sort((a, b) => (a.start_at! > b.start_at! ? 1 : -1))
              .map(holiday => (
                <div
                  key={holiday.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #E5E7EB',
                    borderRadius: '8px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {/* Red dot indicator */}
                    <div style={{
                      width: '8px', height: '8px',
                      borderRadius: '50%',
                      backgroundColor: '#DC2626',
                      flexShrink: 0,
                    }} />
                    <span style={{ fontSize: '13px', color: '#111827', fontWeight: '500' }}>
                      {formatDate(holiday.start_at!.slice(0, 10))}
                      {' → '}
                      {formatDate(holiday.end_at!.slice(0, 10))}
                    </span>
                  </div>

                  <button
                    onClick={() => deleteHoliday(holiday.id)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#9CA3AF',
                      fontSize: '18px',
                      lineHeight: 1,
                      padding: '0 4px',
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
      {pendingDelete && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            backgroundColor: '#ffffff', borderRadius: '12px', padding: '28px 32px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: '280px', textAlign: 'center',
          }}>
            <p style={{ fontSize: '15px', fontWeight: '600', color: '#111827', marginBottom: '20px' }}>
              Remove this holiday period?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setPendingDelete(null)}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: '1px solid #D1D5DB',
                  backgroundColor: '#F3F4F6', color: '#374151', fontSize: '13px',
                  fontWeight: '600', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: 'none',
                  backgroundColor: '#DC2626', color: '#ffffff', fontSize: '13px',
                  fontWeight: '600', cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
