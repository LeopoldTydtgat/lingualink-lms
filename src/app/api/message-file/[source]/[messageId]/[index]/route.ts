import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const BUCKET = 'messages'

// Hardcoded prefix every stored attachment URL must carry. The bucket is NEVER taken
// from the stored URL — see the parse guards in the handler.
const SIGN_PREFIX = `/storage/v1/object/sign/${BUCKET}/`

type Attachment = { url: string; filename: string; size: number }

// Content-Type is derived from the object name's extension against this fixed map and
// never from anything the row carries. Mirrors api/messages/upload's ALLOWED_TYPES.
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// api/messages/upload builds the object name as `${Date.now()}-${safeName}`, where
// safeName is sanitised to [a-zA-Z0-9._-]. No slash can survive that, so a name matching
// this pattern can never add a path segment — traversal is impossible.
const OBJECT_NAME_RE = /^[0-9]+-[a-zA-Z0-9._-]+$/

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })
const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 })

// uuids are case-insensitive as identifiers even though Postgres renders them lowercase
// and the upload route always writes a lowercase path, so compare them case-insensitively
// rather than letting a differently-cased planted path skate past the binding check below.
// A null/undefined counterpart never matches.
const sameUuid = (a: string, b: string | null | undefined) =>
  typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// GET /api/message-file/[source]/[messageId]/[index]
//
// NEW298: same-origin auth proxy for message attachments. api/messages/upload bakes a
// 7-day signed URL into the stored attachments JSON and nothing ever re-signs it, so
// every attachment link died a week after it was sent. This route puts the file behind
// our own auth wall and streams the bytes out of the private 'messages' bucket with the
// service-role client, so links no longer expire. Legacy rows whose baked signed URL is
// long dead work through it unchanged — only the path is parsed out of the stored URL,
// never the token.
//
// `source` selects the table: 'message' → messages, 'support' → support_messages.
//
// Unlike api/library-file — which rebuilds the storage path from the row's own filename
// and so never parses the caller's URL — the path here exists ONLY inside the stored
// url: attachments[].filename is the original unsanitised name and the upload timestamp
// is never persisted. The url is sender-influenced (validateAttachments pins the host,
// and as of NEW298 the bucket prefix too, but legacy rows predate that pin), so the
// parse below trusts nothing about its shape: the bucket is hardcoded and both path
// segments must match strict patterns. Authorisation NEVER comes from the parsed path —
// it comes from the row's participants.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ source: string; messageId: string; index: string }> }
) {
  try {
    const { source, messageId, index } = await params

    // Reject an unknown source before any DB read.
    if (source !== 'message' && source !== 'support') {
      return notFound()
    }

    // --- Auth wall ---
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    // Student = a row in `students` keyed by auth_user_id; teacher/admin = a row in
    // `profiles` keyed by id. BOTH are loaded: the identities are not mutually exclusive
    // (a dual-identity account holds both), and the participant check below needs
    // whichever one the row's *_type calls for.
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', user.id)
      .maybeSingle()

    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    // Neither → denied outright, before any message row is loaded, so message existence
    // never leaks to a caller who is neither a student nor a profile.
    if (!profile && !student) {
      return forbidden()
    }

    const isAdmin = profile?.role === 'admin'

    // --- Resolve the row ---
    // Service-role load: the auth gate above already ran, and the download below needs
    // the service role once the bucket is private. RLS is BYPASSED here, so the
    // participant check that follows is the entire authorisation for this route.
    const adminClient = createAdminClient()

    let attachments: Attachment[]
    let allowed: boolean
    // Resolves whether the uploader uuid embedded in a stored path is the row's OWN
    // sender. Built per-source here, while the row is in scope, but deliberately not
    // invoked until after the path parse below, so its extra lookups never run for a
    // request that fails earlier.
    let isUploaderTheSender: (uploaderUuid: string) => Promise<boolean>

    if (source === 'support') {
      const { data: row } = await adminClient
        .from('support_messages')
        .select('id, participant_auth_id, sender_role, sender_auth_id, attachments')
        .eq('id', messageId)
        .maybeSingle()

      if (!row) return notFound()

      // participant_auth_id holds the non-admin participant's AUTH uuid (never a table
      // PK), so it compares against user.id directly. A support thread carries no
      // admin-side column: any admin may read every thread, which is exactly what the
      // admin support console renders.
      allowed = isAdmin || user.id === row.participant_auth_id
      attachments = Array.isArray(row.attachments) ? row.attachments : []

      isUploaderTheSender = async (uploaderUuid: string) => {
        // A 'user' row is always uploaded by the participant themselves — no sender_auth_id
        // is recorded because participant_auth_id already identifies them (api/support/send).
        if (row.sender_role === 'user') {
          return sameUuid(uploaderUuid, row.participant_auth_id)
        }
        if (row.sender_role === 'admin') {
          if (row.sender_auth_id) {
            return sameUuid(uploaderUuid, row.sender_auth_id)
          }
          // A NULL sender_auth_id means the author is unrecoverable FROM THE ROW, whatever
          // produced it — typically a pre-NEW336 admin reply, but nothing in the schema
          // enforces that provenance, so this branch assumes nothing about the row's age.
          // With no author to bind to, accept only the two uuids that could own the object:
          // the thread's participant, or a role='admin' profile. Anything else fails closed
          // — api/support/send keys sender_role on role === 'admin' alone, so no other
          // account can ever author an admin row.
          //
          // The looseness is safe because planting a path means WRITING attachments on an
          // existing row, which no caller can do: the live-DB grant check (15 Jul 2026)
          // confirms authenticated holds INSERT + SELECT only on messages/support_messages
          // and UPDATE on read_at alone, so attachments are immutable after insert and
          // plant-then-read via UPDATE is impossible.
          if (sameUuid(uploaderUuid, row.participant_auth_id)) return true
          const { data: uploader } = await adminClient
            .from('profiles')
            .select('role')
            .eq('id', uploaderUuid)
            .maybeSingle()
          return uploader?.role === 'admin'
        }
        return false
      }
    } else {
      const { data: row } = await adminClient
        .from('messages')
        .select('id, sender_id, sender_type, receiver_id, receiver_type, attachments')
        .eq('id', messageId)
        .maybeSingle()

      if (!row) return notFound()

      // CRITICAL: messages.sender_id / receiver_id are MIXED-identity columns. On a
      // 'teacher' or 'admin' side they hold the AUTH uuid (profiles.id == auth uuid);
      // on a 'student' side they hold the students TABLE PK, because the student send
      // action resolves auth_user_id → students.id before inserting. Type and id must
      // therefore be checked TOGETHER, per side: comparing user.id against a student
      // side would deny every student, and comparing students.id against a teacher side
      // would never match. Any other type value defaults to deny.
      const matchesSide = (sideType: string, sideId: string) => {
        if (sideType === 'teacher' || sideType === 'admin') return sideId === user.id
        if (sideType === 'student') return !!student && sideId === student.id
        return false
      }

      allowed =
        isAdmin ||
        matchesSide(row.sender_type, row.sender_id) ||
        matchesSide(row.receiver_type, row.receiver_id)
      attachments = Array.isArray(row.attachments) ? row.attachments : []

      isUploaderTheSender = async (uploaderUuid: string) => {
        // Same mixed-identity split as matchesSide: a 'teacher'/'admin' sender_id already
        // IS the uploader's auth uuid, so it compares directly.
        if (row.sender_type === 'teacher' || row.sender_type === 'admin') {
          return sameUuid(uploaderUuid, row.sender_id)
        }
        // A 'student' sender_id is the students TABLE PK, so resolve the indirection to the
        // auth uuid the upload route actually keyed the storage path on. A missing students
        // row denies (the caller 404s).
        if (row.sender_type === 'student') {
          const { data: sender } = await adminClient
            .from('students')
            .select('auth_user_id')
            .eq('id', row.sender_id)
            .maybeSingle()
          return sameUuid(uploaderUuid, sender?.auth_user_id)
        }
        return false
      }
    }

    if (!allowed) return forbidden()

    // --- Resolve the attachment ---
    const idx = Number(index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= attachments.length) {
      return notFound()
    }

    const att = attachments[idx]
    if (!att || typeof att.url !== 'string') {
      return notFound()
    }

    // --- Derive the storage path out of the stored url ---
    let parsed: URL
    try {
      parsed = new URL(att.url)
    } catch {
      return notFound()
    }

    // The bucket prefix is hardcoded, not read from the url. This is the guard that
    // stops a hostile stored url from turning the service-role download below into an
    // arbitrary cross-bucket read.
    if (!parsed.pathname.startsWith(SIGN_PREFIX)) {
      return notFound()
    }

    // Exactly two segments: {uploaderUuid}/{objectName}. pathname is never percent-
    // decoded, so an encoded separator stays literal and fails the charset checks below
    // rather than smuggling in a third segment.
    const segments = parsed.pathname.slice(SIGN_PREFIX.length).split('/')
    if (segments.length !== 2) {
      return notFound()
    }

    const [uploaderUuid, objectName] = segments
    if (!UUID_RE.test(uploaderUuid) || !OBJECT_NAME_RE.test(objectName)) {
      return notFound()
    }

    // --- Bind the path to the row's sender ---
    // Being a participant of the row is NOT sufficient on its own. validateAttachments
    // pins the host and the bucket prefix but not the path segments, so a participant can
    // plant a url carrying SOMEONE ELSE's storage path into a message of their own and,
    // without this check, the service-role download below would happily read it back to
    // them. Pre-NEW298 knowing a path was useless (private bucket, signed token required);
    // through this proxy a known path would otherwise become a permanent read primitive.
    // Requiring the path's uploader to be the row's own sender closes that: the only object
    // a row can serve is the one its sender actually uploaded.
    //
    // uploaderUuid is still NEVER treated as proof of the REQUESTER's identity — that was
    // settled from the row's participants above. (For a student-sent attachment it is the
    // student's auth uuid, which by design matches no id on the message row itself.)
    if (!(await isUploaderTheSender(uploaderUuid))) {
      return notFound()
    }

    const storagePath = `${uploaderUuid}/${objectName}`

    // --- Stream the bytes from the private bucket ---
    const { data: fileData, error: downloadError } = await adminClient.storage
      .from(BUCKET)
      .download(storagePath)

    if (downloadError || !fileData) {
      return notFound()
    }

    const arrayBuffer = await fileData.arrayBuffer()

    const dotIdx = objectName.lastIndexOf('.')
    const ext = dotIdx === -1 ? '' : objectName.slice(dotIdx).toLowerCase()
    const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream'

    // att.filename is the ORIGINAL unsanitised name (the upload route sanitises only the
    // storage path), so strip it down before it reaches the header — quotes and CRLF
    // must never survive into Content-Disposition. Fall back to the object name if
    // nothing is left.
    const rawName = typeof att.filename === 'string' ? att.filename : ''
    const safeFilename = rawName.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 100) || objectName

    // The ASCII filename= above stays exactly as it is — it is the injection guard. But
    // stripping to [a-zA-Z0-9 ._-] collapses a non-ASCII name to a bare extension (a
    // Japanese homework file named 宿題.pdf downloaded as ".pdf"), so when the stored name
    // carries anything outside that set, additionally emit RFC 5987's filename*, which
    // carries the real name percent-encoded. Clients that understand it prefer it; those
    // that don't fall back to filename=. Percent-encoding covers CR/LF and quotes, so the
    // extended parameter cannot break out of the header either.
    let disposition = `inline; filename="${safeFilename}"`
    if (rawName !== '' && rawName !== rawName.replace(/[^a-zA-Z0-9 ._-]/g, '')) {
      try {
        // Slice by code point, not UTF-16 unit, so a 100-char cut can't split a surrogate
        // pair and hand encodeURIComponent a lone surrogate (which throws).
        const truncated = Array.from(rawName).slice(0, 100).join('')
        // encodeURIComponent leaves ' ( ) * unescaped and RFC 5987's value-chars permits
        // none of them; a bare apostrophe matters most, since it is the parameter's own
        // delimiter ("John's notes.pdf" would otherwise emit one mid-value).
        const encoded = encodeURIComponent(truncated)
          .replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        disposition += `; filename*=UTF-8''${encoded}`
      } catch {
        // Lone surrogate in a malformed stored name: keep the ASCII parameter alone rather
        // than failing the whole download.
      }
    }

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Cache-Control': 'private, max-age=0, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    // Never leak storage paths or internal detail in the error body.
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
