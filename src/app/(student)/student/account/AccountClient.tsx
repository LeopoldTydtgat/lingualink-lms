'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import Image from 'next/image'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Student {
  id: string
  full_name: string
  email: string
  photo_url: string | null
  timezone: string | null
  language_preference: string | null
  learning_goals: string | null
  interests: string | null
  self_assessed_level: string | null
}

interface Training {
  id: string
  student_id: string
  total_hours: number
  hours_consumed: number
  start_date: string | null
  end_date: string | null
  package_type: string | null
  status: string
}

interface Props {
  student: Student
  activeTraining: Training | null
  allTrainings: Training[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Oslo',
  'Europe/Copenhagen',
  'Europe/Helsinki',
  'Europe/Warsaw',
  'Europe/Prague',
  'Europe/Vienna',
  'Europe/Budapest',
  'Europe/Bucharest',
  'Europe/Athens',
  'Europe/Istanbul',
  'Africa/Johannesburg',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
]

const LANGUAGES = [
  'Afrikaans',
  'Arabic',
  'Chinese (Mandarin)',
  'Czech',
  'Danish',
  'Dutch',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hebrew',
  'Hungarian',
  'Italian',
  'Japanese',
  'Korean',
  'Norwegian',
  'Polish',
  'Portuguese',
  'Romanian',
  'Russian',
  'Spanish',
  'Swedish',
  'Turkish',
  'Ukrainian',
]

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

const STATUS_COLOURS: Record<string, { bg: string; color: string }> = {
  active:    { bg: '#dcfce7', color: '#166534' },
  completed: { bg: '#f3f4f6', color: '#374151' },
  expired:   { bg: '#fef3c7', color: '#92400e' },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

function hoursRemaining(training: Training): number {
  return Math.max(0, training.total_hours - training.hours_consumed)
}

// ─── Shared input style ───────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  fontSize: '14px',
  color: '#111827',
  backgroundColor: '#ffffff',
  outline: 'none',
  boxSizing: 'border-box',
}

const readonlyStyle: React.CSSProperties = {
  ...inputStyle,
  backgroundColor: '#f9fafb',
  color: '#6b7280',
  cursor: 'not-allowed',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: '600',
  color: '#374151',
  marginBottom: '6px',
}

const sectionCardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '12px',
  padding: '24px',
  marginBottom: '20px',
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: '700',
  color: '#111827',
  marginBottom: '20px',
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AccountClient({ student, activeTraining, allTrainings }: Props) {
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Profile photo
  const [photoUrl, setPhotoUrl] = useState<string | null>(student.photo_url)
  const [photoUploading, setPhotoUploading] = useState(false)
  const [photoError, setPhotoError] = useState('')

  // General info
  const [timezone, setTimezone] = useState(student.timezone ?? '')
  const [languagePref, setLanguagePref] = useState(student.language_preference ?? '')
  const [generalSaving, setGeneralSaving] = useState(false)
  const [generalSaved, setGeneralSaved] = useState(false)
  const [generalError, setGeneralError] = useState('')

  // Learning profile
  const [learningGoals, setLearningGoals] = useState(student.learning_goals ?? '')
  const [interests, setInterests] = useState(student.interests ?? '')
  const [selfLevel, setSelfLevel] = useState(student.self_assessed_level ?? '')
  const [learningSaving, setLearningSaving] = useState(false)
  const [learningSaved, setLearningSaved] = useState(false)
  const [learningError, setLearningError] = useState('')

  // Password change
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordSaved, setPasswordSaved] = useState(false)
  const [passwordError, setPasswordError] = useState('')

  // ── Photo upload ────────────────────────────────────────────────────────────

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate type and size
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowed.includes(file.type)) {
      setPhotoError('Only JPG, PNG or WebP images are allowed.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setPhotoError('Image must be under 2MB.')
      return
    }

    setPhotoError('')
    setPhotoUploading(true)

    try {
      const ext = file.name.split('.').pop()
      const path = `students/${student.id}/avatar.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true })

      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(path)

      const publicUrl = urlData.publicUrl

      const { error: updateError } = await supabase
        .from('students')
        .update({ photo_url: publicUrl })
        .eq('id', student.id)

      if (updateError) throw updateError

      setPhotoUrl(publicUrl)
    } catch {
      setPhotoError('Failed to upload photo. Please try again.')
    } finally {
      setPhotoUploading(false)
    }
  }

  // ── Save general info ───────────────────────────────────────────────────────

  async function handleSaveGeneral() {
    setGeneralSaving(true)
    setGeneralSaved(false)
    setGeneralError('')

    const { error } = await supabase
      .from('students')
      .update({ timezone, language_preference: languagePref })
      .eq('id', student.id)

    if (error) {
      setGeneralError('Failed to save. Please try again.')
    } else {
      setGeneralSaved(true)
      setTimeout(() => setGeneralSaved(false), 3000)
    }
    setGeneralSaving(false)
  }

  // ── Save learning profile ───────────────────────────────────────────────────

  async function handleSaveLearning() {
    setLearningSaving(true)
    setLearningSaved(false)
    setLearningError('')

    const { error } = await supabase
      .from('students')
      .update({
        learning_goals: learningGoals,
        interests,
        self_assessed_level: selfLevel,
      })
      .eq('id', student.id)

    if (error) {
      setLearningError('Failed to save. Please try again.')
    } else {
      setLearningSaved(true)
      setTimeout(() => setLearningSaved(false), 3000)
    }
    setLearningSaving(false)
  }

  // ── Change password ─────────────────────────────────────────────────────────

  async function handleChangePassword() {
    setPasswordError('')
    setPasswordSaved(false)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('Please fill in all three password fields.')
      return
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.')
      return
    }

    setPasswordSaving(true)

    // Verify current password by re-signing in
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: student.email,
      password: currentPassword,
    })

    if (signInError) {
      setPasswordError('Current password is incorrect.')
      setPasswordSaving(false)
      return
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    })

    if (updateError) {
      setPasswordError('Failed to update password. Please try again.')
    } else {
      setPasswordSaved(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setPasswordSaved(false), 3000)
    }
    setPasswordSaving(false)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: '720px' }}>

      {/* Page title */}
      <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#111827', marginBottom: '4px' }}>
        My Account
      </h1>
      <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '28px' }}>
        Manage your profile, preferences, and account settings.
      </p>

      {/* ── Profile Photo ── */}
      <div style={sectionCardStyle}>
        <p style={sectionTitleStyle}>Profile Photo</p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          {/* Avatar */}
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            backgroundColor: '#f3f4f6',
            border: '2px solid #e5e7eb',
            overflow: 'hidden',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {photoUrl ? (
              <Image
                src={photoUrl}
                alt="Profile photo"
                width={80}
                height={80}
                style={{ objectFit: 'cover', width: '100%', height: '100%' }}
              />
            ) : (
              <span style={{ fontSize: '28px', color: '#9ca3af' }}>
                {student.full_name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          {/* Upload controls */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={handlePhotoChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={photoUploading}
              style={{
                padding: '8px 16px',
                backgroundColor: '#FF8303',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: photoUploading ? 'not-allowed' : 'pointer',
                opacity: photoUploading ? 0.7 : 1,
              }}
            >
              {photoUploading ? 'Uploading…' : 'Upload Photo'}
            </button>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
              JPG, PNG or WebP — max 2MB
            </p>
            {photoError && (
              <p style={{ fontSize: '13px', color: '#dc2626', marginTop: '4px' }}>{photoError}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── General Information ── */}
      <div style={sectionCardStyle}>
        <p style={sectionTitleStyle}>General Information</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
          <div>
            <label style={labelStyle}>Full Name</label>
            <input style={readonlyStyle} value={student.full_name} readOnly />
            <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              To change your name, contact admin.
            </p>
          </div>
          <div>
            <label style={labelStyle}>Email Address</label>
            <input style={readonlyStyle} value={student.email} readOnly />
            <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
              Your login email — assigned by admin.
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
          <div>
            <label style={labelStyle}>Timezone</label>
            <select
              style={inputStyle}
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
            >
              <option value="">Select timezone…</option>
              {TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Language Preference</label>
            <select
              style={inputStyle}
              value={languagePref}
              onChange={e => setLanguagePref(e.target.value)}
            >
              <option value="">Select language…</option>
              {LANGUAGES.map(lang => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={handleSaveGeneral}
            disabled={generalSaving}
            style={{
              padding: '9px 20px',
              backgroundColor: '#FF8303',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: generalSaving ? 'not-allowed' : 'pointer',
              opacity: generalSaving ? 0.7 : 1,
            }}
          >
            {generalSaving ? 'Saving…' : 'Save Changes'}
          </button>
          {generalSaved && (
            <span style={{ fontSize: '13px', color: '#16a34a', fontWeight: '500' }}>✓ Saved</span>
          )}
          {generalError && (
            <span style={{ fontSize: '13px', color: '#dc2626' }}>{generalError}</span>
          )}
        </div>
      </div>

      {/* ── Learning Profile ── */}
      <div style={sectionCardStyle}>
        <p style={sectionTitleStyle}>Learning Profile</p>

        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Learning Goals</label>
          <textarea
            style={{ ...inputStyle, height: '80px', resize: 'vertical' }}
            value={learningGoals}
            onChange={e => setLearningGoals(e.target.value)}
            placeholder="e.g. I want to improve my business English for client meetings…"
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Interests</label>
          <textarea
            style={{ ...inputStyle, height: '80px', resize: 'vertical' }}
            value={interests}
            onChange={e => setInterests(e.target.value)}
            placeholder="e.g. Business, Travel, Technology, Culture…"
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={labelStyle}>My English Level (self-assessed)</label>
          <select
            style={{ ...inputStyle, maxWidth: '200px' }}
            value={selfLevel}
            onChange={e => setSelfLevel(e.target.value)}
          >
            <option value="">Select level…</option>
            {LEVELS.map(l => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
            Your teacher will assess your actual level during classes.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={handleSaveLearning}
            disabled={learningSaving}
            style={{
              padding: '9px 20px',
              backgroundColor: '#FF8303',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: learningSaving ? 'not-allowed' : 'pointer',
              opacity: learningSaving ? 0.7 : 1,
            }}
          >
            {learningSaving ? 'Saving…' : 'Save Changes'}
          </button>
          {learningSaved && (
            <span style={{ fontSize: '13px', color: '#16a34a', fontWeight: '500' }}>✓ Saved</span>
          )}
          {learningError && (
            <span style={{ fontSize: '13px', color: '#dc2626' }}>{learningError}</span>
          )}
        </div>
      </div>

      {/* ── Hours & Training ── */}
      {activeTraining && (
        <div style={sectionCardStyle}>
          <p style={sectionTitleStyle}>Hours &amp; Training</p>

          {/* Hours summary */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '16px',
            marginBottom: '20px',
          }}>
            <div style={{
              backgroundColor: '#fff7ed',
              border: '1px solid #fed7aa',
              borderRadius: '10px',
              padding: '16px',
              textAlign: 'center',
            }}>
              <p style={{ fontSize: '24px', fontWeight: '700', color: '#FF8303', margin: '0 0 4px' }}>
                {hoursRemaining(activeTraining)}h
              </p>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Hours remaining</p>
            </div>
            <div style={{
              backgroundColor: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              padding: '16px',
              textAlign: 'center',
            }}>
              <p style={{ fontSize: '24px', fontWeight: '700', color: '#111827', margin: '0 0 4px' }}>
                {activeTraining.hours_consumed}h
              </p>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Hours used</p>
            </div>
            <div style={{
              backgroundColor: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              padding: '16px',
              textAlign: 'center',
            }}>
              <p style={{ fontSize: '24px', fontWeight: '700', color: '#111827', margin: '0 0 4px' }}>
                {activeTraining.total_hours}h
              </p>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Total purchased</p>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: '#6b7280',
              marginBottom: '6px',
            }}>
              <span>Hours used</span>
              <span>{Math.round((activeTraining.hours_consumed / activeTraining.total_hours) * 100)}%</span>
            </div>
            <div style={{ backgroundColor: '#e5e7eb', borderRadius: '999px', height: '8px' }}>
              <div style={{
                backgroundColor: '#FF8303',
                borderRadius: '999px',
                height: '8px',
                width: `${Math.min(100, Math.round((activeTraining.hours_consumed / activeTraining.total_hours) * 100))}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>

          {/* Details */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            <div>
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: '0 0 2px' }}>Package</p>
              <p style={{ fontSize: '14px', fontWeight: '500', color: '#111827', margin: 0 }}>
                {activeTraining.package_type ?? '—'}
              </p>
            </div>
            <div>
              <p style={{ fontSize: '12px', color: '#9ca3af', margin: '0 0 2px' }}>Training ends</p>
              <p style={{ fontSize: '14px', fontWeight: '500', color: '#111827', margin: 0 }}>
                {formatDate(activeTraining.end_date)}
              </p>
            </div>
          </div>

          {/* Low hours warning */}
          {hoursRemaining(activeTraining) < 2 && (
            <div style={{
              backgroundColor: '#fef3c7',
              border: '1px solid #fcd34d',
              borderRadius: '8px',
              padding: '12px 16px',
              marginBottom: '16px',
              fontSize: '13px',
              color: '#92400e',
            }}>
              ⚠️ You have less than 2 hours remaining. Contact admin to purchase more hours.
            </div>
          )}

          <a
            href="mailto:info@lingualinkonline.com"
            style={{
              display: 'inline-block',
              padding: '9px 20px',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              textDecoration: 'none',
            }}
          >
            Need more hours? Contact us →
          </a>
        </div>
      )}

      {/* ── Training History ── */}
      {allTrainings.length > 0 && (
        <div style={sectionCardStyle}>
          <p style={sectionTitleStyle}>Training History</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {allTrainings.map(t => {
              const statusStyle = STATUS_COLOURS[t.status] ?? STATUS_COLOURS.completed
              const remaining = hoursRemaining(t)
              return (
                <div
                  key={t.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '14px 16px',
                    backgroundColor: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: '10px',
                  }}
                >
                  <div>
                    <p style={{ fontSize: '14px', fontWeight: '600', color: '#111827', margin: '0 0 2px' }}>
                      {t.package_type ?? 'Training Package'}
                    </p>
                    <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>
                      {formatDate(t.start_date)} → {formatDate(t.end_date)}
                      &nbsp;·&nbsp;{t.total_hours}h total
                      &nbsp;·&nbsp;{t.hours_consumed}h used
                      &nbsp;·&nbsp;{remaining}h remaining
                    </p>
                  </div>
                  <span style={{
                    padding: '3px 10px',
                    borderRadius: '999px',
                    fontSize: '11px',
                    fontWeight: '600',
                    backgroundColor: statusStyle.bg,
                    color: statusStyle.color,
                    textTransform: 'capitalize',
                  }}>
                    {t.status}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Change Password ── */}
      <div style={sectionCardStyle}>
        <p style={sectionTitleStyle}>Change Password</p>

        <div style={{ maxWidth: '400px' }}>
          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>Current Password</label>
            <input
              type="password"
              style={inputStyle}
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
            />
          </div>
          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>New Password</label>
            <input
              type="password"
              style={inputStyle}
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="Minimum 8 characters"
            />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label style={labelStyle}>Confirm New Password</label>
            <input
              type="password"
              style={inputStyle}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Repeat new password"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={handleChangePassword}
              disabled={passwordSaving}
              style={{
                padding: '9px 20px',
                backgroundColor: '#FF8303',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: passwordSaving ? 'not-allowed' : 'pointer',
                opacity: passwordSaving ? 0.7 : 1,
              }}
            >
              {passwordSaving ? 'Saving…' : 'Update Password'}
            </button>
            {passwordSaved && (
              <span style={{ fontSize: '13px', color: '#16a34a', fontWeight: '500' }}>✓ Password updated</span>
            )}
            {passwordError && (
              <span style={{ fontSize: '13px', color: '#dc2626' }}>{passwordError}</span>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
