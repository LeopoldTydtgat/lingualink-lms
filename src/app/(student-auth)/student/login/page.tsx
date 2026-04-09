'use client'

import { useState, useTransition } from 'react'
import { studentLoginAction } from './actions'

export default function StudentLoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const result = await studentLoginAction(formData)
      if (result?.error) setError(result.error)
    })
  }

  return (
    <>
      <style>{`html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }`}</style>
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', fontFamily: 'Inter, sans-serif' }}>

        {/* Orange accent stripe — left edge */}
        <div style={{ width: '4px', backgroundColor: '#FF8303', flexShrink: 0 }} />

        {/* Left — white form panel */}
        <div style={{
          width: 'calc(48% - 4px)',
          backgroundColor: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '0 56px',
          flexShrink: 0,
        }}>
          <div style={{ width: '100%', maxWidth: '380px' }}>

            <div style={{ marginBottom: '48px' }}>
              <img
                src="/lingualink-logo-clean.svg"
                alt="Lingualink Online"
                style={{ height: '72px', width: 'auto' }}
              />
            </div>

            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: '0 0 4px' }}>
              Sign in
            </h1>
            <p style={{ fontSize: '14px', color: '#6b7280', margin: '0 0 32px' }}>
              Student Portal — enter your credentials
            </p>

            {error && (
              <div style={{ backgroundColor: '#fff4f4', border: '1px solid #FD5602', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', fontSize: '14px', color: '#FD5602' }}>
                {error}
              </div>
            )}

            <form action={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label htmlFor="email" style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>
                  Email address
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  style={{ width: '100%', padding: '11px 14px', fontSize: '14px', border: '1px solid #E0DFDC', borderRadius: '8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif', color: '#111827' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label htmlFor="password" style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  style={{ width: '100%', padding: '11px 14px', fontSize: '14px', border: '1px solid #E0DFDC', borderRadius: '8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif', color: '#111827' }}
                />
              </div>

              <div style={{ textAlign: 'right', marginTop: '-6px' }}>
                <a href="/student/forgot-password" style={{ fontSize: '13px', color: '#FF8303', textDecoration: 'none', fontWeight: 500 }}>
                  Forgot your password?
                </a>
              </div>

              <button
                type="submit"
                disabled={isPending}
                style={{ width: '100%', padding: '12px', backgroundColor: isPending ? '#ffb366' : '#FF8303', color: '#ffffff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: isPending ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif' }}
              >
                {isPending ? 'Signing in...' : 'Sign in'}
              </button>
            </form>

            <p style={{ textAlign: 'center', fontSize: '13px', color: '#9ca3af', marginTop: '28px' }}>
              Teacher?{' '}
              <a href="/login" style={{ color: '#FF8303', textDecoration: 'none', fontWeight: 500 }}>
                Sign in here
              </a>
            </p>
          </div>
        </div>

        {/* Right — dark brand panel */}
        <div style={{
          flex: 1,
          backgroundColor: '#111827',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-end',
          padding: '56px 56px',
        }}>
          <div style={{ width: '52px', height: '4px', backgroundColor: '#FF8303', borderRadius: '2px', marginBottom: '24px' }} />
          <p style={{ color: '#ffffff', fontSize: '32px', fontWeight: 700, lineHeight: 1.3, margin: '0 0 16px' }}>
            Better English.<br />
            <span style={{ color: '#FF8303' }}>Better opportunities.</span>
          </p>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '15px', lineHeight: 1.8, margin: 0, maxWidth: '340px' }}>
            Personalised online English lessons for business professionals, everyday learners, and students of all levels.
          </p>
        </div>

      </div>
    </>
  )
}