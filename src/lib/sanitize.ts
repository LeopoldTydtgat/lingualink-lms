import DOMPurify from 'dompurify'

// Browser-side HTML sanitiser for rendering stored message content.
//
// Plain dompurify, deliberately NOT isomorphic-dompurify: the isomorphic
// wrapper loads jsdom on the server, and that chain throws during SSR on
// Vercel (require() of an ES-only module). Nothing here may touch a DOM
// outside the browser.
//
// Without a real window, dompurify's factory returns early: isSupported is
// false and sanitize/addHook are never defined. So the hook is installed
// lazily on the first browser call, and an unsupported environment returns
// '' - never the input, which dompurify would otherwise pass through
// unsanitised.
//
// Every write path already sanitises with src/lib/sanitize-server.ts
// (sanitize-html). This is the second layer at render time, and it mirrors
// that allowlist so cleaned content is identical whichever side cleaned it.
// Render sites go through <SafeHtml> (src/components/SafeHtml.tsx), which
// only calls this after mount.

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li',
  'a',
  'blockquote', 'code', 'pre',
  'h1', 'h2', 'h3',
]

const ALLOWED_ATTR = ['href', 'target', 'rel']

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form']

const FORBID_ATTR = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'srcdoc']

let hookInstalled = false

function installLinkHook(): void {
  if (hookInstalled) return
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
  hookInstalled = true
}

export function sanitizeHtml(input: string | null | undefined): string {
  if (input == null) return ''
  // Fail closed: no DOM means no sanitising, so render nothing.
  if (!DOMPurify.isSupported) return ''
  installLinkHook()
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}
