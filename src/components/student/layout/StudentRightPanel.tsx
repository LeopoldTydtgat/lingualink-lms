'use client'

// Step 1: shell with placeholder content.
// Live data (countdown, hours balance, exercises progress) is wired up in Step 5.

interface StudentRightPanelProps {
  studentId: string
}

export default function StudentRightPanel({
  studentId: _studentId,
}: StudentRightPanelProps) {
  return (
    <aside
      style={{
        width: '240px',
        minWidth: '240px',
        backgroundColor: '#ffffff',
        borderLeft: '1px solid #E0DFDC',
        padding: '20px 16px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        flexShrink: 0,
      }}
    >
      {/* ── Next Class ──────────────────────────────────────────────── */}
      <div>
        <p
          style={{
            fontSize: '11px',
            fontWeight: '600',
            color: '#9ca3af',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '8px',
          }}
        >
          Next Class
        </p>
        <p style={{ fontSize: '22px', fontWeight: '700', color: '#111827' }}>
          —
        </p>
        <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '2px' }}>
          No upcoming classes
        </p>
      </div>

      {/* ── Hours Remaining ─────────────────────────────────────────── */}
      <div>
        <p
          style={{
            fontSize: '11px',
            fontWeight: '600',
            color: '#9ca3af',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '8px',
          }}
        >
          Hours Remaining
        </p>
        <p style={{ fontSize: '18px', fontWeight: '700', color: '#111827' }}>
          —
        </p>
      </div>

      {/* ── Training End Date ────────────────────────────────────────── */}
      <div>
        <p
          style={{
            fontSize: '11px',
            fontWeight: '600',
            color: '#9ca3af',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '8px',
          }}
        >
          Training Ends
        </p>
        <p style={{ fontSize: '13px', color: '#6b7280' }}>—</p>
      </div>

      {/* ── Exercises Progress ───────────────────────────────────────── */}
      <div>
        <p
          style={{
            fontSize: '11px',
            fontWeight: '600',
            color: '#9ca3af',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '8px',
          }}
        >
          My Exercises
        </p>

        {/* Progress bar */}
        <div
          style={{
            height: '6px',
            backgroundColor: '#E0DFDC',
            borderRadius: '3px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: '0%',
              backgroundColor: '#FF8303',
              borderRadius: '3px',
            }}
          />
        </div>
        <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '6px' }}>
          0 of 0 completed
        </p>

        <a
          href="/student/study"
          style={{
            display: 'block',
            marginTop: '10px',
            padding: '7px 12px',
            backgroundColor: '#FF8303',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '500',
            cursor: 'pointer',
            textAlign: 'center',
            textDecoration: 'none',
          }}
        >
          Do My Exercises
        </a>
      </div>

      {/* ── Help & Support ───────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid #E0DFDC', paddingTop: '16px' }}>
        <p
          style={{
            fontSize: '11px',
            fontWeight: '600',
            color: '#9ca3af',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '8px',
          }}
        >
          Help & Support
        </p>
        <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '10px' }}>
          Questions? Contact admin.
        </p>
        {/* Chat with Admin wired up in Admin Controls phase */}
        <button
          style={{
            width: '100%',
            padding: '7px 12px',
            backgroundColor: '#1a1a1a',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: '500',
            cursor: 'pointer',
          }}
        >
          Chat with Admin
        </button>
      </div>
    </aside>
  )
}
