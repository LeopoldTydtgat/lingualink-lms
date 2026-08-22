import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_TOKEN_ENDPOINT,
  decodeIdTokenEmail,
} from '@/lib/google/oauth'

// GET /api/google/oauth/callback - step 2 of the Google Calendar connection.
//
// THIS PATH IS PART OF THE CONTRACT. It must stay exactly
// /api/google/oauth/callback, byte for byte, because it is what is registered
// as the redirect URI in the Google Cloud console and what
// GOOGLE_OAUTH_REDIRECT_URI must hold. Moving this file breaks the flow with a
// redirect_uri_mismatch that no amount of code here can recover from.
//
// AUTHORISATION: requireAdmin() here is THE gate, exactly as in the start route.
// The proxy's session gate proves only that someone is logged in.
//
// EVERY exit path is a friendly redirect back to /schedule with a ?google= code
// (or, for the unauthorised case, a plain 401) - never a raw 500, never JSON
// carrying Google's error body. Google's own error text is logged server-side
// and stops there.
//
// Buffer (in decodeIdTokenEmail) is Node-only, so pin the runtime.
export const runtime = 'nodejs'

type Outcome =
  // Success.
  | 'connected'
  // User declined at Google's consent screen, or Google sent no code.
  | 'denied'
  // state param absent, cookie absent, or the two disagree.
  | 'state_error'
  // An OAuth env var is missing - operator problem.
  | 'config_error'
  // Token exchange rejected, incomplete, or its id_token carried no email.
  | 'token_error'
  // Tokens are good but the connection row would not persist.
  | 'save_error'
  // Anything unforeseen. Logged with the throwable.
  | 'unexpected_error'

/**
 * Deletes the one-shot state nonce.
 *
 * Called on EVERY exit path, success and failure alike, so a leaked or replayed
 * callback URL can never be validated a second time against a cookie left
 * behind by the first. Attributes other than maxAge must match the ones the
 * start route set, or the browser treats this as a different cookie and leaves
 * the original in place.
 */
function clearStateCookie(response: NextResponse): NextResponse {
  response.cookies.set({
    name: GOOGLE_OAUTH_STATE_COOKIE,
    value: '',
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 0,
  })
  return response
}

function finish(req: NextRequest, outcome: Outcome): NextResponse {
  return clearStateCookie(
    NextResponse.redirect(new URL(`/schedule?google=${outcome}`, req.url), 302)
  )
}

/**
 * Google's error field, for the SERVER LOG only.
 *
 * Never widen this into the redirect: the raw body can carry request-specific
 * detail that has no business in a URL the user can screenshot or share.
 */
function googleErrorField(body: unknown): { error: unknown; description: unknown } {
  if (!body || typeof body !== 'object') return { error: null, description: null }
  const asRecord = body as { error?: unknown; error_description?: unknown }
  return { error: asRecord.error ?? null, description: asRecord.error_description ?? null }
}

/** Google documents expires_in as a number; a numeric string is accepted rather than lost. */
function readExpiresInSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return null
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAdmin()
    if (!user) {
      // Not a flow outcome - nobody reaches here from the card. Still clears the
      // nonce so a refused caller cannot leave a live one behind.
      return clearStateCookie(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      )
    }

    const params = req.nextUrl.searchParams
    const code = params.get('code')
    const consentError = params.get('error')

    if (consentError || !code) {
      console.error('[google/oauth/callback] consent not granted:', {
        error: consentError,
        hasCode: Boolean(code),
      })
      return finish(req, 'denied')
    }

    const state = params.get('state')
    const cookieState = req.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value ?? null

    if (!state || !cookieState || state !== cookieState) {
      console.error('[google/oauth/callback] state check failed:', {
        hasStateParam: Boolean(state),
        hasStateCookie: Boolean(cookieState),
        matches: Boolean(state) && state === cookieState,
      })
      return finish(req, 'state_error')
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim()

    if (!clientId || !clientSecret || !redirectUri) {
      console.error('[google/oauth/callback] OAuth env vars missing:', {
        hasClientId: Boolean(clientId),
        hasClientSecret: Boolean(clientSecret),
        hasRedirectUri: Boolean(redirectUri),
      })
      return finish(req, 'config_error')
    }

    // ---- Exchange the one-time code for tokens -----------------------------
    const form = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    })

    const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    const tokenBody: unknown = await tokenResponse.json().catch((parseError: unknown) => {
      console.error(
        '[google/oauth/callback] token response was not JSON:',
        tokenResponse.status,
        parseError
      )
      return null
    })

    if (!tokenResponse.ok || !tokenBody || typeof tokenBody !== 'object') {
      console.error(
        '[google/oauth/callback] token exchange failed:',
        tokenResponse.status,
        googleErrorField(tokenBody)
      )
      return finish(req, 'token_error')
    }

    const payload = tokenBody as {
      refresh_token?: unknown
      access_token?: unknown
      expires_in?: unknown
      scope?: unknown
      id_token?: unknown
    }

    const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : null
    const idToken = typeof payload.id_token === 'string' ? payload.id_token : null

    // A response with no refresh_token is a dead connection: nothing could renew
    // it tomorrow, and the column it feeds is NOT NULL. Treat it as a failed
    // exchange rather than storing half a connection.
    if (!refreshToken || !idToken) {
      console.error('[google/oauth/callback] token response incomplete:', {
        status: tokenResponse.status,
        hasRefreshToken: Boolean(refreshToken),
        hasIdToken: Boolean(idToken),
      })
      return finish(req, 'token_error')
    }

    // Identity comes from the id_token we were just handed, unverified by
    // design - see decodeIdTokenEmail. It logs its own rejection reason.
    const googleEmail = decodeIdTokenEmail(idToken)
    if (!googleEmail) {
      console.error('[google/oauth/callback] could not read the connected account email')
      return finish(req, 'token_error')
    }

    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null
    const expiresInSeconds = readExpiresInSeconds(payload.expires_in)
    // Null expiry degrades SAFE: a consumer that cannot tell when the access
    // token dies must refresh, never assume it is still good.
    const accessTokenExpiresAt =
      expiresInSeconds === null
        ? null
        : new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    const scope = typeof payload.scope === 'string' ? payload.scope : null

    // ---- Persist -----------------------------------------------------------
    // public.google_calendar_connections has RLS enabled with zero policies and
    // is REVOKEd from anon + authenticated, so a session client cannot write it
    // at all. Service role only.
    //
    // profile_id carries a UNIQUE constraint (migration
    // 20260822120000_google_calendar_connections.sql), so onConflict 'profile_id'
    // has a real constraint behind it and re-connecting updates the one row
    // rather than accumulating rows.
    //
    // connected_at is deliberately absent from the payload: on insert it takes
    // its column default, and on the conflict-update PostgREST only sets the
    // columns present here, so the original connection date survives a
    // re-connect. updated_at IS listed, because a column default does not
    // re-fire on UPDATE.
    //
    // profiles.id === the auth user id for teachers and admins (see
    // src/lib/auth/callerProfile.ts), so user.id is the correct FK value.
    const admin = createAdminClient()
    const { error: writeError } = await admin
      .from('google_calendar_connections')
      .upsert(
        {
          profile_id: user.id,
          google_email: googleEmail,
          refresh_token: refreshToken,
          access_token: accessToken,
          access_token_expires_at: accessTokenExpiresAt,
          scope,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'profile_id' }
      )

    if (writeError) {
      console.error('[google/oauth/callback] connection write failed:', writeError)
      return finish(req, 'save_error')
    }

    return finish(req, 'connected')
  } catch (unexpected) {
    // Includes the deliberate throw from getCallerProfile() on a failed profiles
    // read. Nothing was written on this path, so failing closed here is safe.
    console.error('[google/oauth/callback] unexpected failure:', unexpected)
    return finish(req, 'unexpected_error')
  }
}
