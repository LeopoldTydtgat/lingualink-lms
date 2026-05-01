'use client'

import { useIdleTimeout } from '@/lib/hooks/useIdleTimeout'

interface Props {
  nextLessonStartIso: string | null
  nextLessonDurationMinutes: number | null
  loginPath: string
}

export default function IdleTimeoutWatcher({
  nextLessonStartIso,
  nextLessonDurationMinutes,
  loginPath,
}: Props) {
  const { showWarning, secondsUntilLogout, stayLoggedIn } = useIdleTimeout({
    nextLessonStartIso,
    nextLessonDurationMinutes,
    loginPath,
  })

  if (!showWarning) return null

  const minutes = Math.floor(secondsUntilLogout / 60)
  const seconds = secondsUntilLogout % 60
  const timeLabel =
    minutes > 0 ? `${minutes} min ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          padding: '28px',
          maxWidth: '400px',
          width: '90%',
          boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
        }}
      >
        <h2
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: '#111827',
            marginBottom: '8px',
          }}
        >
          Are you still there?
        </h2>
        <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '20px' }}>
          You will be signed out in <strong>{timeLabel}</strong> due to inactivity.
        </p>
        <button
          onClick={stayLoggedIn}
          style={{
            width: '100%',
            padding: '12px',
            backgroundColor: '#FF8303',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Stay signed in
        </button>
      </div>
    </div>
  )
}
