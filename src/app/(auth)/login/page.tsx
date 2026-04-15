'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { signIn } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [showPassword, setShowPassword] = useState(false)
  const router = useRouter()

  function handleSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const result = await signIn(formData)
      if (result?.error) {
        setError(result.error)
        return
      }
      if (result?.success) {
        router.push('/upcoming-classes')
      }
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
              Teacher Portal — enter your credentials
            </p>

            <form action={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <Label htmlFor="email" style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>
                  Email address
                </Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@lingualinkonline.com"
                  required
                  autoComplete="email"
                  style={{ height: '44px', fontSize: '14px' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <Label htmlFor="password" style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>
                  Password
                </Label>
                <div style={{ position: 'relative' }}>
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    style={{ height: '44px', fontSize: '14px', paddingRight: '44px' }}
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

              {error && (
                <p style={{ fontSize: '13px', color: '#FD5602', backgroundColor: '#fff4f0', padding: '10px 14px', borderRadius: '6px', margin: 0 }}>
                  {error}
                </p>
              )}

              <Button
                type="submit"
                disabled={isPending}
                style={{
                  height: '44px',
                  backgroundColor: isPending ? '#ffb366' : '#FF8303',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: '15px',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: isPending ? 'not-allowed' : 'pointer',
                  width: '100%',
                  marginTop: '4px',
                }}
              >
                {isPending ? 'Signing in...' : 'Sign in'}
              </Button>
            </form>

            <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center', marginTop: '28px' }}>
              Forgot your password? Contact{' '}
              <span style={{ color: '#FF8303', fontWeight: 500 }}>teachers@lingualinkonline.com</span>
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
