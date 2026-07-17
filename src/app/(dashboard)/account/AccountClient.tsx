'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  User,
  Briefcase,
  BookOpen,
  Star,
  Camera,
  X,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
} from 'lucide-react'
import TimezoneSelect from '@/components/TimezoneSelect'
import { toast } from 'sonner'
import { validatePassword } from '@/lib/passwordValidation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Profile {
  id: string
  email: string
  full_name: string | null  // FIX: was string, must be nullable
  role: string
  photo_url: string | null
  timezone: string | null
  bio: string | null
  teaching_languages: string[] | null
  speaking_languages: string[] | null
  preferred_payment_type: string | null
  paypal_email: string | null
  iban: string | null
  bic: string | null
  tax_number: string | null
  street_address: string | null
  area_code: string | null
  city: string | null
  hourly_rate: number | null
  currency: string | null
}

interface Resource {
  id: string
  title: string
  url: string
  description: string | null
  display_order: number
}

interface Review {
  id: string
  rating: number
  review_text: string | null
  is_visible: boolean
  created_at: string
  student_id: string
  students: {
    full_name: string
    photo_url: string | null
  } | null
}

interface Props {
  profile: Profile
  resources: Resource[]
  reviews: Review[]
  userId: string
}

// ─── Tab definitions ────────────────────────────────────────────────────────

const TABS = [
  { id: 'general',      label: 'General Info',      icon: User },
  { id: 'professional', label: 'Professional Info',  icon: Briefcase },
  { id: 'resources',    label: 'Useful Resources',   icon: BookOpen },
  { id: 'feedback',     label: 'Student Feedback',   icon: Star },
  { id: 'security',     label: 'Security',           icon: Lock },
]

// ─── Star display component ───────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  return (
    <div style={{ display: 'flex', gap: '2px' }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={16}
          style={{
            fill: star <= rating ? '#FF8303' : 'none',
            color: star <= rating ? '#FF8303' : '#d1d5db',
          }}
        />
      ))}
    </div>
  )
}

// ─── Tag input component ──────────────────────────────────────────────────────

function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  placeholder: string
}) {
  const [input, setInput] = useState('')

  function addTag() {
    const trimmed = input.trim()
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed])
    }
    setInput('')
  }

  function removeTag(tag: string) {
    onChange(values.filter((v) => v !== tag))
  }

  return (
    <div>
      <Label style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
        {label}
      </Label>
      <div
        style={{
          border: '1px solid #e0dfdc',
          borderRadius: '8px',
          padding: '8px',
          minHeight: '44px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          alignItems: 'center',
          backgroundColor: 'white',
        }}
      >
        {values.map((tag) => (
          <span
            key={tag}
            style={{
              backgroundColor: '#fff3e8',
              border: '1px solid #FF8303',
              color: '#FF8303',
              borderRadius: '999px',
              padding: '2px 10px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              style={{ lineHeight: 1, cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
            >
              <X size={12} color="#FF8303" />
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addTag()
            }
          }}
          placeholder={values.length === 0 ? placeholder : ''}
          style={{
            border: 'none',
            outline: 'none',
            fontSize: '14px',
            flex: 1,
            minWidth: '120px',
            backgroundColor: 'transparent',
          }}
        />
      </div>
      <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
        Press Enter or comma to add
      </p>
    </div>
  )
}

// ─── Public Profile Modal ─────────────────────────────────────────────────────

function PublicProfileModal({
  profile,
  reviews,
  onClose,
}: {
  profile: Profile
  reviews: Review[]
  onClose: () => void
}) {
  const avgRating =
    reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        className="thin-scroll"
        style={{
          backgroundColor: 'white',
          borderRadius: '14px',
          width: '100%',
          maxWidth: '560px',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px',
            borderBottom: '1px solid #e0dfdc',
          }}
        >
          <div>
            <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '2px' }}>Preview</p>
            <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#111' }}>
              Your Public Profile
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              color: '#9ca3af',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Profile content */}
        <div style={{ padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>

          {/* Photo + name + rating */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div
              style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                overflow: 'hidden',
                backgroundColor: '#e0dfdc',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {profile.photo_url ? (
                <img
                  src={profile.photo_url}
                  alt={profile.full_name ?? ''}  // FIX: null-safe
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <User size={36} color="#9ca3af" />
              )}
            </div>
            <div>
              <h3 style={{ fontSize: '20px', fontWeight: 700, color: '#111', marginBottom: '6px' }}>
                {profile.full_name ?? ''}  {/* FIX: null-safe */}
              </h3>
              {avgRating !== null ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <StarRating rating={Math.round(avgRating)} />
                  <span style={{ fontSize: '13px', color: '#6b7280' }}>
                    {avgRating.toFixed(1)} ({reviews.length} {reviews.length === 1 ? 'review' : 'reviews'})
                  </span>
                </div>
              ) : (
                <p style={{ fontSize: '13px', color: '#9ca3af' }}>No reviews yet</p>
              )}
            </div>
          </div>

          {/* Languages */}
          {((profile.teaching_languages?.length ?? 0) > 0 ||
            (profile.speaking_languages?.length ?? 0) > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {(profile.teaching_languages?.length ?? 0) > 0 && (
                <div>
                  <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                    I TEACH:
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {profile.teaching_languages!.map((lang) => (
                      <span
                        key={lang}
                        style={{
                          backgroundColor: '#fff3e8',
                          border: '1px solid #FF8303',
                          color: '#FF8303',
                          borderRadius: '999px',
                          padding: '3px 12px',
                          fontSize: '13px',
                        }}
                      >
                        {lang}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(profile.speaking_languages?.length ?? 0) > 0 && (
                <div>
                  <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                    Also speaks
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {profile.speaking_languages!.map((lang) => (
                      <span
                        key={lang}
                        style={{
                          backgroundColor: '#f9fafb',
                          border: '1px solid #e0dfdc',
                          color: '#6b7280',
                          borderRadius: '999px',
                          padding: '3px 12px',
                          fontSize: '13px',
                        }}
                      >
                        {lang}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Bio */}
          {profile.bio && (
            <div>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
                About
              </p>
              <p style={{ fontSize: '14px', color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                {profile.bio}
              </p>
            </div>
          )}

          {/* Reviews */}
          {reviews.length > 0 && (
            <div>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px' }}>
                Student Reviews
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {reviews.slice(0, 3).map((review) => {
                  const student = Array.isArray(review.students)
                    ? review.students[0]
                    : review.students
                  return (
                    <div
                      key={review.id}
                      style={{
                        backgroundColor: '#f9fafb',
                        borderRadius: '8px',
                        padding: '14px 16px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <p style={{ fontSize: '13px', fontWeight: 600, color: '#111' }}>
                          {student?.full_name ?? 'Student'}
                        </p>
                        <StarRating rating={review.rating} />
                      </div>
                      {review.review_text && (
                        <p style={{ fontSize: '13px', color: '#6b7280', lineHeight: 1.5 }}>
                          {review.review_text}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid #e0dfdc',
            backgroundColor: '#f9fafb',
            borderRadius: '0 0 14px 14px',
          }}
        >
          <p style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'center' }}>
            This is a preview of how your profile appears to students on the Student Portal.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AccountClient({ profile, resources, reviews, userId }: Props) {
  // supabase browser client is used for storage (photo upload/URL) and for
  // auth calls (password change re-auth + update). All profile table writes
  // go through /api/profile to bypass RLS.
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()
  const mustConfirmTz = searchParams.get('confirm_tz') === '1'
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [activeTab, setActiveTab] = useState('general')
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [showPublicProfile, setShowPublicProfile] = useState(false)

  // General Info state
  const [fullName, setFullName] = useState(profile.full_name ?? '')
  const [timezone, setTimezone] = useState(profile.timezone ?? '')
  useEffect(() => {
    if (timezone === '' || mustConfirmTz) {
      try {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (detected) setTimezone(detected)
      } catch {
        // detection unavailable — leave as-is; user picks manually
      }
    }
    // run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [photoUrl, setPhotoUrl] = useState(profile.photo_url ?? '')

  // Professional Info state
  const [bio, setBio] = useState(profile.bio ?? '')
  const [teachingLanguages, setTeachingLanguages] = useState<string[]>(
    profile.teaching_languages ?? []
  )
  const [speakingLanguages, setSpeakingLanguages] = useState<string[]>(
    profile.speaking_languages ?? []
  )

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordSaved, setPasswordSaved] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // ── Photo upload ────────────────────────────────────────────────────────────

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a JPG, PNG, or WebP image.', { duration: 6000 })
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Image must be under 2MB.', { duration: 6000 })
      return
    }

    setUploadingPhoto(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `${userId}/avatar.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true })

      if (uploadError) throw uploadError

      const { data } = supabase.storage.from('avatars').getPublicUrl(path)
      const publicUrl = `${data.publicUrl}?t=${Date.now()}`

      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_url: publicUrl }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? 'Failed to save photo URL')
      }

      setPhotoUrl(publicUrl)
      toast.success('Profile photo updated.')
      router.refresh()
    } catch (err) {
      console.error('handlePhotoUpload error:', err)
      toast.error('Failed to upload photo. Please try again.', { duration: 6000 })
    } finally {
      setUploadingPhoto(false)
    }
  }

  // ── Save General Info ───────────────────────────────────────────────────────

  async function saveGeneralInfo() {
    if (!fullName.trim()) {
      toast.error('Full name is required.', { duration: 6000 })
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName.trim(),
          timezone: timezone || null,
        }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? 'Save failed')
      }
      toast.success('General info saved.')
      router.refresh()
    } catch (err) {
      console.error('saveGeneralInfo error:', err)
      toast.error('Failed to save. Please try again.', { duration: 6000 })
    } finally {
      setSaving(false)
    }
  }

  // ── Save Professional Info ──────────────────────────────────────────────────

  async function saveProfessionalInfo() {
    setSaving(true)
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bio: bio.trim() || null,
          teaching_languages: teachingLanguages,
          speaking_languages: speakingLanguages,
        }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? 'Save failed')
      }
      toast.success('Professional info saved.')
      router.refresh()
    } catch (err) {
      console.error('saveProfessionalInfo error:', err)
      toast.error('Failed to save. Please try again.', { duration: 6000 })
    } finally {
      setSaving(false)
    }
  }

  // ── Change Password ─────────────────────────────────────────────────────────

  async function handleChangePassword() {
    setPasswordError('')
    setPasswordSaved(false)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('Please fill in all three password fields.')
      return
    }
    const validationError = validatePassword(newPassword)
    if (validationError) {
      setPasswordError(validationError)
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.')
      return
    }

    setPasswordSaving(true)

    // Verify current password by re-signing in
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: profile.email,
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
      setPasswordError(updateError.message || 'Failed to update password. Please try again.')
    } else {
      setPasswordSaved(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setPasswordSaved(false), 3000)
    }
    setPasswordSaving(false)
  }

  // ── Average rating ──────────────────────────────────────────────────────────

  const avgRating =
    reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null

  // ── Live profile for preview — reflects any unsaved changes ────────────────

  const liveProfile: Profile = {
    ...profile,
    full_name: fullName,
    timezone,
    photo_url: photoUrl || profile.photo_url,
    bio,
    teaching_languages: teachingLanguages,
    speaking_languages: speakingLanguages,
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <style>{`
        .account-general-grid { display: grid; grid-template-columns: 220px 1fr; gap: 32px; }
        @media (max-width: 768px) { .account-general-grid { grid-template-columns: 1fr; } }
      `}</style>

      {/* Timezone confirmation banner — shown when redirected from a time-sensitive page with ?confirm_tz=1 */}
      {mustConfirmTz && (
        <div style={{
          backgroundColor: '#FFF7ED',
          borderLeft: '4px solid #FF8303',
          borderRadius: '8px',
          padding: '16px 20px',
          marginBottom: '24px',
        }}>
          <p style={{ margin: '0 0 6px', fontSize: '15px', fontWeight: 600, color: '#111827' }}>
            Confirm your timezone
          </p>
          <p style={{ margin: 0, fontSize: '14px', color: '#374151', lineHeight: 1.6 }}>
            We&apos;ve set your timezone to your best guess. Please check it&apos;s correct below and click Save Changes — your class times depend on it.
          </p>
        </div>
      )}

      {/* Page header */}
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#111' }}>
          My Account
        </h1>
        <Button
          variant="outline"
          onClick={() => setShowPublicProfile(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}
        >
          <Eye size={15} />
          See My Public Profile
        </Button>
      </div>

      {/* Tab bar — 5 tabs, no overflow */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #e0dfdc',
          marginBottom: '32px',
        }}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '10px 20px',
              minWidth: '150px',
              fontSize: '14px',
              fontWeight: activeTab === id ? 600 : 400,
              color: activeTab === id ? '#FF8303' : '#6b7280',
              background: 'none',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
              borderBottomWidth: '2px',
              borderBottomStyle: 'solid',
              borderBottomColor: activeTab === id ? '#FF8303' : 'transparent',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              marginBottom: '-1px',
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Tab: General Info ─────────────────────────────────────────────── */}
      {activeTab === 'general' && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="account-general-grid">

            {/* Left column: Profile photo */}
            <div>
              <Label style={{ fontSize: '14px', fontWeight: 500, marginBottom: '12px', display: 'block' }}>
                Profile Photo
              </Label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div
                  style={{
                    width: '80px',
                    height: '80px',
                    borderRadius: '50%',
                    overflow: 'hidden',
                    backgroundColor: '#e0dfdc',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {photoUrl ? (
                    <img
                      src={photoUrl}
                      alt="Profile"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <User size={32} color="#9ca3af" />
                  )}
                </div>
                <div>
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingPhoto}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}
                  >
                    <Camera size={15} />
                    {uploadingPhoto ? 'Uploading...' : 'Upload Photo'}
                  </Button>
                  <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
                    JPG, PNG or WebP. Max 2MB.
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handlePhotoUpload}
                  style={{ display: 'none' }}
                />
              </div>
            </div>

            {/* Right column: Full Name / Email / Timezone / Save */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>

              {/* Full name */}
              <div>
                <Label htmlFor="fullName" style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                  Full Name
                </Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  style={{ maxWidth: '400px', fontSize: '14px' }}
                />
              </div>

              {/* Email — read only */}
              <div>
                <Label style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                  Email Address
                </Label>
                <Input
                  value={profile.email}
                  readOnly
                  style={{
                    maxWidth: '400px',
                    fontSize: '14px',
                    backgroundColor: '#f9fafb',
                    color: '#6b7280',
                    cursor: 'not-allowed',
                  }}
                />
                <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  Email is assigned by admin and cannot be changed here.
                </p>
              </div>

              {/* Timezone */}
              <div>
                <Label htmlFor="timezone" style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                  Timezone
                </Label>
                <div style={{ maxWidth: '400px' }}>
                  <TimezoneSelect value={timezone} onChange={setTimezone} />
                </div>
                <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
                  This controls how all class times are displayed for you.
                </p>
              </div>

              <div>
                <Button
                  onClick={saveGeneralInfo}
                  disabled={saving}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
                  style={{
                    backgroundColor: '#FF8303',
                    color: 'white',
                    border: 'none',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: saving ? 'not-allowed' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Professional Info ────────────────────────────────────────── */}
      {activeTab === 'professional' && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>

          <TagInput
            label="I Teach:"
            values={teachingLanguages}
            onChange={setTeachingLanguages}
            placeholder="e.g. English"
          />

          <TagInput
            label="Speaking Languages"
            values={speakingLanguages}
            onChange={setSpeakingLanguages}
            placeholder="e.g. French, German"
          />

          <div>
            <Label htmlFor="bio" style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              Self Introduction
            </Label>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '8px' }}>
              This appears on your public profile visible to students.
            </p>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={6}
              placeholder="Write a short introduction about yourself, your teaching style, and your experience..."
              style={{ fontSize: '14px', resize: 'vertical' }}
            />
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px', textAlign: 'right' }}>
              {bio.length} characters
            </p>
          </div>

          <div>
            <Button
              onClick={saveProfessionalInfo}
              disabled={saving}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
              style={{
                backgroundColor: '#FF8303',
                color: 'white',
                border: 'none',
                fontSize: '14px',
                fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
          </div>
        </div>
      )}

      {/* ── Tab: Security ─────────────────────────────────────────────────── */}
      {activeTab === 'security' && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: '400px' }}>

          <div>
            <Label htmlFor="currentPassword" style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              Current Password
            </Label>
            <div style={{ position: 'relative' }}>
              <Input
                id="currentPassword"
                type={showCurrentPassword ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                style={{ fontSize: '14px', paddingRight: '40px' }}
              />
              <button
                type="button"
                onClick={() => setShowCurrentPassword(v => !v)}
                style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                aria-label={showCurrentPassword ? 'Hide password' : 'Show password'}
              >
                {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <Label htmlFor="newPassword" style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              New Password
            </Label>
            <div style={{ position: 'relative' }}>
              <Input
                id="newPassword"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                style={{ fontSize: '14px', paddingRight: '40px' }}
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(v => !v)}
                style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                aria-label={showNewPassword ? 'Hide password' : 'Show password'}
              >
                {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
              At least 8 characters, including an uppercase letter, a lowercase letter and a number.
            </p>
          </div>

          <div>
            <Label htmlFor="confirmPassword" style={{ fontSize: '14px', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
              Confirm New Password
            </Label>
            <div style={{ position: 'relative' }}>
              <Input
                id="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
                style={{ fontSize: '14px', paddingRight: '40px' }}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(v => !v)}
                style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
              >
                {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <Button
              onClick={handleChangePassword}
              disabled={passwordSaving}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#e67300')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#FF8303')}
              style={{
                backgroundColor: '#FF8303',
                color: 'white',
                border: 'none',
                fontSize: '14px',
                fontWeight: 600,
                cursor: passwordSaving ? 'not-allowed' : 'pointer',
                opacity: passwordSaving ? 0.7 : 1,
              }}
            >
              {passwordSaving ? 'Saving...' : 'Update Password'}
            </Button>
            {passwordSaved && (
              <p style={{ fontSize: '13px', color: '#16a34a', fontWeight: 500, marginTop: '8px' }}>
                ✓ Password updated
              </p>
            )}
            {passwordError && (
              <p style={{ fontSize: '13px', color: '#dc2626', marginTop: '8px' }}>
                {passwordError}
              </p>
            )}
          </div>
          </div>
        </div>
      )}

      {/* ── Tab: Useful Resources ─────────────────────────────────────────── */}
      {activeTab === 'resources' && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          {resources.length === 0 ? (
            <div
              style={{
                padding: '40px',
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: '14px',
              }}
            >
              No resources have been added yet. Your admin will add helpful links here for teachers.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {resources.map((resource) => (
                <a
                  key={resource.id}
                  href={resource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '16px 20px',
                    backgroundColor: 'white',
                    border: '1px solid #f3f4f6',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                    borderRadius: '10px',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = '#FF8303'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = '#f3f4f6'
                  }}
                >
                  <div>
                    <p style={{ fontSize: '14px', fontWeight: 600, color: '#111', marginBottom: '2px' }}>
                      {resource.title}
                    </p>
                    {resource.description && (
                      <p style={{ fontSize: '13px', color: '#6b7280' }}>{resource.description}</p>
                    )}
                  </div>
                  <ExternalLink size={16} color="#9ca3af" style={{ flexShrink: 0, marginLeft: '12px' }} />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Student Feedback ─────────────────────────────────────────── */}
      {activeTab === 'feedback' && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          {reviews.length === 0 ? (
            <div
              style={{
                padding: '40px',
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: '14px',
              }}
            >
              No student reviews yet.
            </div>
          ) : (
            <>
              {/* Rating summary */}
              <div
                style={{
                  backgroundColor: '#fff8f0',
                  border: '1px solid #ffe4c4',
                  borderRadius: '10px',
                  padding: '20px 24px',
                  marginBottom: '24px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '20px',
                }}
              >
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: '36px', fontWeight: 700, color: '#FF8303', lineHeight: 1 }}>
                    {avgRating!.toFixed(1)}
                  </p>
                  <StarRating rating={Math.round(avgRating!)} />
                </div>
                <div style={{ borderLeft: '1px solid #ffe4c4', paddingLeft: '20px' }}>
                  <p style={{ fontSize: '14px', color: '#6b7280' }}>
                    Based on <strong style={{ color: '#111' }}>{reviews.length}</strong>{' '}
                    {reviews.length === 1 ? 'review' : 'reviews'}
                  </p>
                </div>
              </div>

              {/* Review cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {reviews.map((review) => {
                  const student = Array.isArray(review.students)
                    ? review.students[0]
                    : review.students

                  const dateStr = new Date(review.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })

                  return (
                    <div
                      key={review.id}
                      style={{
                        backgroundColor: 'white',
                        border: '1px solid #f3f4f6',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                        borderRadius: '10px',
                        padding: '20px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '12px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '40px',
                              height: '40px',
                              borderRadius: '50%',
                              backgroundColor: '#e0dfdc',
                              overflow: 'hidden',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            {student?.photo_url ? (
                              <img
                                src={student.photo_url}
                                alt={student.full_name}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <User size={20} color="#9ca3af" />
                            )}
                          </div>
                          <div>
                            <p style={{ fontSize: '14px', fontWeight: 600, color: '#111' }}>
                              {student?.full_name ?? 'Student'}
                            </p>
                            <p style={{ fontSize: '12px', color: '#9ca3af' }}>{dateStr}</p>
                          </div>
                        </div>
                        <StarRating rating={review.rating} />
                      </div>
                      {review.review_text && (
                        <p style={{ fontSize: '14px', color: '#374151', lineHeight: 1.6 }}>
                          {review.review_text}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Public profile modal */}
      {showPublicProfile && (
        <PublicProfileModal
          profile={liveProfile}
          reviews={reviews}
          onClose={() => setShowPublicProfile(false)}
        />
      )}
    </div>
  )
}
