import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { getLiveLessonForTeacher } from '@/lib/lessons/liveLesson'
import type { Annotation } from '@/components/pdf/PdfViewer'
import StudySheetDetailClient from './StudySheetDetailClient'

export default async function StudySheetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
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
  // lesson -> {} -> every viewer seeds empty (unchanged behaviour). Keyed per
  // attachment index so each PDF in study_sheets.attachments gets its own overlay.
  const live = await getLiveLessonForTeacher()
  const annotationsByAttachment: Record<number, Annotation[]> = {}
  if (live) {
    const { data: annRows } = await supabase
      .from('lesson_annotations')
      .select('attachment_index, annotations')
      .eq('lesson_id', live.lessonId)
      .eq('study_sheet_id', id)
    for (const row of annRows ?? []) {
      annotationsByAttachment[row.attachment_index] = (row.annotations ?? []) as Annotation[]
    }
  }

  return (
    <StudySheetDetailClient
      sheet={sheet}
      exercises={exercises ?? []}
      isAdmin={isAdminResult === true}
      annotationsByAttachment={annotationsByAttachment}
    />
  )
}
