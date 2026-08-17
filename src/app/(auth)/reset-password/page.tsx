'use client'

import { Suspense, useState, useEffect, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { validatePassword } from '@/lib/passwordValidation'

function ResetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [verifyFailed, setVerifyFailed] = useState(false)
  const [isStudent, setIsStudent] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const supabase = createClient()

  // Reset email links here with ?token_hash=...&type=recovery (Supabase OTP flow).
  // Exchange the token for a recovery session before showing the password form.
  const tokenHash = searchParams.get('token_hash')
  const recoveryType = searchParams.get('type')
  const tokenMissing = !tokenHash || recoveryType !== 'recovery'
  const linkInvalid = tokenMissing || verifyFailed

  useEffect(() => {
    if (tokenMissing) return

    supabase.auth
      .verifyOtp({ token_hash: tokenHash!, type: 'recovery' })
      .then(async ({ error: verifyError }) => {
        if (verifyError) {
          setVerifyFailed(true)
          return
        }

        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setVerifyFailed(true)
          return
        }

        try {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', user.id)
            .maybeSingle()

          // No profiles row = student. The recovery token was verified on THIS
          // page, so the student sets their password right here; we only route
          // them to the student login afterwards. (The old cross-domain
          // redirect relied on a bare session and let any live session reach
          // the student reset form - SEC-C2.)
          // On a lookup ERROR we cannot classify, so default to teacher
          // routing - maybeSingle returns { data: null, error } without
          // throwing, and a null-from-error must not read as "student".
          if (!profileError && !profile) setIsStudent(true)
          setSessionReady(true)
        } catch {
          // Profiles lookup failed: the token itself was just verified, so the
          // reset is legitimate - show the form, default to teacher routing.
          setSessionReady(true)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenMissing, tokenHash])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const validationError = validatePassword(password)
    if (validationError) {
      setError(validationError)
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    startTransition(async () => {
      // Force session refresh from cookies. Without this, auth-js uses stale
      // in-memory state from before verifyOtp wrote the recovery session,
      // causing updateUser to 401. Found via diagnostic logging in session 89.
      await supabase.auth.getUser() // refreshes session state from cookies before updateUser
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        setError(updateError.message || 'Something went wrong. Your reset link may have expired. Please request a new one.')
        return
      }

      setSuccess(true)

      // Sign out so the user lands on a clean login page
      await supabase.auth.signOut()

      setTimeout(() => {
        if (isStudent) {
          const studentUrl = process.env.NEXT_PUBLIC_STUDENT_URL
          if (studentUrl) {
            window.location.href = `${studentUrl}/student/login`
            return
          }
        }
        router.push('/login')
      }, 3000)
    })
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#f5f5f5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Inter, sans-serif',
        padding: '24px',
      }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          padding: '48px 40px',
          width: '100%',
          maxWidth: '420px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        }}
      >
        {/* Logo area */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div
            style={{
              display: 'inline-block',
              backgroundColor: '#FF8303',
              borderRadius: '8px',
              padding: '10px 20px',
              marginBottom: '16px',
            }}
          >
            <span
              style={{
                color: '#ffffff',
                fontWeight: 700,
                fontSize: '18px',
                letterSpacing: '0.5px',
              }}
            >
              Lingualink Online
            </span>
          </div>
          <h1
            style={{
              fontSize: '20px',
              fontWeight: 700,
              color: '#000000',
              margin: '0 0 6px 0',
            }}
          >
            Set your password
          </h1>
          <p style={{ fontSize: '14px', color: '#666666', margin: 0 }}>
            Choose a new password for your account
          </p>
        </div>

        {/* Success state */}
        {success ? (
          <div
            style={{
              backgroundColor: '#f0faf0',
              border: '1px solid #4caf50',
              borderRadius: '8px',
              padding: '16px',
              fontSize: '14px',
              color: '#2e7d32',
              textAlign: 'center',
              lineHeight: '1.5',
            }}
          >
            Your password has been updated. Redirecting you to sign in...
          </div>

        ) : linkInvalid ? (
          /* Token missing or verifyOtp failed */
          <div>
            <div
              style={{
                backgroundColor: '#fff4f4',
                border: '1px solid #FD5602',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '24px',
                fontSize: '14px',
                color: '#FD5602',
                textAlign: 'center',
                lineHeight: '1.5',
              }}
            >
              This reset link is invalid or has expired.
            </div>
            <a
              href="/forgot-password"
              style={{
                display: 'block',
                textAlign: 'center',
                fontSize: '14px',
                color: '#FF8303',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              Request a new reset link
            </a>
          </div>

        ) : !sessionReady ? (
          /* Waiting for verifyOtp to resolve */
          <div
            style={{
              textAlign: 'center',
              fontSize: '14px',
              color: '#666666',
              padding: '24px 0',
            }}
          >
            Verifying your reset link...
          </div>

        ) : (
          <>
            {/* Error message */}
            {error && (
              <div
                style={{
                  backgroundColor: '#fff4f4',
                  border: '1px solid #FD5602',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  marginBottom: '20px',
                  fontSize: '14px',
                  color: '#FD5602',
                }}
              >
                {error}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '16px' }}>
                <label
                  htmlFor="password"
                  style={{
                    display: 'block',
                    fontSize: '14px',
                    fontWeight: 600,
                    color: '#000000',
                    marginBottom: '6px',
                  }}
                >
                  New password
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    placeholder="Enter new password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 44px 10px 14px',
                      fontSize: '14px',
                      border: '1px solid #E0DFDC',
                      borderRadius: '8px',
                      outline: 'none',
                      boxSizing: 'border-box',
                      fontFamily: 'Inter, sans-serif',
                      color: '#000000',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <p style={{ fontSize: '12px', color: '#666666', marginTop: '6px', marginBottom: 0 }}>
                  At least 8 characters, including an uppercase letter, a lowercase letter and a number.
                </p>
              </div>

              <div style={{ marginBottom: '24px' }}>
                <label
                  htmlFor="confirmPassword"
                  style={{
                    display: 'block',
                    fontSize: '14px',
                    fontWeight: 600,
                    color: '#000000',
                    marginBottom: '6px',
                  }}
                >
                  Confirm new password
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    placeholder="Repeat your new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 44px 10px 14px',
                      fontSize: '14px',
                      border: '1px solid #E0DFDC',
                      borderRadius: '8px',
                      outline: 'none',
                      boxSizing: 'border-box',
                      fontFamily: 'Inter, sans-serif',
                      color: '#000000',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(v => !v)}
                    style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isPending}
                style={{
                  width: '100%',
                  padding: '12px',
                  backgroundColor: isPending ? '#ffb366' : '#FF8303',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: isPending ? 'not-allowed' : 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  transition: 'background-color 0.15s',
                }}
              >
                {isPending ? 'Saving...' : 'Set password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  )
}
