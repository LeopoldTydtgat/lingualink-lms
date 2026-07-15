type SafeAttachment = { url: string; filename: string; size: number }

// NEW298: every legitimate attachment url is a signed url for the private 'messages'
// bucket, produced by api/messages/upload — the only upload path all three send routes
// use. Pinning this prefix keeps a stored url from addressing any other bucket.
const MESSAGES_SIGN_PREFIX = '/storage/v1/object/sign/messages/'

/**
 * Validate an untrusted attachments payload shared by every message send path
 * (main teacher/student messaging + support messaging). Pins each attachment URL
 * to the Supabase project host so a caller can't plant a link to an arbitrary
 * domain (phishing) in the persisted thread, pins its path to the 'messages'
 * bucket's sign prefix (NEW298 — api/message-file parses the storage path back out
 * of this stored url and downloads it with the service-role client, so a url aimed
 * at another bucket on the same host would otherwise make that proxy an arbitrary
 * cross-bucket read), and strips any extra keys so only { url, filename, size } is
 * ever persisted.
 *
 * Returns ok:true with a stripped array (empty for undefined/null input) or
 * ok:false when the payload violates any rule. Pure — no I/O, no throwing.
 */
export function validateAttachments(
  attachments: unknown
): { ok: true; attachments: SafeAttachment[] } | { ok: false } {
  if (attachments === undefined || attachments === null) {
    return { ok: true, attachments: [] }
  }

  if (!Array.isArray(attachments) || attachments.length > 5) {
    return { ok: false }
  }

  const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host
  const safeAttachments: SafeAttachment[] = []

  for (const att of attachments) {
    if (
      !att || typeof att !== 'object' ||
      typeof att.url !== 'string' || !att.url.startsWith('https://') ||
      typeof att.filename !== 'string' || att.filename.length === 0 || att.filename.length > 255 ||
      typeof att.size !== 'number' || !Number.isFinite(att.size) || att.size < 0 || att.size > 10485760
    ) {
      return { ok: false }
    }
    // Wrap the parse so a malformed URL also fails rather than throwing.
    let parsed: URL
    try {
      parsed = new URL(att.url)
    } catch {
      return { ok: false }
    }
    if (parsed.host !== supabaseHost) {
      return { ok: false }
    }
    // NEW298: host alone is not enough — pin the bucket path too. This tightens NEW
    // writes only; rows stored before this pin are handled by api/message-file's own
    // parse guards, which hardcode the same prefix rather than trusting the stored url.
    if (!parsed.pathname.startsWith(MESSAGES_SIGN_PREFIX)) {
      return { ok: false }
    }
    safeAttachments.push({
      url: att.url,
      filename: att.filename,
      size: att.size,
    })
  }

  return { ok: true, attachments: safeAttachments }
}
