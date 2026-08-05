'use server'

import { createClient } from '@/lib/supabase/server'
import { fetchWhatsNew } from '@/lib/whatsNew'

// Per-item dismissal of the teacher What's New feed. Mirrors the auth structure
// of actions/whatsNewSeen.ts (session client establishes identity) EXCEPT the
// write goes through the regular RLS-scoped server client, not the admin client:
// public.whats_new_dismissals has normal grants and an RLS policy that lets a
// teacher select/insert only their own rows (teacher_id = auth.uid()), so RLS —
// not the service role — enforces ownership.
//
// item_key == WhatsNewItem.id (the synthetic feed key, e.g. `booked-<uuid>`).
// Upserts are idempotent: the UNIQUE(teacher_id, item_key) constraint plus
// ignoreDuplicates means re-dismissing an already-dismissed item is a no-op.
//
// FAILURE MODEL: supabase-js RESOLVES with { error } on a PostgREST failure — it
// does not throw. Every write below binds and checks that error, logs it, and
// throws, so a denied or failed write surfaces to the caller instead of reading
// as success.

export async function dismissWhatsNewItem(itemKey: string): Promise<void> {
  if (typeof itemKey !== 'string' || itemKey.length === 0) return

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const { error } = await supabase
    .from('whats_new_dismissals')
    .upsert(
      { teacher_id: user.id, item_key: itemKey },
      { onConflict: 'teacher_id,item_key', ignoreDuplicates: true },
    )

  if (error) {
    console.error('[dismissWhatsNewItem] dismissal upsert failed:', error)
    throw new Error('WHATS_NEW_DISMISS_FAILED')
  }
}

// Clear the ENTIRE feed, not just the visible page. The client never supplies
// keys — this recomputes the feed server-side and dismisses everything it finds.
// fetchWhatsNew caps at 6 and filters already-dismissed keys, so each pass returns
// the next undismissed page; dismissing every returned id and re-fetching drains
// the feed page by page. The 10-iteration cap is a pure loop guard: a failed write
// now throws on the spot, and exhausting the cap without an empty fetch means the
// feed did not drain — that also throws rather than reporting a false success.
export async function clearAllWhatsNew(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  let drained = false

  for (let i = 0; i < 10; i++) {
    const items = await fetchWhatsNew(supabase, user.id)
    if (items.length === 0) {
      drained = true
      break
    }
    const rows = items.map((item) => ({ teacher_id: user.id, item_key: item.id }))
    const { error } = await supabase
      .from('whats_new_dismissals')
      .upsert(rows, { onConflict: 'teacher_id,item_key', ignoreDuplicates: true })

    if (error) {
      console.error('[clearAllWhatsNew] dismissal upsert failed:', error)
      throw new Error('WHATS_NEW_CLEAR_FAILED')
    }
  }

  if (!drained) {
    console.error('[clearAllWhatsNew] feed still returned items after 10 passes; not drained')
    throw new Error('WHATS_NEW_CLEAR_FAILED')
  }
}
