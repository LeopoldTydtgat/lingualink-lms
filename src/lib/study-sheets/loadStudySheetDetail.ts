import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { getLiveLessonForTeacher } from '@/lib/lessons/liveLesson'
import type { Annotation } from '@/components/pdf/PdfViewer'

type Attachment = { name: string; url: string; type: string }

// ---------------------------------------------------------------------------
// Study-sheet detail loader (NEW255, Piece c-i).
//
// The single server-side data load behind the teacher's study-sheet prep page,
// extracted verbatim so a future chrome-free live-annotation page can load the
// IDENTICAL data (same user-scoped RLS client, same queries, same annotation
// seed) without duplicating the logic. Behaviour is unchanged from the inline
// version: same auth gate, same notFound, same values returned.
// ---------------------------------------------------------------------------
export async function loadStudySheetDetail(id: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: isAdminResult } = await supabase.rpc('is_admin')

  const { data: sheet } = await supabase
    .from('study_sheets')
    .select('id, title, category, level, difficulty, content, attachments')
    .eq('id', id)
    .single()

  if (!sheet) notFound()

  const { data: exercises } = await supabase
    .from('exercises')
    .select('*')
    .eq('study_sheet_id', id)
    .order('created_at', { ascending: true })

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
    exercises: exercises ?? [],
    isAdmin: isAdminResult === true,
    annotationsByName,
  }
}

// The shape a caller (the prep page today, the live-annotation page in c-ii)
// gets back. Exported so both render the same data without re-deriving it.
export type StudySheetDetail = Awaited<ReturnType<typeof loadStudySheetDetail>>
