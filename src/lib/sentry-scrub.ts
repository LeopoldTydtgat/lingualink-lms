// Recursive PII scrubber for Sentry events.
//
// Sentry can capture request bodies, contexts, and breadcrumbs that include
// fields we never want to leave the server: passwords, auth tokens, hourly
// rates, admin notes, payment details, etc. The application code does its
// best to keep these out of error paths, but a single careless `.toString()`
// or thrown error message could surface them.
//
// This helper walks the whole event and replaces any value whose key matches
// the sensitive-field regex with '[Redacted]'. It is used from `beforeSend`
// in all three sentry.*.config.ts files.

const SENSITIVE_KEY = /password|token|hourly_rate|admin_notes|cancellation_policy|banking_details|iban|bic|tax_number|paypal_email/i

const REDACTED = '[Redacted]'

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 8) return value
  if (Array.isArray(value)) {
    return value.map(v => scrubValue(v, depth + 1, seen))
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = REDACTED
      } else {
        out[k] = scrubValue(v, depth + 1, seen)
      }
    }
    return out
  }
  return value
}

// Sentry's Event type is broad and varies by SDK version. We type the input as
// a generic record so the helper compiles in client/server/edge configs alike.
export function scrubEvent<T extends Record<string, unknown>>(event: T): T {
  if (!event || typeof event !== 'object') return event
  const seen = new WeakSet<object>()
  const ev = event as Record<string, unknown>

  if (isPlainObject(ev.request)) {
    const req = ev.request as Record<string, unknown>
    if ('data' in req) req.data = scrubValue(req.data, 0, seen)
    if ('headers' in req) req.headers = scrubValue(req.headers, 0, seen)
    if ('cookies' in req) req.cookies = scrubValue(req.cookies, 0, seen)
    if ('query_string' in req) req.query_string = scrubValue(req.query_string, 0, seen)
  }

  if ('contexts' in ev) ev.contexts = scrubValue(ev.contexts, 0, seen)
  if ('extra' in ev) ev.extra = scrubValue(ev.extra, 0, seen)
  if ('tags' in ev) ev.tags = scrubValue(ev.tags, 0, seen)

  if (Array.isArray(ev.breadcrumbs)) {
    ev.breadcrumbs = (ev.breadcrumbs as unknown[]).map(b => scrubValue(b, 0, seen))
  }

  return event
}
