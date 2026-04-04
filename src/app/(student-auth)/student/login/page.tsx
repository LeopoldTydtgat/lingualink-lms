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
      if (result?.error) {
        setError(result.error)
      }
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
            Student Portal
          </h1>
          <p style={{ fontSize: '14px', color: '#666666', margin: 0 }}>
            Sign in to your account
          </p>
        </div>

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

        <form action={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="email"
              style={{
                display: 'block',
                fontSize: '14px',
                fontWeight: 600,
                color: '#000000',
                marginBottom: '6px',
              }}
            >
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
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

          <div style={{ marginBottom: '8px' }}>
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
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Enter your password"
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

          <div style={{ textAlign: 'right', marginBottom: '24px' }}>
            <a
              href="/student/forgot-password"
              style={{
                fontSize: '13px',
                color: '#FF8303',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              Forgot your password?
            </a>
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
            {isPending ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p
          style={{
            textAlign: 'center',
            fontSize: '13px',
            color: '#999999',
            marginTop: '24px',
            marginBottom: 0,
          }}
        >
          {'Teacher? '}
          <a
            href="/login"
            style={{ color: '#FF8303', textDecoration: 'none', fontWeight: 500 }}
          >
            Sign in here
          </a>
        </p>
      </div>
    </div>
  )
}
