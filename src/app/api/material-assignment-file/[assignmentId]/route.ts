import { NextResponse } from 'next/server'
import { PDFDocument, PDFFont, StandardFonts, degrees, rgb } from 'pdf-lib'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const BUCKET = 'library-files'

type Attachment = {
  name: string
  url: string
  type: string
}

// GET /api/material-assignment-file/[assignmentId]
//
// Serves the bytes of a library PDF that a teacher assigned to a student as
// teaching-material homework.
//
// THIS ROUTE REBUILDS THE PDF ON EVERY REQUEST. It never streams the stored
// file: it loads the source document, copies ONLY the granted page range into a
// brand-new PDFDocument, stamps that document with the student's name, and
// streams the result. The browser therefore NEVER receives ungranted pages and
// NEVER receives clean bytes - the enforcement is byte-level, not UI-level, so
// "view source / save as" cannot recover the pages outside the grant or an
// unwatermarked copy. Nothing is cached for the same reason: the page range and
// the watermark are per-request, per-grant, per-student.
//
// AUTHORISATION MODEL - the whole gate is a single user-scoped, RLS-governed
// SELECT on material_assignments:
//   - The check runs on the USER-SCOPED client (createClient), so the
//     material_assignments SELECT policies govern it: a student sees only their
//     OWN LIVE (revoked_at is null) row, a teacher only rows for students they
//     teach via trainings, an admin all rows. The row's existence IS the grant.
//   - No ownership / revocation / teaching-relationship logic is re-derived in
//     code, so this route can never disagree with the live RLS policy. NEVER
//     move this check onto the admin/service-role client: that bypasses RLS and
//     the entire gate.
//   - The service-role admin client is used ONLY after access is granted, purely
//     to read sheet metadata, download the bytes from the private bucket, and
//     read the student's name for the watermark.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assignmentId: string }> }
) {
  let assignmentId = ''
  try {
    ;({ assignmentId } = await params)

    // --- Auth wall: the caller must be logged in. ---
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // --- THE GATE (sole authorization) ---
    // User-scoped read: RLS decides. A missing row means "no such assignment /
    // not this caller's student / revoked" - all indistinguishable and all
    // denied with the same generic 404, so nothing about the grant leaks.
    //
    // EXPLICIT COLUMN LIST, never select('*'): material_assignments carries a
    // column-level UPDATE grant (annotations, updated_at only), and the project
    // rule is explicit columns on any table with column-level grants.
    //
    // revoked_at is read as part of the grant record but deliberately NOT
    // re-checked here: the student SELECT policy already encodes
    // `revoked_at is null`, so a student can never reach a revoked row, while
    // teachers and admins legitimately keep read access to a revoked grant.
    // Re-deriving the check in code would silently narrow their policy.
    const { data: assignment, error: assignmentError } = await supabase
      .from('material_assignments')
      .select('id, student_id, study_sheet_id, attachment_index, attachment_name, page_start, page_end, revoked_at')
      .eq('id', assignmentId)
      .maybeSingle()

    if (assignmentError) {
      console.error(`[material-assignment-file] material_assignments lookup failed (assignment ${assignmentId}):`, assignmentError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }
    if (!assignment) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // --- Access granted: resolve the attachment and download the bytes ---
    // Service-role is used ONLY from here down, after the RLS gate above.
    const adminClient = createAdminClient()

    const { data: sheet, error: sheetError } = await adminClient
      .from('study_sheets')
      .select('is_active, attachments')
      .eq('id', assignment.study_sheet_id)
      .maybeSingle()

    if (sheetError) {
      console.error(`[material-assignment-file] study_sheets lookup failed (assignment ${assignmentId}):`, sheetError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }
    if (!sheet || sheet.is_active !== true) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const attachments: Attachment[] = Array.isArray(sheet.attachments) ? sheet.attachments : []

    // Resolve WHICH attachment to serve - NAME-FIRST, mirroring
    // /api/lesson-annotation-file. attachment_name (recorded at assignment time
    // alongside the positional index) is the stable key: match it against the
    // sheet's CURRENT attachments so an admin reorder/removal can't shift the
    // grant onto a different same-sheet PDF. If the assigned file was since
    // removed or renamed, find() returns undefined and the validation below
    // denies with 404 - we NEVER fall back to position when a name is present.
    // attachment_name is NOT NULL on this table, so the positional fallback is
    // unreachable today; it is kept only to mirror the lesson route exactly.
    const attachment =
      typeof assignment.attachment_name === 'string' && assignment.attachment_name.length > 0
        ? attachments.find((a) => a && a.name === assignment.attachment_name)
        : attachments[assignment.attachment_index]

    // Re-validate the filename at this boundary (mirrors /api/library-file and
    // /api/lesson-annotation-file): the admin library create/PATCH routes write
    // the attachments array verbatim, so a hostile or malformed name could
    // otherwise reach the storage path ('../' traversal). Every real upload
    // already matches this charset, so the check rejects nothing legitimate.
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(attachment.name)
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Page extraction and watermarking are only meaningful for PDFs, and this
    // route's entire security contract depends on them. Anything that is not a
    // PDF is refused outright rather than passed through unprocessed.
    if (attachment.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Build the storage path the same way the upload route does: {sheetId}/{name}.
    const storagePath = `${assignment.study_sheet_id}/${attachment.name}`

    const { data: fileData, error: downloadError } = await adminClient.storage
      .from(BUCKET)
      .download(storagePath)

    if (downloadError || !fileData) {
      console.error(`[material-assignment-file] storage download failed (assignment ${assignmentId}):`, downloadError)
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const sourceBytes = new Uint8Array(await fileData.arrayBuffer())

    // --- Byte-level enforcement: rebuild the document ---
    let sourcePdf: PDFDocument
    try {
      sourcePdf = await PDFDocument.load(sourceBytes)
    } catch (loadError) {
      // Unreadable / encrypted source. Fail closed - never fall through to
      // streaming the original bytes.
      console.error(`[material-assignment-file] PDF load failed (assignment ${assignmentId}):`, loadError)
      return NextResponse.json({ error: 'Something went wrong', code: 'PDF_LOAD_FAILED' }, { status: 500 })
    }

    const pageCount = sourcePdf.getPageCount()

    // Resolve the granted range against the REAL document. page_start / page_end
    // are 1-based inclusive; both null means the whole document. Anything that
    // does not fit the real document is unsatisfiable - 422, and we NEVER fall
    // back to serving the whole document, because the stored range is the grant
    // and a broader fallback would hand over ungranted pages.
    const rawStart = assignment.page_start
    const rawEnd = assignment.page_end
    let startPage: number
    let endPage: number

    if (pageCount < 1) {
      console.error(`[material-assignment-file] source PDF has no pages (assignment ${assignmentId})`)
      return NextResponse.json({ error: 'Unprocessable', code: 'PAGE_RANGE_UNSATISFIABLE' }, { status: 422 })
    }

    if (rawStart === null && rawEnd === null) {
      startPage = 1
      endPage = pageCount
    } else if (
      typeof rawStart !== 'number' ||
      typeof rawEnd !== 'number' ||
      !Number.isInteger(rawStart) ||
      !Number.isInteger(rawEnd) ||
      rawStart < 1 ||
      rawEnd < rawStart ||
      rawStart > pageCount ||
      rawEnd > pageCount
    ) {
      // Covers a half-null range (forbidden by the table's CHECK constraint but
      // handled defensively) and a range that outruns the current file - e.g.
      // the PDF was replaced with a shorter one after the grant was written.
      console.error(
        `[material-assignment-file] page range unsatisfiable (assignment ${assignmentId}): ` +
        `start=${String(rawStart)} end=${String(rawEnd)} pageCount=${pageCount}`
      )
      return NextResponse.json({ error: 'Unprocessable', code: 'PAGE_RANGE_UNSATISFIABLE' }, { status: 422 })
    } else {
      startPage = rawStart
      endPage = rawEnd
    }

    // PAGE INDEX DIVERGENCE - the locked deviation from the lesson-annotation
    // pattern, flagged everywhere page indices appear in this feature:
    //   served page 0 corresponds to REAL document page (startPage - 1).
    // Annotation pageIndex values on the homework layer (material_assignments
    // .annotations) use REAL document page indices, NOT served indices, so the
    // client editor must ADD (startPage - 1) when writing an annotation, and
    // teacher playback must SUBTRACT (startPage - 1) when reading one back onto
    // the same served slice. Never store a served index on the homework layer.
    const sourceIndices = Array.from(
      { length: endPage - startPage + 1 },
      (_, i) => (startPage - 1) + i
    )

    // A FRESH document holding ONLY the granted pages. The ungranted pages are
    // never written into the response body at all.
    const outPdf = await PDFDocument.create()
    const copiedPages = await outPdf.copyPages(sourcePdf, sourceIndices)
    copiedPages.forEach((page) => outPdf.addPage(page))

    // --- Watermark: the student's name, on every page ---
    // Read on the service-role client. A lookup failure or a missing row is
    // fail-closed: we return 500 rather than serve an unwatermarked document.
    const { data: student, error: studentError } = await adminClient
      .from('students')
      .select('full_name')
      .eq('id', assignment.student_id)
      .maybeSingle()

    if (studentError || !student) {
      console.error(`[material-assignment-file] students lookup failed (assignment ${assignmentId}):`, studentError)
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    }

    const font = await outPdf.embedFont(StandardFonts.Helvetica)
    const label = watermarkLabel(font, student.full_name, assignment.student_id)

    for (const page of outPdf.getPages()) {
      const { width, height } = page.getSize()

      // Scale the text to ~70% of the page diagonal, since it runs corner to
      // corner at 45 degrees. Width is linear in font size, so one measurement
      // at size 1 gives the per-unit width.
      const unitWidth = font.widthOfTextAtSize(label, 1)
      const maxSize = Math.min(width, height) * 0.18
      const size = Math.max(12, Math.min(maxSize, (Math.hypot(width, height) * 0.7) / unitWidth))
      const textWidth = unitWidth * size

      // drawText anchors at the baseline start and rotates about that anchor, so
      // walk back half the text along the 45-degree run, then drop half a cap
      // height along the perpendicular to centre the glyph body on the page.
      const cos = Math.SQRT1_2
      const sin = Math.SQRT1_2
      const cx = width / 2
      const cy = height / 2

      page.drawText(label, {
        x: cx - (textWidth / 2) * cos + 0.35 * size * sin,
        y: cy - (textWidth / 2) * sin - 0.35 * size * cos,
        size,
        font,
        // Grey at low opacity: unmistakably present on every page, but light
        // enough that the material underneath stays readable.
        color: rgb(0.45, 0.45, 0.45),
        opacity: 0.18,
        rotate: degrees(45),
      })
    }

    const outBytes = await outPdf.save()

    // Copy into a plain, exactly-sized ArrayBuffer: pdf-lib returns
    // Uint8Array<ArrayBufferLike>, which is not a valid BodyInit under this
    // project's TS lib, and casting would paper over a real shape difference.
    const body = new ArrayBuffer(outBytes.byteLength)
    new Uint8Array(body).set(outBytes)

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // Inline, with NO filename hint: the response is a per-request derived
        // slice, not the stored library file, and must not present itself as a
        // downloadable copy of it.
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=0, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    // Never leak storage paths or internal detail in the error body.
    console.error(`[material-assignment-file] unhandled failure (assignment ${assignmentId}):`, err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}

// Build a watermark string the embedded standard font can actually draw.
//
// StandardFonts.Helvetica is WinAnsi-encoded and pdf-lib THROWS on any character
// outside that set - verified: `WinAnsi cannot encode "山" (0x5c71)`. Student
// names here are routinely Japanese, so drawing the raw name would throw and
// take the whole route down. Filter character by character against the real
// embedded font (authoritative, no charset guessing), and if nothing survives,
// fall back to a short ASCII student identifier so a watermark is ALWAYS drawn.
// This function never returns an empty string - unwatermarked bytes must never
// leave this route.
function watermarkLabel(font: PDFFont, fullName: string | null, studentId: string): string {
  const raw = typeof fullName === 'string' ? fullName : ''
  let encodable = ''
  for (const ch of raw) {
    try {
      font.widthOfTextAtSize(ch, 12)
      encodable += ch
    } catch {
      // Character is outside the standard font's encoding - drop it.
    }
  }

  const cleaned = encodable.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : `Student ${studentId.slice(0, 8)}`
}
