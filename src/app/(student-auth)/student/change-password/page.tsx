'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function ChangePasswordPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    const formData = new FormData(e.currentTarget)
    const password = formData.get('password') as string
    const confirm = formData.get('confirm') as string

    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    startTransition(async () => {
      const res = await fetch('/api/student/change-password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        router.push('/student/my-classes')
      }
    })
  }

  return (
    <>
      <style>{`html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }`}</style>
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#ffffff',
        fontFamily: 'Inter, sans-serif',
      }}>
        <div style={{ width: '100%', maxWidth: '400px', padding: '0 24px' }}>

          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <img
              src="/lingualink-logo-clean.svg"
              alt="Lingualink Online"
              style={{ height: '64px', width: 'auto' }}
            />
          </div>

          <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: '0 0 8px', textAlign: 'center' }}>
            Set Your Password
          </h1>
          <p style={{ fontSize: '14px', color: '#6b7280', margin: '0 0 32px', textAlign: 'center' }}>
            Please set a new password to continue.
          </p>

          {error && (
            <div style={{
              backgroundColor: '#fff4f4',
              border: '1px solid #FD5602',
              borderRadius: '8px',
              padding: '12px 16px',
              marginBottom: '20px',
              fontSize: '14px',
              color: '#FD5602',
            }}>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="password" style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                placeholder="At least 8 characters"
                style={{
                  width: '100%',
                  padding: '11px 14px',
                  fontSize: '14px',
                  border: '1px solid #E0DFDC',
                  borderRadius: '8px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: 'Inter, sans-serif',
                  color: '#111827',
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="confirm" style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>
                Confirm password
              </label>
              <input
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={8}
                placeholder="Repeat your password"
                style={{
                  width: '100%',
                  padding: '11px 14px',
                  fontSize: '14px',
                  border: '1px solid #E0DFDC',
                  borderRadius: '8px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: 'Inter, sans-serif',
                  color: '#111827',
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
              }}
            >
              {isPending ? 'Saving...' : 'Set Password'}
            </button>
          </form>

        </div>
      </div>
    </>
  )
}
