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

// ---- Refresh-token exchange -------------------------------------------------
//
// Used by the busy-sync cron (src/app/api/cron/google-busy-sync/route.ts) on
// EVERY run. Deliberately not conditional on the stored access_token's expiry:
// the token lives ~60 minutes and the cron runs far more often than that, so a
// "reuse if still valid" branch would be a second code path that only ever runs
// with a stale token - i.e. the path least exercised and most likely to be
// wrong when it matters.

/** How long to wait on Google's token endpoint before giving up on the run. */
const TOKEN_FETCH_TIMEOUT_MS = 10_000

/**
 * Three states, not two, because the caller must treat them differently:
 * - 'revoked' is PERMANENT. The user pulled access (or deleted the app grant);
 *   nothing retries out of it, a human has to reconnect.
 * - 'transient_error' is a retry-next-run condition (network, 5xx, bad config).
 * - 'refreshed' is the only state carrying a usable token.
 */
export type GoogleTokenRefreshOutcome = 'refreshed' | 'revoked' | 'transient_error'

export interface GoogleTokenRefresh {
  outcome: GoogleTokenRefreshOutcome
  /** Populated only when outcome === 'refreshed'. */
  accessToken: string | null
  /** UTC ISO expiry, or null when Google returned no usable expires_in. */
  expiresAtIso: string | null
  /** Short, log-safe summary. Null on success. Never contains a token. */
  error: string | null
}

/**
 * Google documents expires_in as a number; a numeric string is accepted rather
 * than lost.
 *
 * NOTE: src/app/api/google/oauth/callback/route.ts carries its own private copy
 * of this. Deliberately not shared in this step - the callback is committed and
 * working, and de-duplicating it is a separate change with its own blast radius.
 */
function parseExpiresInSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return null
}

/** Google's OAuth error body is { error, error_description }; both are log-only. */
function readOAuthError(body: unknown): { error: string | null; description: string | null } {
  if (!body || typeof body !== 'object') return { error: null, description: null }
  const record = body as { error?: unknown; error_description?: unknown }
  return {
    error: typeof record.error === 'string' ? record.error : null,
    description: typeof record.error_description === 'string' ? record.error_description : null,
  }
}

/**
 * Exchanges a stored refresh_token for a fresh access_token.
 *
 * NEVER logs either token. The refresh token is the whole connection; the
 * access token is a live bearer credential for the user's calendar.
 *
 * Never throws: every failure mode comes back as an outcome the caller can act
 * on, because the one caller is an unattended cron that must not 500.
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenRefresh> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()

  // An operator problem, not a revocation: reconnecting would not fix it, so it
  // must NOT set the revoked flag. Transient keeps it in the failure counter,
  // which is what surfaces it on the Schedule banner.
  if (!clientId || !clientSecret) {
    console.error('[google/oauth] refresh aborted, OAuth env vars missing:', {
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
    })
    return {
      outcome: 'transient_error',
      accessToken: null,
      expiresAtIso: null,
      error: 'Google OAuth client credentials are not configured',
    }
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  let response: Response
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (networkError) {
    console.error('[google/oauth] token refresh request failed:', networkError)
    return {
      outcome: 'transient_error',
      accessToken: null,
      expiresAtIso: null,
      error: 'Google token endpoint unreachable',
    }
  }

  const body: unknown = await response.json().catch((parseError: unknown) => {
    console.error('[google/oauth] token refresh response was not JSON:', response.status, parseError)
    return null
  })

  if (!response.ok) {
    const { error, description } = readOAuthError(body)
    console.error('[google/oauth] token refresh rejected:', response.status, { error, description })

    // THE revocation signal. Google answers invalid_grant when the refresh
    // token has been revoked, expired, or had its grant removed - all of which
    // need a human to reconnect, none of which a retry can clear.
    if ((response.status === 400 || response.status === 401) && error === 'invalid_grant') {
      return {
        outcome: 'revoked',
        accessToken: null,
        expiresAtIso: null,
        error: 'Google refused the stored refresh token (invalid_grant)',
      }
    }

    return {
      outcome: 'transient_error',
      accessToken: null,
      expiresAtIso: null,
      error: `Google token endpoint returned HTTP ${response.status}${error ? ` (${error})` : ''}`,
    }
  }

  const accessToken = (body as { access_token?: unknown } | null)?.access_token
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    console.error('[google/oauth] token refresh succeeded but carried no access_token')
    return {
      outcome: 'transient_error',
      accessToken: null,
      expiresAtIso: null,
      error: 'Google returned no access_token',
    }
  }

  const expiresInSeconds = parseExpiresInSeconds((body as { expires_in?: unknown }).expires_in)
  // Null expiry degrades SAFE: a consumer that cannot tell when the access
  // token dies must refresh, never assume it is still good.
  const expiresAtIso =
    expiresInSeconds === null ? null : new Date(Date.now() + expiresInSeconds * 1000).toISOString()

  return { outcome: 'refreshed', accessToken, expiresAtIso, error: null }
}
