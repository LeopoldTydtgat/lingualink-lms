import { loadStudySheetDetail } from '@/lib/study-sheets/loadStudySheetDetail'
import StudySheetDetailClient from './StudySheetDetailClient'

export default async function StudySheetDetailPage({
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
    />
  )
}
