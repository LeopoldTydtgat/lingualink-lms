/**
 * NEW298: build the href for a message attachment link.
 *
 * api/messages/upload bakes a 7-day signed URL into the stored attachments JSON and
 * nothing ever re-signs it, so attachments[].url dies a week after the message was sent.
 * Real rows are therefore linked through the same-origin auth proxy at
 * /api/message-file/[source]/[messageId]/[index], which re-derives the storage path from
 * the stored url and streams the bytes after checking the requester is a participant.
 * Legacy rows whose baked url expired long ago resolve through it unchanged.
 *
 * An optimistic row is the one exception: `pending` marks a client-side temp row whose id
 * is a crypto.randomUUID() with no DB row behind it, so the proxy would 404 on it. Its
 * signed url is only minutes old, so keep using it until the temp-to-real swap lands.
 * Callers whose row type has no `pending` field simply omit the argument.
 */
export function messageAttachmentHref(
  source: 'message' | 'support',
  messageId: string,
  index: number,
  attachmentUrl: string,
  pending?: boolean,
): string {
  if (pending) return attachmentUrl
  return `/api/message-file/${source}/${messageId}/${index}`
}
