import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_OAUTH_STATE_MAX_AGE_SECONDS,
} from '@/lib/google/oauth'

// GET /api/google/oauth/start - step 1 of the Google Calendar connection.
//
// Mints a CSRF nonce, parks it in an httpOnly cookie, and bounces the caller to
// Google's consent screen. The matching half is
// src/app/api/google/oauth/callback/route.ts.
//
// AUTHORISATION: requireAdmin() here is THE gate. src/proxy.ts does session-gate
// /api/google/* (the path is deliberately absent from its PUBLIC_API_PATHS set),
// but that only proves someone is logged in - it says nothing about role, so it
// is a backstop and never the authorisation.
//
// Entered by top-level navigation from a plain <a> on the Schedule page, never
// by fetch(): the whole point is a redirect the browser follows.

// randomBytes is Node-only, so pin the runtime rather than relying on the
// default. Math.random must never be used to mint a CSRF nonce.
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim()

  // A missing env var is an operator problem, not a user problem: send them back
  // to a page that can say so instead of rendering a raw 500.
  if (!clientId || !redirectUri) {
    console.error('[google/oauth/start] OAuth env vars missing:', {
      hasClientId: Boolean(clientId),
      hasRedirectUri: Boolean(redirectUri),
    })
    return NextResponse.redirect(new URL('/schedule?google=config_error', req.url), 302)
  }

  const state = randomBytes(32).toString('hex')

  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES,
    // offline + consent together are what produce a refresh_token. Without
    // prompt=consent Google withholds it on every re-authorisation after the
    // first, and the column it feeds is NOT NULL.
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT)
  // URLSearchParams serialises a space as '+', which only decodes back to a
  // space under form-urlencoded rules; RFC 3986 reads a bare '+' in a query as a
  // literal plus. The scope list is space-delimited, so encode those spaces as
  // '%20', which is a space under BOTH readings. Any bare '+' left in the string
  // can only be an encoded space - a literal plus in a value comes out as '%2B' -
  // so this replace cannot corrupt a value.
  authUrl.search = query.toString().replace(/\+/g, '%20')

  const response = NextResponse.redirect(authUrl, 302)
  response.cookies.set({
    name: GOOGLE_OAUTH_STATE_COOKIE,
    value: state,
    path: '/',
    httpOnly: true,
    // MUST stay 'lax' - see the constant's doc comment. A strict cookie is not
    // sent on Google's cross-site redirect back, so every callback would fail.
    sameSite: 'lax',
    secure: true,
    maxAge: GOOGLE_OAUTH_STATE_MAX_AGE_SECONDS,
  })

  return response
}
