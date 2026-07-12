// Shared visual indicator for accounts whose invite/system email hard-bounced
// (NEW311). The bounce flag is written by /api/webhooks/resend from Resend's
// delivery webhooks. Colours are inline styles, not Tailwind classes, because
// Tailwind v4 does not emit dynamically constructed colour utilities.

const BADGE_STYLE = { backgroundColor: '#FD5602', color: '#ffffff' } as const

// Compact pill for list rows.
export function EmailBounceBadge() {
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={BADGE_STYLE}
    >
      Invite email bounced
    </span>
  )
}

// Badge plus the fix instructions and (optionally) the recorded bounce reason,
// for detail pages.
export function EmailBounceNotice({ reason }: { reason?: string | null }) {
  return (
    <div className="mt-1 mb-2">
      <EmailBounceBadge />
      <p className="text-xs text-gray-500 mt-1 max-w-md">
        Emails to this address are blocked. Fix the address, then remove it from
        the Resend suppression list (Resend dashboard &gt; Suppressions).
      </p>
      {reason ? (
        <p className="text-xs text-gray-400 mt-0.5 max-w-md">Bounce reason: {reason}</p>
      ) : null}
    </div>
  )
}
