'use server'

import { createClient } from '@/lib/supabase/server'
import { fetchStudentWhatsNew } from '@/lib/studentWhatsNew'

// Per-item dismissal of the student What's New feed. Sibling of
// (dashboard)/actions/whatsNewDismiss.ts. Mirrors the auth structure of
// actions/studentWhatsNewSeen.ts (session client establishes identity) EXCEPT
// the write goes through the regular RLS-scoped server client, not the admin
// client: public.student_whats_new_dismissals has normal grants and an RLS
// policy that lets a student select/insert only their own rows
// (student_auth_id = auth.uid()), so RLS — not the service role — enforces
// ownership.
//
// IDENTITY RULE: dismissal rows key on student_auth_id = auth.uid() (=
// students.auth_user_id). The students table PK (students.id) is used ONLY to
// scope the feed refetch in clearAllStudentWhatsNew — never for dismissal rows.
// Never mix the two.
//
// item_key == WhatsNewItem.id (the synthetic feed key, e.g. `cancelled-<uuid>`).
// Upserts are idempotent: the UNIQUE(student_auth_id, item_key) constraint plus
// ignoreDuplicates means re-dismissing an already-dismissed item is a no-op.

export async function dismissStudentWhatsNewItem(itemKey: string): Promise<void> {
  if (typeof itemKey !== 'string' || itemKey.length === 0) return

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  await supabase
    .from('student_whats_new_dismissals')
    .upsert(
      { student_auth_id: user.id, item_key: itemKey },
      { onConflict: 'student_auth_id,item_key', ignoreDuplicates: true },
    )
}

// Clear the ENTIRE feed, not just the visible page. The client never supplies
// keys — this recomputes the feed server-side and dismisses everything it finds.
// fetchStudentWhatsNew caps at 6 and filters already-dismissed keys, so each
// pass returns the next undismissed page; dismissing every returned id and
// re-fetching drains the feed page by page. The 10-iteration hard cap is a
// safety stop (if a write silently fails, the same page would keep coming back —
// the cap prevents an infinite loop rather than being a real page-count limit).
export async function clearAllStudentWhatsNew(): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  // Resolve the students table PK from the auth uid — the feed queries scope on
  // students.id while the dismissal rows key on auth.uid() (identity rule above).
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (!student) return

  for (let i = 0; i < 10; i++) {
    const items = await fetchStudentWhatsNew(supabase, student.id, user.id)
    if (items.length === 0) break
    const rows = items.map((item) => ({ student_auth_id: user.id, item_key: item.id }))
    await supabase
      .from('student_whats_new_dismissals')
      .upsert(rows, { onConflict: 'student_auth_id,item_key', ignoreDuplicates: true })
  }
}
