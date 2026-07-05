// src/app/(live)/live-annotate/[id]/page.tsx
// Live-annotation page (NEW255, Piece c-ii). Chrome-free counterpart of the
// teacher study-sheet prep page: same loadStudySheetDetail loader, same
// StudySheetDetailClient, but under the (live) route group and with live={true}
// so the Back button is hidden (a mid-class Back must not escape into the
// chromed dashboard). The loader is awaited directly with NO try/catch, so its
// redirect('/login') / notFound() gates propagate as thrown control-flow.
import { loadStudySheetDetail } from '@/lib/study-sheets/loadStudySheetDetail'
import StudySheetDetailClient from '@/app/(dashboard)/study-sheets/[id]/StudySheetDetailClient'

export default async function LiveAnnotatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { sheet, exercises, isAdmin, annotationsByName } = await loadStudySheetDetail(id)

  return (
    <StudySheetDetailClient
      sheet={sheet}
      exercises={exercises}
      isAdmin={isAdmin}
      annotationsByName={annotationsByName}
      live
    />
  )
}
