import sanitizeHtmlLib from 'sanitize-html'

// Server-side HTML sanitiser. Uses sanitize-html (htmlparser2-based, no jsdom)
// so it runs reliably on Vercel's serverless runtime. Mirrors the allowlist of
// the isomorphic-dompurify version in src/lib/sanitize.ts so saved content is
// identical regardless of which sanitiser cleaned it.

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li',
  'a',
  'blockquote', 'code', 'pre',
  'h1', 'h2', 'h3',
]

export function sanitizeHtml(input: string | null | undefined): string {
  if (input == null) return ''
  return sanitizeHtmlLib(input, {
    allowedTags: ALLOWED_TAGS,
    // Only <a> keeps attributes; href plus the forced target/rel below.
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
    },
    // Restrict <a href> to safe protocols; blocks javascript: URLs.
    allowedSchemes: ['http', 'https', 'mailto'],
    // Force every link to open in a new tab with a safe rel.
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform('a', {
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
    },
    // Drop the entire contents of these tags, not just the tag itself.
    nonTextTags: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'noscript'],
  })
}
