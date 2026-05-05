// Magic-byte sniffing for upload routes (M-22).
//
// File.type is whatever the browser claims, which means a malicious client can
// rename `evil.exe` to `evil.pdf` and the MIME header will say PDF. We re-check
// the first bytes of the buffer against the real on-disk signature for each
// MIME we accept. Anything that doesn't line up is rejected.
//
// Signatures cover the formats currently accepted by upload routes: PDF, PNG,
// JPEG, WEBP, GIF, plus the legacy + modern Office formats. Extend as needed.

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false
  }
  return true
}

function asciiAt(buf: Buffer, offset: number, str: string): boolean {
  if (buf.length < offset + str.length) return false
  for (let i = 0; i < str.length; i++) {
    if (buf[offset + i] !== str.charCodeAt(i)) return false
  }
  return true
}

// Maps each accepted MIME to a predicate that runs against the leading bytes.
const MAGIC_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  // PDF: literal "%PDF-"
  'application/pdf': (buf) => asciiAt(buf, 0, '%PDF-'),

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  'image/png': (buf) => startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),

  // JPEG: FF D8 FF
  'image/jpeg': (buf) => startsWith(buf, [0xff, 0xd8, 0xff]),

  // WEBP: "RIFF" .... "WEBP"
  'image/webp': (buf) => asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WEBP'),

  // GIF: "GIF87a" or "GIF89a"
  'image/gif': (buf) => asciiAt(buf, 0, 'GIF87a') || asciiAt(buf, 0, 'GIF89a'),

  // Modern Office formats are zip containers — leading "PK\x03\x04" or "PK\x05\x06"
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (buf) =>
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (buf) =>
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]),

  // Legacy DOC/PPT — OLE compound document: D0 CF 11 E0 A1 B1 1A E1
  'application/msword': (buf) =>
    startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  'application/vnd.ms-powerpoint': (buf) =>
    startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
}

// Returns true if the first bytes of `buf` match the expected signature for
// the claimed MIME. Returns true (passes) for MIMEs we don't have a signature
// for — caller must keep its own MIME allowlist as the gate.
export function magicMatchesMime(buf: Buffer, claimedMime: string): boolean {
  const check = MAGIC_CHECKS[claimedMime]
  if (!check) return true
  return check(buf)
}
