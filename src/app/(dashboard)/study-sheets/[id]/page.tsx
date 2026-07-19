import { loadStudySheetDetail } from '@/lib/study-sheets/loadStudySheetDetail'
import { createAdminClient } from '@/lib/supabase/admin'
import { prepActivity, type PreppedActivity } from '@/lib/study/prepActivities'
import StudySheetDetailClient from './StudySheetDetailClient'

export default async function StudySheetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { sheet, activities, isAdmin, isOwned, annotationsByName } = await loadStudySheetDetail(id)

  // Prep view: correct answers ARE shown (teacher-facing). answer_key is
  // service-role only (column-grant-excluded), so it is read here with the
  // admin client and resolved server-side — only the resolved strings reach
  // the client, never the raw key structure.
  const admin = createAdminClient()
  const { data: keyRows } = await admin
    .from('activities')
    .select('id, answer_key')
    .eq('sheet_id', id)

  const keyById = new Map<string, unknown>()
  for (const row of keyRows ?? []) keyById.set(row.id, row.answer_key)

  const preppedActivities: PreppedActivity[] = activities.map(a =>
    prepActivity(a, keyById.get(a.id) ?? null)
  )

  return (
    <StudySheetDetailClient
      sheet={sheet}
      activities={preppedActivities}
      isAdmin={isAdmin}
      isOwned={isOwned}
      annotationsByName={annotationsByName}
    />
  )
}
