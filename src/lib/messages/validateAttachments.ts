type SafeAttachment = { url: string; filename: string; size: number }

/**
 * Validate an untrusted attachments payload shared by every message send path
 * (main teacher/student messaging + support messaging). Pins each attachment URL
 * to the Supabase project host so a caller can't plant a link to an arbitrary
 * domain (phishing) in the persisted thread, and strips any extra keys so only
 * { url, filename, size } is ever persisted.
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
    let attHost: string
    try {
      attHost = new URL(att.url).host
    } catch {
      return { ok: false }
    }
    if (attHost !== supabaseHost) {
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
