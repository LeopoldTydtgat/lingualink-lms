// Shared 15-minute edit window for chat messages (both `messages` and
// `support_messages`). The server paths (both editMessage actions and
// api/support/edit) are the authoritative check and always compare against the
// DB row's created_at - never a client-supplied timestamp. Clients import the
// SAME helper to hide the Edit affordance once the window has passed; a stale
// button (thread left open past the window) falls through to the server check.
export const EDIT_WINDOW_MS = 15 * 60 * 1000

export const EDIT_WINDOW_ERROR = 'Messages can only be edited within 15 minutes of sending.'

// createdAt is a DB timestamptz string (a UTC instant); this is pure instant
// arithmetic - no timezone or local-date construction. Fails closed (not
// editable) on an unparseable value.
export function isWithinEditWindow(createdAt: string): boolean {
  const createdMs = new Date(createdAt).getTime()
  if (Number.isNaN(createdMs)) return false
  return Date.now() - createdMs <= EDIT_WINDOW_MS
}
