import { PDFDocument } from 'pdf-lib'
import type { SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'library-files'

// Only the two fields this preflight reads. Teacher uploads store { name, type };
// admin-library uploads may carry more. Nothing here consumes anything else.
type Attachment = { name: string; type: string }

/**
 * Shared read-only preflight for a teaching-material homework grant
 * (material_assignments), used by BOTH assign routes:
 *
 *   - POST /api/teacher/material-assignments  (authorised by RLS on the insert)
 *   - POST /api/admin/material-assignments    (authorised by requireAdmin())
 *
 * NONE OF THIS IS AUTHORISATION. It only stops a grant being written that the
 * file route (/api/material-assignment-file/[assignmentId]) could never serve.
 * Each caller keeps its own authorisation gate and must not treat an `ok: true`
 * as permission to write.
 *
 * The checks, in order, mirror the file route exactly:
 *   1. the sheet exists, is active, and is audience='staff' (that is what makes
 *      it teaching material - a student worksheet is assigned through the
 *      `assignments` table instead);
 *   2. the attachment at `attachmentIndex` exists and its name passes the same
 *      filename charset gate the file route applies before building a storage
 *      path (a name that fails it could never be served);
 *   3. the attachment is a PDF (the file route rebuilds the document page by
 *      page and refuses anything else);
 *   4. when BOTH page bounds are set, the range fits the REAL document, so a
 *      typo fails in front of the person assigning rather than 422-ing the
 *      student later. Skipped for a whole-document grant: there is no range to
 *      outrun, and the file route re-resolves the range on every request anyway.
 *
 * Resolution is POSITIONAL here and name-first everywhere afterwards: the caller
 * picks a position in the CURRENT attachments array, and `attachmentName` is
 * stored on the row so a later reorder or removal cannot shift the grant onto a
 * different PDF. The name must never be taken from a request body.
 *
 * Requires the SERVICE-ROLE client: it reads study_sheets metadata and pulls the
 * stored PDF out of a private bucket, neither of which every calling role can do
 * under its own RLS. The caller injects it (same contract as
 * src/lib/access/accountStatus.ts) so one instance can be reused for the rest of
 * the request.
 *
 * `logPrefix` keeps each route's console output under its own tag - pass the
 * exact prefix that route already logs with.
 */
export type MaterialAssignPreflight =
  | { ok: true; attachmentName: string }
  | { ok: false; status: number; body: { error: string; code?: string } }

export async function runMaterialAssignPreflight(
  adminClient: SupabaseClient,
  params: {
    studySheetId: string
    attachmentIndex: number
    pageStart: number | null
    pageEnd: number | null
  },
  logPrefix: string
): Promise<MaterialAssignPreflight> {
  const { studySheetId, attachmentIndex, pageStart, pageEnd } = params

  const { data: sheet, error: sheetError } = await adminClient
    .from('study_sheets')
    .select('id, is_active, audience, attachments')
    .eq('id', studySheetId)
    .maybeSingle()

  if (sheetError) {
    console.error(`${logPrefix} study_sheets lookup failed:`, sheetError)
    return { ok: false, status: 500, body: { error: 'Something went wrong' } }
  }
  // audience='staff' is what makes a sheet teaching material. A student
  // worksheet (audience='student') is assigned through the assignments table,
  // never as a page-scoped material grant.
  if (!sheet || sheet.is_active !== true || sheet.audience !== 'staff') {
    return { ok: false, status: 404, body: { error: 'Teaching material not found.' } }
  }

  const attachments: Attachment[] = Array.isArray(sheet.attachments) ? sheet.attachments : []

  const attachment = attachments[attachmentIndex]

  // Same filename charset gate the file route applies before building the
  // storage path - a name that fails it could never be served, so the grant
  // must not be written.
  if (
    !attachment ||
    typeof attachment.name !== 'string' ||
    !/^[a-zA-Z0-9._-]+$/.test(attachment.name)
  ) {
    return { ok: false, status: 404, body: { error: 'That file is not on this sheet.' } }
  }

  // Same PDF gate as the file route (attachment.type === 'application/pdf').
  // That route refuses anything else outright, so a non-PDF grant would be
  // permanently unserveable.
  if (attachment.type !== 'application/pdf') {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'Only PDF files can be assigned as homework.',
        code: 'ATTACHMENT_NOT_PDF',
      },
    }
  }

  if (pageStart !== null && pageEnd !== null) {
    const storagePath = `${studySheetId}/${attachment.name}`
    const { data: fileData, error: downloadError } = await adminClient.storage
      .from(BUCKET)
      .download(storagePath)

    if (downloadError || !fileData) {
      console.error(
        `${logPrefix} storage download failed (sheet ${studySheetId}, file ${attachment.name}):`,
        downloadError
      )
      return {
        ok: false,
        status: 422,
        body: {
          error: 'This PDF could not be read, so a page range cannot be assigned for it.',
          code: 'PDF_LOAD_FAILED',
        },
      }
    }

    let pageCount: number
    try {
      const sourcePdf = await PDFDocument.load(new Uint8Array(await fileData.arrayBuffer()))
      pageCount = sourcePdf.getPageCount()
    } catch (loadError) {
      // Unreadable / encrypted source: the file route fails closed on the same
      // load, so never write a grant against it.
      console.error(
        `${logPrefix} PDF load failed (sheet ${studySheetId}, file ${attachment.name}):`,
        loadError
      )
      return {
        ok: false,
        status: 422,
        body: {
          error: 'This PDF could not be read, so a page range cannot be assigned for it.',
          code: 'PDF_LOAD_FAILED',
        },
      }
    }

    // pageEnd >= pageStart is already guaranteed by the schema, so bounding the
    // end bounds the whole range.
    if (pageCount < 1 || pageEnd > pageCount) {
      return {
        ok: false,
        status: 422,
        body: {
          error: `This file has ${pageCount} page${pageCount === 1 ? '' : 's'}, so pages ${pageStart}-${pageEnd} cannot be assigned.`,
          code: 'PAGE_RANGE_UNSATISFIABLE',
        },
      }
    }
  }

  return { ok: true, attachmentName: attachment.name }
}
