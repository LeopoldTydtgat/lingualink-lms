# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start development server (4GB Node memory allocated)
npm run build     # Production build
npm run lint      # Run ESLint
```

There are no automated tests. Verification is done manually via the browser.

## Architecture

LinguaLink LMS is a Next.js App Router application with Supabase (PostgreSQL + Realtime) as the backend. It is a multi-role portal for three user types: **admin**, **teacher (dashboard)**, and **student**.

### Route groups and roles

The `src/app/` directory uses route groups to segment access by role:

| Group | Path prefix | Role |
|---|---|---|
| `(auth)` | `/login` | Teacher login |
| `(student-auth)` | `/student/login` | Student login |
| `(admin)` | `/admin/...` | Admin-only pages |
| `(dashboard)` | `/upcoming-classes`, `/schedule`, etc. | Teacher pages |
| `(student)` | `/student/...` | Student pages |

Each protected group's `layout.tsx` handles auth checks. API routes under `src/app/api/` mirror this structure (`/api/admin/...`, `/api/student/...`).

### Supabase client pattern

Three clients exist — use the right one for the context:

- `src/lib/supabase/client.ts` — Browser client (anon key, subject to RLS). Use in client components.
- `src/lib/supabase/server.ts` — Server client (anon key + SSR cookie refresh). Use in Server Components and Route Handlers for authenticated users.
- `src/lib/supabase/admin.ts` — Service-role client (bypasses RLS entirely). Use only in server-side admin operations. Never expose to the browser.

### Auth middleware

`src/proxy.ts` runs on every request and calls `supabase.auth.getUser()` to refresh session tokens. This is critical on Vercel where serverless cold starts would otherwise expire tokens.

**Important:** All `<Link>` components use `prefetch={false}` throughout the app. This is intentional — Next.js prefetching causes race conditions with Supabase's single-use refresh tokens on Vercel.

### Input validation

Zod 4 schemas live in `src/lib/validation/schemas.ts`. All API routes that mutate data must validate input through these schemas before touching the database.

### Security patterns in place

- Row-Level Security (RLS) on all 26 Supabase tables; column-level REVOKE on sensitive fields (`hourly_rate`, `admin_notes`, `cancellation_policy`)
- `SUPABASE_SERVICE_ROLE_KEY` is server-only; never reference it in client code
- `is_admin()` DB function checks both `role='admin'` and `account_types` array
- In-memory rate limiter at `src/lib/rate-limit.ts` — 5 failed attempts per IP within 15 minutes triggers a 15-minute lockout
- CSP headers configured in `next.config.ts`; Supabase hostname is derived dynamically from `NEXT_PUBLIC_SUPABASE_URL`

### Cron jobs

Two Vercel cron jobs run daily at 08:00 UTC (configured in `vercel.json`):
- `GET /api/cron/class-reminders`
- `GET /api/cron/low-hours-warning`

Both require the `CRON_SECRET` env var for authentication.

### External integrations

- **Resend** — Email (singleton in `src/lib/email/client.ts`)
- **Microsoft Graph / Azure Entra ID** — OAuth and calendar (`src/lib/microsoft/graph.ts`)
- **Sentry** — Error tracking via `@sentry/nextjs`
- **FullCalendar** — Scheduling UI in calendar pages
- **TipTap** — Rich text editor for study sheets / reports

### Environment variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_APP_URL
RESEND_API_KEY
CRON_SECRET
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
SENTRY_DSN
```

## Critical Rules — Never Break

- **Never create `middleware.ts`** — this project uses `src/proxy.ts` instead. Both cannot coexist in Next.js 16.
- **Never use `toISOString()` for local date construction** anywhere in the project.
- **Never wrap `createClient` in React's `cache()`** — it crashes all server components.
- **Null profile from a DB query must never trigger a redirect to `/login`** — handle with fallback UI or defaults instead.
- **All state-dependent colours must use inline `style` props** — Tailwind v4 does not apply dynamically constructed colour classes.
- **Never use shadcn `Tabs`** — it does not style correctly with Tailwind v4. Always use manual tab implementations.
- **Supabase nested join results must always be flattened with `Array.isArray()` checks.**
- **Never use `toLocaleTimeString()`** in components that render on both server and client.
- **All `<Link>` components must use `prefetch={false}`.**
- **Always use `createAdminClient()` from `src/lib/supabase/admin.ts`** in admin server components.
- **Full file replacements only — never partial edits.**

## Known issues (as of April 2026)

- Admin portal pages may timeout on Vercel Hobby plan (10 s limit) — a Pro upgrade is planned.
- Several pages (`billing`, `messages`, `reports`, `schedule`) still have a false `if (!profile) redirect('/login')` guard that should be removed — profile null does not mean the user is unauthenticated.
