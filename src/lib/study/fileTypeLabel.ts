// Short badge label for an attachment's MIME type ('PDF', 'DOCX', ...), shared
// by the admin library list.
//
// This is a verbatim copy of the local function of the same name still living
// inside src/app/(admin)/admin/library/SheetFormModal.tsx. Two copies is one too
// many: converge them by importing this one there the next time that file is
// touched. Any change here must be mirrored there until then.
export function fileTypeLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'application/msword') return 'DOC'
  if (mimeType.includes('wordprocessingml')) return 'DOCX'
  if (mimeType === 'application/vnd.ms-powerpoint') return 'PPT'
  if (mimeType.includes('presentationml')) return 'PPTX'
  return mimeType.split('/')[1]?.toUpperCase() ?? 'FILE'
}
