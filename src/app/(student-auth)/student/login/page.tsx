'use client'

import { useState, useTransition } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { studentLoginAction } from './actions'

export default function StudentLoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [showPassword, setShowPassword] = useState(false)

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

            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', margin: '0 0 32px' }}>
              Sign in
            </h1>

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
                <div style={{ position: 'relative' }}>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    style={{ width: '100%', padding: '11px 44px 11px 14px', fontSize: '14px', border: '1px solid #E0DFDC', borderRadius: '8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif', color: '#111827' }}
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
              </div>


              <button
                type="submit"
                disabled={isPending}
                style={{ width: '100%', padding: '12px', backgroundColor: isPending ? '#ffb366' : '#FF8303', color: '#ffffff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: isPending ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif' }}
              >
                {isPending ? 'Signing in...' : 'Sign in'}
              </button>
            </form>

            <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center', marginTop: '28px' }}>
              Forgot your password? Contact{' '}
              <span style={{ color: '#FF8303', fontWeight: 500 }}>support@lingualinkonline.com</span>
            </p>
          </div>
        </div>

        {/* Right — photo brand panel */}
        <div style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          backgroundImage: "url('/login-bg.png')",
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
        }}>

          {/* Dark gradient overlay — keeps bottom text readable */}
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.85) 65%, rgba(0,0,0,1) 100%)',
          }} />

          {/* Overlay text — bottom-left, z-index 2 */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '56px 56px',
            pointerEvents: 'none',
            zIndex: 2,
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

      </div>
    </>
  )
}