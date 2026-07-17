# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session start (do this first, every session)

1. Read this file, the nested CLAUDE.md for any path you'll touch, and the project KB.
2. Verify repo ground truth before trusting any handover/brief claim about state:
   `git fetch origin && git log origin/main..origin/dev --oneline`
3. If the brief and git disagree about what's merged/committed, STOP and reconcile
   with Leopold before doing any work. Handover claims about repo state are unverified
   until git confirms them.

## Commands

```bash
npm run dev       # Start development server (4GB Node memory allocated)
npm run build     # Production build
npm run lint      # Run ESLint
npm test          # Run tests (vitest run)
```

The Claude Code Stop hook runs `tsc --noEmit` and blocks turn-end on type errors; tests live at `src/**/*.test.ts` (Vitest).

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

### Supabase DDL workflow

Every `CREATE TABLE` in the Supabase SQL editor **must** be followed by explicit GRANT statements:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO service_role;
-- anon only if public read is intended
```

Without explicit GRANTs, PostgREST returns `42501` permission-denied errors. Existing tables keep their current grants; this applies to every new table created after Oct 30, 2026 on existing projects.

- EXCEPTION - public.activities: authenticated holds a COLUMN-LEVEL SELECT grant that deliberately excludes answer_key, and no write grants. This is the enforcement mechanism keeping answer keys out of PostgREST (verified 15 Jul 2026). Never "fix" it to a full table grant.

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
NEXT_PUBLIC_TEACHER_URL
NEXT_PUBLIC_STUDENT_URL
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
- **Never guess schema, columns, or existing code.** Read the actual file or query the actual Supabase schema. "Should work" is forbidden.
- **One fix must never cause another problem.** Before editing, list downstream consumers. No ripple bugs.
- **Audit before fix.** When fixing a bug, first grep for the same pattern elsewhere in the codebase.
- **A clean build/diff is NOT proof of correctness.** Read changed files in full, top to bottom.
- **DDL and RLS policies via the Supabase SQL editor only** — never executed from Claude Code. Draft SQL for Leopold to run.
- **`select('*')` is banned on any table with column-level REVOKEs** — use explicit column lists.
- **`students.admin_notes`, `teachers.admin_notes`, `students.cancellation_policy`, follow-up fields: NEVER returned under teacher/student roles.**
- **All hours/billing mutations go through the atomic RPC** — never a raw UPDATE.
- **`auth.admin.*` calls receive the `auth.users` UUID:** `students.auth_user_id` (indirection) for students, `profiles.id` for profiles. Never a table PK.
- **Pair `auth.admin.updateUserById` with `auth.admin.signOut(id, 'global')`.** `status` ('current'/'former'/'on_hold') is the canonical active-account gate.
- **`.single()` throws on no-row; use `.maybeSingle()`** where zero rows are possible.
- **Fail-safe fallbacks: action-prompting UI defaults to the prompting state on null** (`?? false` to show a banner, not `?? true`).
- **Every factual claim about code, schema, or state must cite its source: file:line read this session, or actual tool/command output. Uncited claims must be prefixed `UNVERIFIED:`. 'I have not read X — paste it' is a correct, acceptable answer. Never fabricate to fill a gap.**
- **Before editing any file, OUTPUT the grep'd list of downstream consumers and, for each, state why it is unaffected. Do not merely assert consumers were considered — show the list.**
- **Never trust a tool's on-screen rendering of file contents — verify against the file on disk.** Edit-tool diffs and terminal echoes can drop, scramble, or merge characters (and can render clean UTF-8 as mojibake). After any edit, and before any commit, read the real bytes from disk (PowerShell `Get-Content -Raw`, or a byte/char-code dump for line-ending-sensitive files) and confirm the actual content. A passing `tsc`/test plus a clean-looking diff is not enough — confirm the file itself.
- **NEVER run any git command** — no add, commit, push, log, status, nothing. Git is run exclusively by Leopold in PowerShell. Never add `Co-Authored-By` trailers to anything.
- **NEVER read or write `C:\Projects\lingualink-lms-meta\BUG_LOG.md`** — it is outside this repo and maintained via PowerShell only.
- **`DROP FUNCTION` + `CREATE` resets Postgres EXECUTE grants** — any drafted RPC SQL must explicitly re-REVOKE from `anon`/`authenticated` where the old function had revokes.
- **Join Class button activates 10 minutes before class start** — not 15. The briefs say 15; 10 is authoritative.

## Output style

Terse. Show diffs, file paths, and results only. No narration, no preamble, no plans, no summaries of what you're about to do or just did. Answer questions in as few words as correctness allows.

## Known issues (as of April 2026)

- Admin portal pages may timeout on Vercel Hobby plan (10 s limit) — a Pro upgrade is planned.
- Several pages (`billing`, `messages`, `reports`, `schedule`) still have a false `if (!profile) redirect('/login')` guard that should be removed — profile null does not mean the user is unauthenticated.

## Verification subagents (opt-in only — NEVER auto-invoke)

Never spawn a subagent or use the Task tool unless the driving prompt for the task explicitly requests one. This includes code-reviewer, supabase-rls-auditor, and timezone-date-auditor. Subagent gates apply to auth, RLS, money/billing paths, schema changes, and core calendar/timezone math (shared date functions, booking gate, slot engine) — and run only when the driving prompt requests them by name. Routine fixes get none. Token budget matters.
