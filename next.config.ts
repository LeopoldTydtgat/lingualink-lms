import type { NextConfig } from 'next'

// ── Derive Supabase hostname for CSP ─────────────────────────────────────────
// Falls back to wildcard if the env var isn't available at config load time.
const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? (() => {
      try {
        return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
      } catch {
        return '*.supabase.co'
      }
    })()
  : '*.supabase.co'

// ── Security headers applied to every response ───────────────────────────────
//
// CSP notes:
//   script-src  — 'unsafe-inline' is required by Next.js App Router for its
//                 hydration scripts (__NEXT_DATA__ etc.). Removing it breaks
//                 the app. This is a known Next.js limitation; nonce-based CSP
//                 can replace it in a future hardening pass.
//   style-src   — 'unsafe-inline' is required because the portals use inline
//                 style props extensively (Tailwind v4 dynamic colour rule).
//   connect-src — Supabase REST + Realtime (wss), MS Graph, Microsoft login.
//
// AWS migration note: update connect-src and img-src with CloudFront/S3 domains.

const securityHeaders = [
  // Prevent the page from being embedded in an iframe on another origin
  {
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN',
  },
  // Stop browsers from MIME-sniffing the content type
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  // Control how much referrer info is sent with requests
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  // Force HTTPS for 2 years once the site is live (preload-ready)
  // Safe to include now — Vercel serves everything over HTTPS already
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Disable browser features the app doesn't need
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  // Content Security Policy
  {
    key: 'Content-Security-Policy',
    value: [
      // Default: only same origin
      "default-src 'self'",
      // Scripts: self + inline required by Next.js hydration
      "script-src 'self' 'unsafe-inline'",
      // Styles: self + inline (inline style props used throughout) + Google Fonts
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      // Fonts: self + Google Fonts CDN
      "font-src 'self' https://fonts.gstatic.com",
      // Images: self + data URIs (avatars/placeholders) + Supabase Storage
      `img-src 'self' data: blob: https://${supabaseHost}`,
      // Connections: self + Supabase REST & Realtime + MS Graph + Microsoft login
      `connect-src 'self' https://${supabaseHost} wss://${supabaseHost} https://graph.microsoft.com https://login.microsoftonline.com`,
      // No plugins (Flash etc.)
      "object-src 'none'",
      // Forms must post to same origin only
      "form-action 'self'",
      // Prevent this page being framed by other origins (belt and braces with X-Frame-Options)
      "frame-ancestors 'self'",
      // Only load workers from same origin
      "worker-src 'self' blob:",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply to every route
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
