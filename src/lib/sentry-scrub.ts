// Recursive PII scrubber for Sentry events.
//
// Sentry can capture request bodies, contexts, and breadcrumbs that include
// fields we never want to leave the server: passwords, auth tokens, hourly
// rates, admin notes, payment details, etc. The application code does its
// best to keep these out of error paths, but a single careless `.toString()`
// or thrown error message could surface them.
//
// This helper walks the whole event and redacts on TWO axes:
//   1. by KEY: any value whose key matches the sensitive-field regex is
//      replaced wholesale with '[Redacted]';
//   2. by VALUE: any STRING anywhere in the event (including request.url,
//      the event message, breadcrumb messages and exception messages) has
//      token-shaped content redacted in place: the values of sensitive URL
//      query parameters (?token_hash=..., ?code=..., ?access_token=...) and
//      any JWT-shaped run of characters.
//
// Axis 2 matters because the dangerous payloads are usually not stored under
// a helpfully-named key; they are pasted inside a URL or an error string,
// e.g. `/reset-password?token_hash=abc123` or `JWSError ... eyJhbGci...`.
// Scrubbing by value keeps the surrounding path/message intact so the event
// is still diagnosable.
//
// It is used from `beforeSend` in all three sentry.*.config.ts files.

const SENSITIVE_KEY = /password|token|hourly_rate|admin_notes|cancellation_policy|banking_details|iban|bic|tax_number|paypal_email/i

// Groups 1 and 2 preserve the separator and parameter name so only the value
// is replaced and the rest of the URL survives. The `[?&#]` prefix in group 1
// is optional so a bare query string (Sentry's request.query_string, which
// has no leading `?`) is covered too. The alternation is ordered longest-first
// deliberately, so e.g. `token_hash` matches before the shorter `token`.
const SENSITIVE_PARAM = /(^|[?&#])((?:token_hash|access_token|refresh_token|token|nonce|code)=)[^&#\s]+/gi

// A JWT anywhere inside free text: three base64url segments joined by dots,
// the first starting with the `eyJ` that a base64-encoded `{"` always yields.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g

const REDACTED = '[Redacted]'

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

// Both patterns carry /g, so `replace` walks every match and resets lastIndex
// on completion; never call `.test()` on them, which would leave it dangling.
function scrubString(value: string): string {
  return value
    .replace(SENSITIVE_PARAM, `$1$2${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 8) return value
  if (typeof value === 'string') return scrubString(value)
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
    if ('url' in req) req.url = scrubValue(req.url, 0, seen)
    if ('data' in req) req.data = scrubValue(req.data, 0, seen)
    if ('headers' in req) req.headers = scrubValue(req.headers, 0, seen)
    if ('cookies' in req) req.cookies = scrubValue(req.cookies, 0, seen)
    if ('query_string' in req) req.query_string = scrubValue(req.query_string, 0, seen)
  }

  if ('contexts' in ev) ev.contexts = scrubValue(ev.contexts, 0, seen)
  if ('extra' in ev) ev.extra = scrubValue(ev.extra, 0, seen)
  if ('tags' in ev) ev.tags = scrubValue(ev.tags, 0, seen)

  if (typeof ev.message === 'string') ev.message = scrubString(ev.message)

  // Exception entries are patched in place so `type` and `stacktrace` keep
  // their identity: only the human-readable `value` can carry a token.
  if (isPlainObject(ev.exception)) {
    const exc = ev.exception as Record<string, unknown>
    if (Array.isArray(exc.values)) {
      for (const entry of exc.values as unknown[]) {
        if (isPlainObject(entry) && typeof entry.value === 'string') {
          entry.value = scrubString(entry.value)
        }
      }
    }
  }

  if (Array.isArray(ev.breadcrumbs)) {
    ev.breadcrumbs = (ev.breadcrumbs as unknown[]).map(b => scrubValue(b, 0, seen))
  }

  return event
}
