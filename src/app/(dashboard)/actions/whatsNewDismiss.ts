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

export async function dismissWhatsNewItem(itemKey: string): Promise<void> {
  if (typeof itemKey !== 'string' || itemKey.length === 0) return

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  await supabase
    .from('whats_new_dismissals')
    .upsert(
      { teacher_id: user.id, item_key: itemKey },
      { onConflict: 'teacher_id,item_key', ignoreDuplicates: true },
    )
}

// Clear the ENTIRE feed, not just the visible page. The client never supplies
// keys — this recomputes the feed server-side and dismisses everything it finds.
// fetchWhatsNew caps at 6 and filters already-dismissed keys, so each pass returns
// the next undismissed page; dismissing every returned id and re-fetching drains
// the feed page by page. The 10-iteration hard cap is a safety stop (if a write
// silently fails, the same page would keep coming back — the cap prevents an
// infinite loop rather than being a real page-count limit).
export async function clearAllWhatsNew(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  for (let i = 0; i < 10; i++) {
    const items = await fetchWhatsNew(supabase, user.id)
    if (items.length === 0) break
    const rows = items.map((item) => ({ teacher_id: user.id, item_key: item.id }))
    await supabase
      .from('whats_new_dismissals')
      .upsert(rows, { onConflict: 'teacher_id,item_key', ignoreDuplicates: true })
  }
}
