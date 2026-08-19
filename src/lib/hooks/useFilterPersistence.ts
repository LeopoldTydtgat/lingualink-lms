'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * sessionStorage persistence for one list page's filter state.
 *
 * Generic on purpose: the key and the record shape are both the caller's, so the
 * admin list pages that follow (Reports, Billing, Hours Log, Tasks) can each hold
 * their own record under their own key without a second copy of this logic. This
 * hook owns WHEN to read and write; the caller owns WHAT a valid record is.
 *
 * sessionStorage, not localStorage: filters are scoped to one browsing session.
 * Reopening the portal tomorrow should start clean, while stepping into a class
 * and pressing Back should not.
 *
 * HYDRATION. Every storage touch happens inside an effect or an event handler,
 * never during render and never in a useState initializer. The first client render
 * therefore matches the server's, and the restore lands one frame later — a
 * deliberate trade (no loading gate, no hidden list) rather than an oversight.
 *
 * FAIL-SILENT. sessionStorage throws outright when storage is disabled or the
 * quota is full, JSON.parse throws on a truncated value, and `parse` is caller
 * code that may throw on a shape it did not expect. All three are caught and read
 * as "nothing usable stored" — a corrupt record degrades to default filters and
 * never to a broken page.
 */
export function useFilterPersistence<T>({
  storageKey,
  value,
  defaultValue,
  skipRestore,
  parse,
  apply,
}: {
  /** Page-scoped storage key, e.g. 'll-admin-classes-filters'. */
  storageKey: string
  /** The record to persist, rebuilt by the caller whenever a persisted filter changes. */
  value: T
  /**
   * The record that means "no filters". When `value` matches it the key is REMOVED
   * rather than written, so a cleared page leaves no key behind — the same end state
   * `clear()` produces, reached automatically however the reset happened.
   */
  defaultValue: T
  /**
   * True when the URL carries filter/deep-link params. The URL wins outright: the
   * restore is skipped entirely and storage is overwritten from the URL-derived
   * state, so a deep link is never quietly widened by a stale stored filter.
   */
  skipRestore: boolean
  /** Shape validation for a decoded stored value. Return null to reject it. */
  parse: (raw: unknown) => T | null
  /** Push a restored record into the caller's state. Called at most once, on mount. */
  apply: (restored: T) => void
}): { clear: () => void } {
  // Canonical (key-order-independent) encoding, so the default comparison below can
  // never miss because two literals happened to list their fields in a different
  // order. Cheap: these records are a handful of scalar fields.
  const serialized = stableStringify(value)
  const defaultSerialized = stableStringify(defaultValue)

  // Latest-callback refs, so the storage effect can depend on the SERIALIZED value
  // alone. Depending on the callbacks instead would re-run it on every render (a new
  // closure each time), and a write per render is not what "write when a filter
  // changes" means.
  const parseRef = useRef(parse)
  const applyRef = useRef(apply)
  const skipRestoreRef = useRef(skipRestore)
  const bootedRef = useRef(false)

  // Declared FIRST so it commits before the storage effect in the same pass.
  useEffect(() => {
    parseRef.current = parse
    applyRef.current = apply
    skipRestoreRef.current = skipRestore
  })

  useEffect(() => {
    if (serialized === null || defaultSerialized === null) return

    // Mount pass only. The restore is one-shot: after it, this effect is purely the
    // writer, so a later render can never re-apply a stored value over what the user
    // has since changed on screen.
    if (!bootedRef.current) {
      bootedRef.current = true
      if (!skipRestoreRef.current) {
        const restored = readRecord(storageKey, parseRef.current)
        if (restored !== null) {
          applyRestored(applyRef.current, restored)
          // No write on this pass: `value` still describes the pre-restore defaults.
          // The state apply() just queued re-renders with a new `serialized`, and
          // THAT pass writes the restored record back.
          return
        }
      }
    }

    if (serialized === defaultSerialized) removeRecord(storageKey)
    else writeRecord(storageKey, serialized)
  }, [storageKey, serialized, defaultSerialized])

  const clear = useCallback(() => {
    removeRecord(storageKey)
  }, [storageKey])

  return { clear }
}

/**
 * JSON with object keys sorted at every level. Two records that differ only in key
 * order encode identically, which is what makes `serialized === defaultSerialized`
 * a reliable "these are the default filters" test.
 *
 * Returns null if the value cannot be encoded at all, which this hook reads as
 * "do not persist" rather than as an error.
 */
function stableStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
      const source = val as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(source)
          .sort()
          .map((k) => [k, source[k]])
      )
    })
  } catch {
    return null
  }
}

/** Read + decode + validate. Any failure at any step reads as "nothing stored". */
function readRecord<T>(storageKey: string, parse: (raw: unknown) => T | null): T | null {
  let raw: string | null
  try {
    raw = window.sessionStorage.getItem(storageKey)
  } catch {
    return null // storage disabled (private mode, blocked cookies)
  }
  if (!raw) return null

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null // truncated or hand-edited value
  }

  try {
    return parse(decoded)
  } catch {
    return null // caller validator threw on an unexpected shape
  }
}

/** Caller state-setters, isolated so a throw in one cannot escape into React's commit. */
function applyRestored<T>(apply: (restored: T) => void, restored: T): void {
  try {
    apply(restored)
  } catch {
    // Restore is best-effort; default filters are always a valid page.
  }
}

function writeRecord(storageKey: string, serialized: string): void {
  try {
    window.sessionStorage.setItem(storageKey, serialized)
  } catch {
    // Quota exceeded or storage disabled — the page works, it just will not remember.
  }
}

function removeRecord(storageKey: string): void {
  try {
    window.sessionStorage.removeItem(storageKey)
  } catch {
    // As above.
  }
}
