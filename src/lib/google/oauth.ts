// Shared constants and helpers for the Google Calendar OAuth flow (GCAL REBUILD 1).
//
// Both halves of the flow live here so the two route handlers cannot drift:
// a mismatch in the state cookie name alone would silently turn every callback
// into a state_error, and a mismatch in the scope string would cost a second
// consent screen.
//
// Server-only. Never import into a client component: nothing here is secret by
// itself, but the module sits next to code that reads client secrets and there
// is no reason for any of it to reach the browser bundle.

/**
 * One-shot CSRF nonce cookie for the OAuth round trip.
 *
 * sameSite MUST be 'lax', never 'strict': the callback arrives as a cross-site
 * top-level redirect from accounts.google.com, and a strict cookie is not sent
 * on a cross-site navigation, so a strict cookie would make every callback fail
 * the state check.
 */
export const GOOGLE_OAUTH_STATE_COOKIE = 'google_oauth_state'

/** 10 minutes: long enough to read a consent screen, short enough to be useless later. */
export const GOOGLE_OAUTH_STATE_MAX_AGE_SECONDS = 600

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * LOCKED - do not narrow these scopes.
 *
 * openid + email are required or Google returns no id_token and no email claim:
 * the calendar scope alone exposes neither, and the connected account's address
 * is what the Schedule card shows.
 *
 * The full calendar scope (not calendar.readonly) is deliberate. Outbound
 * writing is committed for REBUILD 2, and asking for read-only now would force
 * a second consent screen then. One consent, never two.
 */
export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar',
].join(' ')

/**
 * Reads the `email` claim out of an id_token's payload segment.
 *
 * NO SIGNATURE VERIFICATION, BY DESIGN. The token was not supplied by the
 * browser: it came back in the body of our own server-to-server POST to
 * Google's token endpoint over TLS in this same request, so its origin is
 * already authenticated by the transport. Verifying the JWS here would add a
 * JWKS fetch and a key cache to re-prove something the connection already
 * proved. For the same reason we do NOT call the userinfo endpoint - that is a
 * second round trip for a claim we are already holding.
 *
 * Returns null - never throws - for anything unparseable, so the caller decides
 * the outcome. Every rejection is logged here rather than swallowed.
 */
export function decodeIdTokenEmail(idToken: string): string | null {
  const segments = idToken.split('.')
  if (segments.length !== 3) {
    console.error('[google/oauth] id_token is not a three-segment JWT')
    return null
  }

  // base64url -> base64, then restore the padding Google strips.
  const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')

  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch (parseError) {
    console.error('[google/oauth] id_token payload did not decode to JSON:', parseError)
    return null
  }

  if (!claims || typeof claims !== 'object') {
    console.error('[google/oauth] id_token payload was not a JSON object')
    return null
  }

  const email = (claims as { email?: unknown }).email
  if (typeof email !== 'string' || email.trim().length === 0) {
    console.error('[google/oauth] id_token carried no usable email claim')
    return null
  }

  return email.trim()
}
