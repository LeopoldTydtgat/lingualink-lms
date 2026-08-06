import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// /api/calendar-subscription/token - serves BOTH portals.
//
//   GET  - get-or-create this user's calendar subscription token
//   POST - rotate it (the old feed URL dies immediately; this is the revoke)
//
// Session-authenticated. It deliberately lives OUTSIDE the /api/calendar-feed/
// prefix that src/proxy.ts exempts from the session gate, so the proxy still
// guards it and this route re-checks the session itself.
//
// Neither method reads a request body. user_type and user_id are derived from
// the session on the server and are never taken from client input, so there is
// nothing here for a Zod schema to validate - the identity IS the input.
//
// public.calendar_feed_tokens has RLS enabled with zero policies and is REVOKEd
// from anon + authenticated, so every touch of it uses createAdminClient().

const ROUTE = '/api/calendar-subscription/token'

// randomBytes is Node-only, so pin the runtime rather than relying on the
// default. Math.random must never be used to mint a bearer credential.
export const runtime = 'nodejs'

// Postgres unique_violation. Raised by the unique(user_type, user_id) index
// when two tabs ask for a token at the same time.
const UNIQUE_VIOLATION = '23505'

type FeedUserType = 'teacher' | 'student'

interface FeedIdentity {
  userType: FeedUserType
  userId: string
}

type IdentityResult =
  | { ok: true; identity: FeedIdentity }
  | { ok: false; response: NextResponse }

// 32 random bytes, base64url encoded - 43 characters drawn from [A-Za-z0-9_-],
// which is exactly the alphabet the public feed route accepts.
function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

function serverError(message: string) {
  return NextResponse.json({ error: message }, { status: 500 })
}

// Resolve the caller from the session alone.
//
// profiles is tried first, then students, matching the precedence of the
// account check in src/proxy.ts: a dual-identity user holding both rows is
// treated as a teacher, exactly as the portal role gate treats them.
//
// profiles.id IS the auth uuid, so a teacher token row stores it directly.
// students is reached through the auth_user_id indirection and the token row
// stores students.id - the table PK - because lessons.student_id keys on that
// PK, never on the auth uuid.
async function resolveIdentity(method: string): Promise<IdentityResult> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  }

  const admin = createAdminClient()

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error(`[${method} ${ROUTE}] profiles lookup failed:`, profileError)
    return { ok: false, response: serverError('Could not load your subscription link.') }
  }
  if (profile) {
    return { ok: true, identity: { userType: 'teacher', userId: profile.id } }
  }

  const { data: student, error: studentError } = await admin
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (studentError) {
    console.error(`[${method} ${ROUTE}] students lookup failed:`, studentError)
    return { ok: false, response: serverError('Could not load your subscription link.') }
  }
  if (student) {
    return { ok: true, identity: { userType: 'student', userId: student.id } }
  }

  // Authenticated but neither a teacher/admin nor a student - no feed exists.
  return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
}

async function findExistingToken(identity: FeedIdentity) {
  const admin = createAdminClient()
  return admin
    .from('calendar_feed_tokens')
    .select('token')
    .eq('user_type', identity.userType)
    .eq('user_id', identity.userId)
    .maybeSingle()
}

// GET - return the caller's token, creating one on first use.
export async function GET() {
  try {
    const result = await resolveIdentity('GET')
    if (!result.ok) return result.response
    const { identity } = result

    const { data: existing, error: selectError } = await findExistingToken(identity)

    if (selectError) {
      console.error(`[GET ${ROUTE}] token lookup failed:`, selectError)
      return serverError('Could not load your subscription link.')
    }
    if (existing) {
      return NextResponse.json({ token: existing.token })
    }

    const admin = createAdminClient()
    const { data: inserted, error: insertError } = await admin
      .from('calendar_feed_tokens')
      .insert({
        user_type: identity.userType,
        user_id: identity.userId,
        token: mintToken(),
      })
      .select('token')
      .maybeSingle()

    if (insertError) {
      // Two tabs raced on first use and the other one won the unique index.
      // Its row is the caller's row, so return that token rather than failing.
      if (insertError.code === UNIQUE_VIOLATION) {
        const { data: raced, error: racedError } = await findExistingToken(identity)

        if (racedError) {
          console.error(`[GET ${ROUTE}] token re-read after unique violation failed:`, racedError)
          return serverError('Could not load your subscription link.')
        }
        if (raced) {
          return NextResponse.json({ token: raced.token })
        }
        // No row means the violation was on the token column, not on
        // (user_type, user_id) - astronomically unlikely with 32 random bytes,
        // and not something to paper over. Fall through and report it.
      }

      console.error(`[GET ${ROUTE}] token insert failed:`, insertError)
      return serverError('Could not load your subscription link.')
    }

    if (!inserted) {
      console.error(`[GET ${ROUTE}] token insert returned no row`)
      return serverError('Could not load your subscription link.')
    }

    return NextResponse.json({ token: inserted.token })
  } catch (err) {
    console.error(`[GET ${ROUTE}] unexpected error:`, err)
    return serverError('Could not load your subscription link.')
  }
}

// POST - rotate. Deleting the row is what kills the old feed URL: the public
// route resolves tokens by exact match, so the previous URL 404s from the next
// poll onward. A zero-row delete is fine (nothing to revoke yet).
export async function POST() {
  try {
    const result = await resolveIdentity('POST')
    if (!result.ok) return result.response
    const { identity } = result

    const admin = createAdminClient()

    const { error: deleteError } = await admin
      .from('calendar_feed_tokens')
      .delete()
      .eq('user_type', identity.userType)
      .eq('user_id', identity.userId)

    if (deleteError) {
      console.error(`[POST ${ROUTE}] token delete failed:`, deleteError)
      return serverError('Could not reset your subscription link.')
    }

    const { data: inserted, error: insertError } = await admin
      .from('calendar_feed_tokens')
      .insert({
        user_type: identity.userType,
        user_id: identity.userId,
        token: mintToken(),
      })
      .select('token')
      .maybeSingle()

    if (insertError) {
      // Another rotate landed between this delete and this insert. Both callers
      // asked for a fresh link and the old one is already dead either way, so
      // returning the winner's token is correct.
      if (insertError.code === UNIQUE_VIOLATION) {
        const { data: raced, error: racedError } = await findExistingToken(identity)

        if (racedError) {
          console.error(`[POST ${ROUTE}] token re-read after unique violation failed:`, racedError)
          return serverError('Could not reset your subscription link.')
        }
        if (raced) {
          return NextResponse.json({ token: raced.token })
        }
      }

      console.error(`[POST ${ROUTE}] token insert failed:`, insertError)
      return serverError('Could not reset your subscription link.')
    }

    if (!inserted) {
      console.error(`[POST ${ROUTE}] token insert returned no row`)
      return serverError('Could not reset your subscription link.')
    }

    return NextResponse.json({ token: inserted.token })
  } catch (err) {
    console.error(`[POST ${ROUTE}] unexpected error:`, err)
    return serverError('Could not reset your subscription link.')
  }
}
