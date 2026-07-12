import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { createAdminClient } from '@/lib/supabase/admin'

// Resend delivery-event webhook (NEW311).
//
// Admin-created accounts receive an invite email (src/lib/auth/inviteEmail.ts).
// If the address hard-bounces, Resend accepts the send API call, silently
// suppresses the address, and the admin never learns the invite went nowhere.
// This route receives Resend's signed webhooks and records the bounce on the
// matching profile/student row so the admin UI can surface it.
//
// Not a browser route: it is called by Resend, so there is no user session.
// It authenticates via the Svix/Standard-Webhooks signature only, then uses the
// service-role admin client (RLS bypassed) to write the flag.
//
// Signature verification uses resend.webhooks.verify() (resend >= 6, backed by
// the standardwebhooks lib). It validates the HMAC signature AND rejects a
// timestamp more than 5 minutes from now, throwing on any failure. The RAW
// request body must be read and passed verbatim -- re-stringifying the parsed
// JSON changes the bytes and breaks the signature.

export const runtime = 'nodejs'

// LIKE/ILIKE treat '%' and '_' as wildcards and '\' as the escape char. Email
// local-parts routinely contain '_' (e.g. john_doe@x.com), so an unescaped
// ilike would match unrelated rows. Escape all three so the pattern matches the
// address literally (case-insensitively).
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// Normalise the recipient list: keep non-empty strings, trim, dedupe. Match is
// case-insensitive at the DB layer (ilike), so case is preserved here for logs.
function normalizeAddresses(to: unknown): string[] {
  if (!Array.isArray(to)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of to) {
    if (typeof raw !== 'string') continue
    const addr = raw.trim()
    if (!addr) continue
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  return out
}

// Build a short human-readable bounce reason from Resend's bounce payload
// ({ type, subType, message }). Capped so a verbose provider message can't
// bloat the column.
function buildBounceReason(bounce: unknown): string | null {
  if (!bounce || typeof bounce !== 'object') return null
  const b = bounce as { type?: unknown; subType?: unknown; message?: unknown }
  const parts: string[] = []
  if (typeof b.type === 'string' && b.type) parts.push(b.type)
  if (typeof b.subType === 'string' && b.subType) parts.push(b.subType)
  let reason = parts.join(' / ')
  if (typeof b.message === 'string' && b.message) {
    reason = reason ? `${reason}: ${b.message}` : b.message
  }
  reason = reason.trim()
  return reason ? reason.slice(0, 500) : null
}

// Only a permanent/hard bounce means the address is genuinely undeliverable
// (and gets suppressed by Resend). Transient bounces (mailbox full, greylisting,
// temporary DNS) recover on retry and must not flag the account. Resend's
// EmailBounce.type is 'Permanent' | 'Transient' | 'Undetermined'; anything other
// than an explicit 'Permanent' is treated as non-permanent (fail-safe: do not
// mark an account blocked on ambiguous signal).
function isPermanentBounce(bounce: unknown): boolean {
  if (!bounce || typeof bounce !== 'object') return false
  const t = (bounce as { type?: unknown }).type
  return typeof t === 'string' && t.trim().toLowerCase() === 'permanent'
}

// Apply the same column mutation to both tables for every matching address.
// A handful of queries (2 per address; a bounce almost always has one
// recipient), never a per-row loop. A miss in either or both tables is fine.
//
// opts.clearOnlyOlderThan (used by the delivered handler): restrict the update
// to rows whose stored email_bounced_at is strictly older than this instant, so
// an out-of-order/reordered delivered event can never wipe a newer bounce. Rows
// with a null email_bounced_at do not satisfy the `<` comparison and are left
// untouched (already clear).
async function applyToBothTables(
  admin: SupabaseClient,
  addresses: string[],
  values: { email_bounced_at: string | null; email_bounce_reason: string | null },
  opts?: { clearOnlyOlderThan?: string }
): Promise<void> {
  for (const addr of addresses) {
    const pattern = escapeLike(addr)
    for (const table of ['profiles', 'students'] as const) {
      let query = admin.from(table).update(values).ilike('email', pattern)
      if (opts?.clearOnlyOlderThan) {
        query = query.lt('email_bounced_at', opts.clearOnlyOlderThan)
      }
      const { error } = await query
      if (error) {
        console.error(
          `[resend-webhook] failed to update ${table} for ${addr}:`,
          error.message
        )
      }
    }
  }
}

export async function POST(req: Request) {
  // Read the raw body BEFORE any parsing: signature is over these exact bytes.
  const rawBody = await req.text()

  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET is not configured')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: 'Missing signature headers' }, { status: 401 })
  }

  // resend.webhooks.verify() throws on a bad signature, a stale/future
  // timestamp (> 5 min), or malformed headers. Any throw -> 401.
  let event: { type?: string; created_at?: string; data?: unknown }
  try {
    event = resend.webhooks.verify({
      payload: rawBody,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      webhookSecret: secret,
    }) as { type?: string; created_at?: string; data?: unknown }
  } catch (err) {
    console.error(
      '[resend-webhook] signature verification failed:',
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const type = event.type
  const data = (event.data ?? {}) as {
    to?: unknown
    created_at?: unknown
    bounce?: unknown
  }

  const admin = createAdminClient()

  if (type === 'email.bounced') {
    const addresses = normalizeAddresses(data.to)
    // Transient/non-permanent bounces recover on retry: log and acknowledge,
    // but never flag the account.
    if (!isPermanentBounce(data.bounce)) {
      console.log(
        `[resend-webhook] email.bounced (transient, not flagged) -> ${addresses.join(', ') || '(no recipients)'}`
      )
      return NextResponse.json({ ok: true }, { status: 200 })
    }
    // Use the event's own timestamp (not wall-clock now()) so a replayed
    // delivery of the SAME event yields identical state (idempotent).
    const bouncedAt =
      (typeof data.created_at === 'string' && data.created_at) ||
      (typeof event.created_at === 'string' && event.created_at) ||
      new Date().toISOString()
    const reason = buildBounceReason(data.bounce)
    console.log(
      `[resend-webhook] email.bounced (permanent) -> ${addresses.join(', ') || '(no recipients)'}`
    )
    if (addresses.length > 0) {
      await applyToBothTables(admin, addresses, {
        email_bounced_at: bouncedAt,
        email_bounce_reason: reason,
      })
    }
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  if (type === 'email.delivered') {
    const addresses = normalizeAddresses(data.to)
    // Webhooks can arrive out of order. Clear only a bounce flag OLDER than this
    // delivery, so a late/reordered delivered event cannot wipe a newer bounce.
    const deliveredAt =
      (typeof data.created_at === 'string' && data.created_at) ||
      (typeof event.created_at === 'string' && event.created_at) ||
      new Date().toISOString()
    console.log(
      `[resend-webhook] email.delivered -> ${addresses.join(', ') || '(no recipients)'}`
    )
    if (addresses.length > 0) {
      // A successful delivery clears any older bounce flag on both tables.
      // Re-running with the same NULLs (bounded by clearOnlyOlderThan) is idempotent.
      await applyToBothTables(
        admin,
        addresses,
        {
          email_bounced_at: null,
          email_bounce_reason: null,
        },
        { clearOnlyOlderThan: deliveredAt }
      )
    }
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // Valid signature, event type we don't act on -> acknowledge with 200 so
  // Resend does not retry.
  return NextResponse.json({ ok: true }, { status: 200 })
}
