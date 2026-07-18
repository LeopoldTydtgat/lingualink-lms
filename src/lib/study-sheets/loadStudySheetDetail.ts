import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { getLiveLessonForTeacher } from '@/lib/lessons/liveLesson'
import type { Annotation } from '@/components/pdf/PdfViewer'

type Attachment = { name: string; url: string; type: string }

// Basic (client-safe) activity shape. answer_key is DELIBERATELY not read here:
// this loader also serves the live-annotation window, and the answer key is
// resolved separately (server-side, admin client) only where the prep view
// needs it. The `authenticated` column grant on activities excludes answer_key
// anyway, so this user-scoped read could not surface it.
type BasicActivity = {
  id: string
  position: number
  type: string
  title: string | null
  content: unknown
}

// ---------------------------------------------------------------------------
// Study-sheet detail loader (NEW255 Piece c-i; reworked NEW375/NEW377).
//
// The single server-side data load behind the teacher's study-sheet prep page,
// extracted so the chrome-free live-annotation page loads the IDENTICAL data
// (same user-scoped RLS client, same queries, same annotation seed). Reads the
// canonical `activities` table (was the legacy `exercises` table). Inactive
// sheets are filtered out at the query, so both callers notFound() on them.
// ---------------------------------------------------------------------------
export async function loadStudySheetDetail(id: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: isAdminResult } = await supabase.rpc('is_admin')

  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, content, attachments, owner_id, is_active')
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle()

  if (!sheet) notFound()

  // Canonical activities read (id, position, type, title, content), ordered by
  // position. answer_key is never selected here — see BasicActivity above.
  const { data: activities } = await supabase
    .from('activities')
    .select('id, position, type, title, content')
    .eq('sheet_id', id)
    .order('position', { ascending: true })

  // Seed saved annotations for the CURRENTLY LIVE lesson, if any. This is the
  // first reader of lesson_annotations. The live lesson is resolved SERVER-SIDE
  // by the same resolver the autosave uses (W2 — the browser never names the
  // class), and the read runs on the user-scoped `supabase` client above so the
  // "Teachers read own lesson annotations" RLS policy governs it (W1). No live
  // lesson -> {} -> every viewer seeds empty (unchanged behaviour).
  //
  // Keyed by the attachment's STABLE FILENAME, not its array position: an admin
  // reorder/removal changes attachment_index but not the filename, so keying on the
  // name keeps each mark set bound to its PDF. The client looks each CURRENT
  // attachment up by att.name. Mirrors the student read path
  // (/api/lesson-annotation-file). Legacy rows with a null attachment_name (none
  // exist — the column shipped this session with the table empty) fall back to the
  // filename currently at their stored index.
  const live = await getLiveLessonForTeacher()
  const attachments: Attachment[] = Array.isArray(sheet.attachments) ? sheet.attachments : []
  const annotationsByName: Record<string, Annotation[]> = {}
  if (live) {
    const { data: annRows } = await supabase
      .from('lesson_annotations')
      .select('attachment_index, attachment_name, annotations')
      .eq('lesson_id', live.lessonId)
      .eq('study_sheet_id', id)
    for (const row of annRows ?? []) {
      const name =
        typeof row.attachment_name === 'string' && row.attachment_name.length > 0
          ? row.attachment_name
          : attachments[row.attachment_index]?.name
      if (typeof name === 'string' && name.length > 0) {
        annotationsByName[name] = (row.annotations ?? []) as Annotation[]
      }
    }
  }

  return {
    sheet,
    activities: (activities ?? []) as BasicActivity[],
    isAdmin: isAdminResult === true,
    // owner_id FK -> profiles(id); profiles.id IS the auth uid, so this compares
    // like-for-like. Non-owned (admin-library) sheets get no file-management UI.
    isOwned: sheet.owner_id === user.id,
    annotationsByName,
  }
}

// The shape a caller (the prep page, the live-annotation page) gets back.
// Exported so both render the same data without re-deriving it.
export type StudySheetDetail = Awaited<ReturnType<typeof loadStudySheetDetail>>
