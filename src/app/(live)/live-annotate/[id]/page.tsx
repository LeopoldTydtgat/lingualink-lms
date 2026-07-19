// src/app/(live)/live-annotate/[id]/page.tsx
// Live-annotation page (NEW255, Piece c-ii). Chrome-free counterpart of the
// teacher study-sheet prep page: same loadStudySheetDetail loader, same
// StudySheetDetailClient, but under the (live) route group and with live={true}
// so the Back button / file management are hidden and correct answers are NOT
// resolved — this window is screen-shared into Teams, so it must never surface
// the answer key. The loader is awaited directly with NO try/catch, so its
// redirect('/login') / notFound() gates propagate as thrown control-flow.
import { loadStudySheetDetail } from '@/lib/study-sheets/loadStudySheetDetail'
import { prepActivity, type PreppedActivity } from '@/lib/study/prepActivities'
import StudySheetDetailClient from '@/app/(dashboard)/study-sheets/[id]/StudySheetDetailClient'

export default async function LiveAnnotatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { sheet, activities, isAdmin, isOwned, annotationsByName } = await loadStudySheetDetail(id)

  // rawAnswerKey = null: activities render as question lists with NO correct
  // answer / explanation. The screen-shareable live window must not leak the key.
  const preppedActivities: PreppedActivity[] = activities.map(a => prepActivity(a, null))

  return (
    <StudySheetDetailClient
      sheet={sheet}
      activities={preppedActivities}
      isAdmin={isAdmin}
      isOwned={isOwned}
      annotationsByName={annotationsByName}
      live
    />
  )
}
