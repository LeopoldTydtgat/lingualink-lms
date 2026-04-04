'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserSupabaseClient } from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [isPending, startTransition] = useTransition()

  const supabase = createBrowserSupabaseClient()

  // Supabase automatically exchanges the token in the URL hash for a session
  // We wait for that to happen before showing the form
  useEffect(() => {
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setSessionReady(true)
      }
    })
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    startTransition(async () => {
      const { error: updateError } = await supabase.auth.updateUser({ password })

      if (updateError) {
        setError('Something went wrong. Your reset link may have expired. Please request a new one.')
        return
      }

      setSuccess(true)

      // Sign out so the student lands on a clean login page
      await supabase.auth.signOut()

      setTimeout(() => {
        router.push('/student/login')
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
            Your password has been updated. Redirecting you to sign in…
          </div>

        ) : !sessionReady ? (
          /* Waiting for Supabase to exchange the token */
          <div
            style={{
              textAlign: 'center',
              fontSize: '14px',
              color: '#666666',
              padding: '24px 0',
            }}
          >
            Verifying your reset link…
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
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Minimum 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    fontSize: '14px',
                    border: '1px solid #E0DFDC',
                    borderRadius: '8px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'Inter, sans-serif',
                    color: '#000000',
                  }}
                />
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
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Repeat your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    fontSize: '14px',
                    border: '1px solid #E0DFDC',
                    borderRadius: '8px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'Inter, sans-serif',
                    color: '#000000',
                  }}
                />
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
                {isPending ? 'Saving…' : 'Set password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}