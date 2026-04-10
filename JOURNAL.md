# LinguaLink Online - Build Journal

## Session 42 - 10 April 2026 — Vercel 404 Fix

### What was built
- Diagnosed and resolved Vercel production 404 error affecting all routes (root, /login, /student/login)
- Merged dev branch into main to sync latest commits (ClassReminderModal, root redirect)

### Break/Fix Log

**Issue 1**
- **Symptom:** All routes on lingualink-lms.vercel.app returned 404 NOT_FOUND. Vercel logs showed "Middleware: 404 Not Found" even though no middleware file existed. Build logs showed all routes compiled successfully.
- **Cause:** Vercel Framework Preset was set to "Other" instead of "Next.js". Without the correct preset, Vercel did not know how to serve the Next.js build output, so every route returned 404 despite a successful build.
- **Fix:** Changed Framework Preset from "Other" to "Next.js" in Vercel → Settings → Build and Deployment, then redeployed without build cache.
- **Lesson:** Always verify the Vercel Framework Preset matches the actual framework. A successful build does not guarantee correct serving — Vercel needs the preset to know how to route requests to the build output.

**Issue 2**
- **Symptom:** Latest code changes (root redirect, ClassReminderModal) were not on the production deployment.
- **Cause:** Commits were on the dev branch but had not been merged into main. Vercel deploys from main.
- **Fix:** Ran `git checkout main && git merge dev && git push origin main`.
- **Lesson:** Always merge dev into main before expecting changes on production.

### Session result
Short diagnostic session focused on resolving the Vercel 404 that was blocking all access to the live deployment. Root cause was the Framework Preset misconfiguration - likely set incorrectly during initial Vercel project setup. Both the teacher portal (/login) and student portal (/student/login) now load correctly on the production URL. No code changes were needed.

---

## Session 41 - 10 April 2026 - Step 14 Hardening Pass (Items 1–8)

### What was built

- **Item 1 (carried over):** Fixed all TypeScript errors across 8 files, removed `ignoreBuildErrors` and ESLint suppression flags from `next.config.ts`. Clean `tsc --noEmit` and clean `npx next build` achieved.
- **Item 2 - Server-side input validation:** Created `src/lib/validation/schemas.ts` using Zod 4 with schemas for `CreateTeacherSchema`, `CreateStudentSchema`, `HoursAdjustmentSchema`, and `BookClassSchema`. Applied to four high-priority API routes: `admin/teachers`, `admin/students`, `admin/students/[id]/hours`, and `student/book`. Raw `body` is no longer passed directly to Supabase in any of these routes — all input flows through `parsed.data`.
- **Item 3 - File upload restrictions:** Audited all upload handlers across the codebase. Teacher and student photo uploads already had type and size checks. Added missing 10MB size check to `handleTemplateUpload` in both `BillingClient.tsx` and `BillingAdminClient.tsx`.
- **Item 4 - Rate limiting on login:** Created `src/lib/rate-limit.ts` - an in-memory rate limiter tracking failed attempts per IP. Applied to both teacher (`/login/actions.ts`) and student (`/student/login/actions.ts`) login actions. 5 failed attempts within 15 minutes triggers a 15-minute lockout. Also fixed the teacher login action which was previously returning raw Supabase error messages to the browser, leaking whether an email address exists.
- **Item 5 - Security headers:** Updated `next.config.ts` with a full security header set: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, and a Content Security Policy covering `script-src`, `style-src`, `font-src`, `img-src`, `connect-src`, `form-action`, and `frame-ancestors`. Supabase hostname derived dynamically from `NEXT_PUBLIC_SUPABASE_URL`.
- **Item 6 - RLS policy audit:** Full audit of all 26 tables. Fixed 4 critical issues (profiles exposed to all users, students exposed to all authenticated users, all lessons visible to all users, students could insert lessons with any field values), 5 high issues (student_reviews ownership gaps, training_teachers fully exposed, students had no UPDATE policy, availability_overrides and availability_templates had zero policies), and multiple medium issues (duplicate policies, public-role policies). Strengthened `is_admin()` function to also check `account_types` array for `school_admin`.
- **Item 7 - Security gap review:** Identified that column-level REVOKE was being silently ignored due to table-level grants. Created `src/lib/supabase/admin.ts` - a service role client factory for server-only admin operations. Migrated 7 admin server component pages from anon key to service role key. Created `/api/admin/billing/entities/route.ts` - a new API route that serves `hourly_rate` (teachers) and `cancellation_policy` (students) server-side only, replacing direct browser client queries in `BillingAdminClient.tsx`. Applied column-level REVOKE on `students` (blocking SELECT on `admin_notes`, `cancellation_policy`, `follow_up_date`, `follow_up_reason`) and `profiles` (blocking SELECT on `admin_notes`, `hourly_rate`, `follow_up_date`, `follow_up_reason`, `date_of_birth`, `contract_start`, `orientation_date`, `observed_lesson_date`, `vat_required`) for the authenticated role. Verified with SQL that sensitive columns no longer appear in authenticated SELECT grants.
- **Item 8 - NEXT_PUBLIC_SITE_URL:** Added `NEXT_PUBLIC_SITE_URL=https://lingualink-lms.vercel.app` to Vercel environment variables across all environments.
- **Production deployment fix:** Merged `dev` into `main` and pushed to GitHub, triggering a Vercel production build. Previously the production URL was returning 404 on all routes.

### Break/Fix Log

**Issue 1**
- Symptom: `npx tsc --noEmit` returned 2 errors after placing `schemas.ts` — `errorMap` property not recognised on `z.enum()` and `z.union()`
- Cause: Zod v4 renamed `errorMap` to `error` in the params object
- Fix: Replaced `{ errorMap: () => ({ message: '...' }) }` with `{ error: '...' }` in both locations
- Lesson: Always check breaking changes when a major version is already installed. Zod v4 has several API differences from v3.

**Issue 2**
- Symptom: Column-level REVOKE on `students` did not remove SELECT from the authenticated role - sensitive columns remained readable
- Cause: PostgreSQL ignores column-level REVOKEs when a table-level SELECT grant exists. The table-level grant takes precedence.
- Fix: REVOKE ALL on the table first, then GRANT back only the safe columns explicitly
- Lesson: Column-level security in PostgreSQL requires revoking the table-level grant first. REVOKE on individual columns alone has no effect if a blanket table grant is in place.

**Issue 3**
- Symptom: PowerShell regex replacement of template upload size check failed silently across two attempts
- Cause: Line ending mismatch between PowerShell's multiline regex and the file's actual `\n` endings
- Fix: Made the edit manually in Cursor - two-line addition in each file
- Lesson: For small targeted edits in files with bracket paths or line ending sensitivity, direct editor edits are faster than PowerShell regex

**Issue 4**
- Symptom: Git merge opened vim editor mid-PowerShell session
- Cause: Merge commit required a message and git's default editor is vim
- Fix: Typed `:wq` to save and exit vim
- Lesson: For future merges without a message prompt, use `git merge dev --no-edit`

### Session result

This session completed items 1 through 8 of the Step 14 hardening pass. The most significant work was the security audit - the RLS policy review uncovered four critical gaps that would have allowed any authenticated user to read sensitive admin data including `admin_notes`, `cancellation_policy`, and `hourly_rate` directly from the browser. These were resolved through a combination of corrected RLS policies, a new service role client architecture for admin server components, a dedicated billing entities API route, and PostgreSQL column-level grants. The production deployment issue that had been blocking go-live testing since the previous session was also resolved by merging `dev` into `main`. Items 9 (responsive pass) and 10 (class reminder modal) remain, followed by the client's UI fix list.


---

## Session 40 - 09 April 2026 - Portal UI overhaul: headers, login pages, and nav layout

### What was built
- Restructured all three portals (teacher, student, admin) so the left sidebar extends full height - logo sits in the sidebar on a white background, orange header spans only the right side
- Created `lingualink-logo-clean.svg` - stripped white background rect from the original SVG, cropped viewBox to content only, renders cleanly on white
- Created `lingualink-logo-white.svg` - all-white version for use on the admin black sidebar
- Applied gradient top band across teacher and student portals - logo area fades `#ffffff → #fff3e8`, header fades `#fff3e8 → #FF8303 40%`, creating a seamless unified top strip
- Removed grey dividing line between logo area and nav items - gradient flows cleanly into nav
- Fixed active nav state - `Upcoming Classes` now correctly highlights on `/upcoming-classes` and `/dashboard` using `matchPaths` array
- Redesigned teacher and student login pages - split panel layout, white form on left with full-colour logo, dark `#111827` panel on right with orange accent bar and brand tagline
- Login tagline agreed with client: "Better English. Better opportunities." with subtext "Personalised online English lessons for business professionals, everyday learners, and students of all levels."
- Admin portal sidebar updated - white logo area at top replaced with full black sidebar, white logo version used
- Fixed `suppressHydrationWarning` on root layout - resolves browser extension hydration mismatch error
- Fixed `layout.tsx` encoding issue - replaced em dash with hyphen in metadata title to prevent UTF-8 parse failure

### Break/Fix Log

**Issue 1**
- Symptom: Logo invisible in sidebar after restructure
- Cause: Original SVG had a white background rect filling the entire canvas - on white sidebar, logo was white on white
- Fix: Created `lingualink-logo-clean.svg` with background rect removed and viewBox cropped to content
- Lesson: Always inspect SVG structure before placing on coloured or matching backgrounds - background rects are commonly baked in

**Issue 2**
- Symptom: `Set-Content` with here-strings silently failing on paths containing parentheses
- Cause: PowerShell here-strings and `-LiteralPath` don't always cooperate with special characters in directory names like `(auth)` and `(student-auth)`
- Fix: Used `[System.IO.File]::WriteAllText()` with explicit UTF8 encoding — bypasses PowerShell string handling entirely
- Lesson: For any file path containing parentheses, always use `[System.IO.File]::WriteAllText()` instead of `Set-Content`

**Issue 3**
- Symptom: Login page form not vertically centred - sitting in upper portion of the panel
- Cause: Browser default body margin pushing content down; outer div not truly filling the viewport
- Fix: Used `position: fixed; top: 0; left: 0; right: 0; bottom: 0` on outer container and added `html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }` via inline style tag
- Lesson: For full-viewport login layouts, `position: fixed; inset: 0` is more reliable than `min-height: 100vh`

**Issue 4**
- Symptom: Active nav state disappearing after page load on Upcoming Classes
- Cause: Nav item href was `/dashboard` but the actual route is `/upcoming-classes` - `pathname.startsWith('/dashboard')` never matched
- Fix: Added `matchPaths` array to nav item type, Upcoming Classes now matches both `/upcoming-classes` and `/dashboard`
- Lesson: Always verify nav hrefs match actual Next.js route paths — mismatches cause active state failures silently

### Session result
All three portals now have a cohesive, professional look. The gradient top band unifies the sidebar and header into one visual element. The login pages are a significant upgrade - split panel with dark brand panel makes a strong first impression. Active nav states are reliable. The build is in a clean.


---



## Session 39 - 09 April 2026 — Logo and header styling across all three portals

### What was built
- Added the official LinguaLink Online logo SVG to all three portals (teacher, student, admin)
- Created `/public/lingualink-logo.svg` - one-colour white version, viewBox tightly cropped to content, no background rect, renders cleanly on the orange header
- Created `/public/lingualink-chat-icon.svg` and `/public/lingualink-logo-white.svg` as supporting assets
- Updated `TopHeader.tsx` (teacher portal) - header height increased to 72px, logo at 52px height, greeting text corrected to white, avatar placeholder updated to white semi-transparent style
- Updated `StudentTopHeader.tsx` (student portal) - same header treatment applied
- Updated `AdminLayoutClient.tsx` - replaced plain text "Lingualink Online — Admin" with the logo SVG, header height aligned to 72px
- Fixed `ChatWidget.tsx` type error - `sendMessageAction` receiver type extended to include `'student'` in student messages `actions.ts`
- Fixed student portal Join Class button colour from black (`#111827`) to orange (`#FF8303`)

### Break/Fix Log

**Issue 1**
- Symptom: Logo appeared tiny and faded on the orange header
- Cause: Original SVG had a white background rect baked in covering the full 394×225 canvas, leaving the actual logo content occupying a small fraction of the rendered area
- Fix: Stripped the white background rect and rewrote the SVG with a cropped viewBox (`28 26 348 172`) tightly around the actual content, all fills set to white
- Lesson: Always check SVG viewBox and background rects before placing a logo on a coloured background — dead space in the viewBox causes the logo to render smaller than expected

**Issue 2**
- Symptom: Multiple logo approaches tried (outlined stroke, pill background, white version) all looked poor on the orange header at various sizes
- Cause: The original logo uses orange and black - both problematic on an orange background. The correct solution is always the one-colour white reversed variant for use on brand-colour backgrounds
- Fix: Used the one-colour white SVG supplied by the client, stripped background rect, applied to all portals
- Lesson: Never alter a brand logo to work on a background - change the background or use the correct logo variant instead

**Issue 3**
- Symptom: `ChatWidget.tsx` showed a red TypeScript underline in the student layout
- Cause: The `sendMessageAction` prop type in `ChatWidget` accepted `'teacher' | 'admin' | 'student'` but the student `actions.ts` only declared `'teacher' | 'admin'`
- Fix: Added `'student'` to the receiver type union in the student messages `actions.ts`
- Lesson: When the same component is shared across portals with portal-specific server actions, the action signatures must match the component's expected types exactly

**Issue 4**
- Symptom: Admin portal header still showed plain text after logo update commands
- Cause: The admin header lives in `AdminLayoutClient.tsx` not a separate `TopHeader` component — regex replacement targeted the wrong file initially
- Fix: Located the correct file path `src/app/(admin)/AdminLayoutClient.tsx`, added `Image` import, replaced the text span with an `Image` tag
- Lesson: Always confirm which component owns the header for each portal before writing replacement commands

### Session result
All three portals now display the official LinguaLink Online logo in the top header bar. The teacher and student portals use a white one-colour SVG on the orange header at 52px height in a 72px bar. The admin portal header matches. The student portal Join Class button is now correctly orange.

---


## Session 38 - 09 April 2026 - Admin Controls Phase & Messaging Polish

### What was built

- **ChatWidget** - built a floating Intercom-style chat bubble (fixed bottom-right) that appears on every page of both the teacher and student portals. The widget has two tabs: Messages (pre-connected to Shannon's admin account) and FAQ (portal-specific content). Teacher and student portals pass their own server actions as props, keeping the component fully portal-agnostic. FAQ content is stored in named arrays (`TEACHER_FAQS`, `STUDENT_FAQS`) at the top of the file - The client can update the wording without touching component code.
- **What's New** - wired the RightPanel What's New section to real announcement data fetched and filtered in the layout. An orange badge shows the count when active announcements exist.
- **Teacher RightPanel next class** - replaced the placeholder countdown with real data fetched from the `lessons` table. Now displays "Next class from Xh Xm Xs", the date and time range, and the student name — matching the LearnCube reference style. Join Class button appears 15 minutes before the class start time.
- **Message bubble redesign** - sent messages are #FF8303 orange with white text; received messages are #1F2937 dark charcoal with white text. Applied consistently across the teacher MessagesClient, student StudentMessagesClient, and the ChatWidget.
- **Read ticks** - added WhatsApp-style read receipts to both MessagesClient and StudentMessagesClient. Single grey tick = sent. Double orange tick = read. Ticks update in real time via Supabase Realtime UPDATE subscriptions without a page refresh.
- **Composer fix** - removed the box-within-a-box issue in the Tiptap editor by adding a scoped `<style>` tag that suppresses ProseMirror's own default focus border. One clean rounded container remains.
- **RLS policy fixes** - fixed the messages table policies to cover both teacher auth (auth.uid() maps directly to profiles.id) and student auth (auth.uid() maps via students.auth_user_id to students.id). Added `REPLICA IDENTITY FULL` on the messages table to enable real-time UPDATE event tracking for read receipts.
- **StudentRightPanel** - removed the old Help & Support section and button. The ChatWidget floating bubble replaces it entirely.

### Break/Fix Log

**Issue 1**
- Symptom: Student could not send messages - "new row violates row-level security policy for table messages"
- Cause: The INSERT policy on messages only covered teachers (auth.uid() = sender_id). Students have a different auth structure - their sender_id is students.id, not auth.uid()
- Fix: Added a dedicated INSERT policy using `SELECT id FROM students WHERE auth_user_id = auth.uid()` to resolve the student's sender_id correctly
- Lesson: Any RLS policy on a shared table must account for both auth patterns — teacher (profiles) and student (students with auth_user_id)

**Issue 2**
- Symptom: Read ticks were not updating in real time on either portal despite the UPDATE subscription being in place
- Cause: Supabase Realtime UPDATE events only broadcast changed columns by default - without REPLICA IDENTITY FULL, the full row is not sent and the subscription receives no usable payload
- Fix: `ALTER TABLE messages REPLICA IDENTITY FULL` - run once, applies to all users and all portals permanently
- Lesson: Any table using real-time UPDATE subscriptions requires REPLICA IDENTITY FULL or the subscription will silently receive incomplete payloads

**Issue 3**
- Symptom: Read ticks updated for students but not for teachers even after REPLICA IDENTITY FULL was set
- Cause: The SELECT policy "Users see their own messages" only matched `auth.uid() = sender_id`, which works for teachers but not students. When Supabase tried to return the updated row to the student's real-time subscription, the SELECT policy blocked it
- Fix: Dropped and rewrote both the SELECT and UPDATE policies to include the student auth lookup pattern on sender_id, receiver_id, and the admin role check
- Lesson: REPLICA IDENTITY FULL is necessary but not sufficient — the SELECT policy must also permit the subscribing user to read the updated row or the event is silently dropped

### Session result

The Admin Controls phase is complete. Both portals now have a fully working floating chat widget connected to Shannon's admin account, with an FAQ tab that can be updated without code changes. The messaging system is polished across all three portals - consistent bubble colours, real-time read receipts, and a clean composer. RLS policies on the messages table now correctly cover every user type. The project is ready to move into the Step 14 hardening pass.


---

## Session 37 - 08 April 2026 - Admin Portal Step 14: Settings Page

### What was built

- Created `/app/(admin)/admin/settings/page.tsx` - server component that fetches all settings from the `settings` key/value table and passes them to the client form
- Created `/app/(admin)/admin/settings/SettingsClient.tsx` - client component with a fully configurable settings form covering six platform-wide settings: admin support email, minimum teacher availability hours, invoice upload window (start and end day of month), payment timeline in days, student low-balance warning threshold, and default cancellation window (24hr / 48hr toggle)
- Created `/app/api/admin/settings/route.ts` - GET and POST API route with admin role verification; POST uses Supabase upsert on the `key` conflict target so settings are created on first save and updated on all subsequent saves
- Fixed save feedback visibility - initial implementation placed the success banner at the top of the page which was off-screen when the user scrolled to the Save button; moved inline feedback directly beside the Save button so it is always visible regardless of scroll position

### Break/Fix Log

**Issue 1**
- Symptom: Save Settings returned HTTP 200 and data persisted correctly in Supabase, but no visual confirmation appeared after clicking Save
- Cause: Success banner was rendered at the top of the component, above all the setting sections. The user naturally scrolls down to reach the Save button at the bottom of the page, so the banner rendered entirely off-screen
- Fix: Removed the top banner entirely and replaced it with inline feedback text rendered directly beside the Save button in the same flex row
- Lesson: On long forms, always place save feedback adjacent to the action that triggers it - never assume the user's scroll position

### Session result

Admin Portal Step 14 is complete, and with it the entire Admin Portal build is done - all 14 steps across Steps 1 through 14 are fully built and tested. The Settings page allows the client to configure all key platform thresholds from a single screen without touching the database directly. The `settings` key/value table was already in place from earlier in the build; this step wires the admin UI on top of it. Next session will begin the Admin Controls phase: wiring the "Chat with Admin" button and "What's New" notifications in the teacher and student RightPanel components.


---


## Session 36 - 08 April 2026 - Data Exports Autocomplete

### What was built

- Added `GET` handler to `/api/admin/teachers/route.ts` - supports `?minimal=true&search=name` for autocomplete lookups
- Added `GET` handler to `/api/admin/students/route.ts` - same pattern
- Added `GET` handler to `/api/admin/companies/route.ts` - supports `?minimal=true` for dropdown list
- Replaced UUID text inputs on the Exports page with a reusable `AutocompleteInput` component - type a name, get a live dropdown, select to filter, pill shows the selection with a clear button
- Companies use a simple dropdown (small list); teachers and students use the debounced autocomplete (scales to any size)

### Break/Fix Log

No issues. Worked on first test after adding the GET handlers.

### Session result

The Data Exports page is now fully usable in production. The client can filter any export by teacher or student name without needing to know or paste UUIDs. The autocomplete debounces at 250ms and limits results to 50 - performant at any scale.

---



## Session 35 - 08 April 2026 - Admin Portal Steps 12 & 13: Tasks and Data Exports

### What was built

- **Step 12: Tasks** - Full internal task management system for Shannon and staff
  - `GET /api/admin/tasks` - filterable task list with resolved names for assigned user, linked entity, and creator
  - `POST /api/admin/tasks` - create task with validation
  - `PATCH /api/admin/tasks/[id]` - complete, reopen, or edit a task
  - `DELETE /api/admin/tasks/[id]` - admin-only delete
  - `GET /api/admin/staff` - returns all admin-role profiles for the Assigned To dropdown
  - `TaskForm.tsx` - shared create/edit form component; accepts prefill props for launching from teacher or student detail pages
  - `TasksMini.tsx` - compact embeddable panel for showing open tasks on teacher/student detail pages; includes quick complete button and Add Task shortcut
  - `/admin/tasks/page.tsx` - full tasks list with filters (status, priority, linked entity), overdue highlighting, priority-coloured left borders, and complete/reopen/edit/delete actions
  - `/admin/tasks/new/page.tsx` and `/admin/tasks/[id]/edit/page.tsx` - thin wrappers around TaskForm

- **Step 13: Data Exports** - All six CSV exports from the brief
  - Single API route `GET /api/admin/exports/[type]/route.ts` handles all six export types
  - `/admin/exports/page.tsx` - export cards with per-card date range and entity filters, column previews, and browser-triggered CSV downloads
  - **All Classes Report** - every lesson with teacher, student, company, status, report status, and teacher billability flag
  - **Teacher Earnings Summary** - grouped by teacher × month; calculates billable classes × hourly rate with invoice upload status
  - **Student Hours Usage** - training package hours consumed and remaining per student
  - **Company Billing Report** - B2B classes with standard billability and 48hr cancellation policy flag (admin-only field, never exposed to teachers or students)
  - **Student Progress Report** - level data from every completed report across all skills
  - **Pending Reports Log** - all pending and flagged reports with hours-since-class counter

### Break/Fix Log

No issues this session. All features worked on first test.

### Session result

Admin Portal Steps 12 and 13 are complete and tested. The Tasks system is fully functional - Shannon can create, assign, prioritise, complete, and delete internal follow-up tasks, with the TasksMini component ready to embed into teacher and student detail pages when those are revisited. All six Data Exports produce correct CSVs and download cleanly in the browser. The Admin Portal now has one step remaining: Step 14 Settings, followed by the Admin Controls phase and the final hardening pass before go-live.

---

Once that's pushed, start a fresh chat and paste the handover brief from that session.


---

## Session 34 - 08 April 2026 - MS Graph API Integration + Admin Portal Step 11: Announcements

### What was built

- Resolved MS Graph API integration - switched from `/onlineMeetings` endpoint to Calendar Events endpoint (`/users/{UPN}/events` with `isOnlineMeeting: true`) to work within Microsoft 365 Business Basic licence constraints
- Configured Azure application access policy via Teams PowerShell (`New-CsApplicationAccessPolicy`, `Grant-CsApplicationAccessPolicy`, `Grant-CsTeamsMeetingPolicy`) - all policies confirmed on organiser account
- Rewrote `src/lib/microsoft/graph.ts` to use Calendar Events endpoint - same function signatures, same inputs and outputs, no changes required anywhere else in the codebase
- Confirmed end-to-end Teams meeting creation returning a valid `joinUrl` and `meetingId`
- Built Admin Portal Step 11 - Announcements in full:
  - `src/app/(admin)/admin/announcements/page.tsx` - server component list page
  - `src/app/(admin)/admin/announcements/AnnouncementsClient.tsx` - list with quick activate/deactivate toggle, edit, delete
  - `src/app/(admin)/admin/announcements/AnnouncementForm.tsx` - shared create/edit form with all fields from brief
  - `src/app/(admin)/admin/announcements/new/page.tsx` - create page
  - `src/app/(admin)/admin/announcements/[id]/edit/page.tsx` - edit page
  - `src/components/AnnouncementBanner.tsx` - client banner component with dismiss support
  - `src/app/api/announcements/dismiss/route.ts` - API route persisting dismissals to `announcement_dismissals` table
  - Modified `src/app/(dashboard)/layout.tsx` - teacher portal layout now fetches and renders active announcements
  - Modified `src/app/(student)/student/layout.tsx` - student portal layout now fetches and renders active announcements

### Break/Fix Log

**Issue 1**
- Symptom: MS Graph API returning 404 UnknownError on `/users/{UPN}/onlineMeetings`
- Cause: Microsoft 365 Business Basic does not support the `/onlineMeetings` Graph API endpoint regardless of API permissions or PowerShell policies assigned
- Fix: Switched to Calendar Events endpoint (`/users/{UPN}/events`) with `isOnlineMeeting: true` and `onlineMeetingProvider: teamsForBusiness` - produces identical Teams join URL
- Lesson: The `/onlineMeetings` Graph API endpoint requires Business Standard or higher. Always verify licence tier compatibility before building against a specific Graph API endpoint. The Calendar Events approach is a clean equivalent and works with Basic.

**Issue 2**
- Symptom: Announcement form returning `null value in column "created_by" violates not-null constraint`
- Cause: `AnnouncementForm.tsx` was not fetching the current user ID and not including `created_by` in the insert payload
- Fix: Added `useEffect` to fetch the current auth user on mount via `supabase.auth.getUser()` and included `created_by: currentUserId` in the payload
- Lesson: Always include required non-null database columns in insert payloads. Client components cannot access the server session directly — must use `supabase.auth.getUser()` on the browser client.

**Issue 3**
- Symptom: Announcement banner blending into the orange top header — visually indistinct
- Cause: Banner used the same `#FF8303` background as the header
- Fix: Changed banner style to dark charcoal background (`#1f2937`) with orange left border (`4px solid #FF8303`) — clearly distinct from header while remaining on-brand
- Lesson: Notification banners directly below a coloured header must use a contrasting background to be readable and visually intentional.

### Session result

The MS Graph API integration is fully operational after resolving a Microsoft 365 licence constraint — the Calendar Events endpoint is now used instead of the dedicated onlineMeetings endpoint, producing identical Teams join URLs with no impact on the rest of the codebase. The organiser account (`Admin@LingualinkOnline.onmicrosoft.com`) can be swapped to a dedicated shared mailbox at any time by changing a single constant in `graph.ts`. Admin Portal Step 11 (Announcements) is complete and fully tested — admins can create, edit, toggle, and delete announcements, banners appear correctly on both the Teacher and Student portals, and dismissals are persisted per user. Remaining Admin Portal steps are 12 (Tasks), 13 (Exports), 14 (Settings), and 15 (Testing & Hardening).

---



## Session 33 - 08 April 2026 - Admin Portal Step 10: Study Library

### What was built
- `src/app/(admin)/admin/library/page.tsx` - server component with admin auth guard
- `src/app/(admin)/admin/library/LibraryAdminClient.tsx` - full list view with search, five filters (title, category, level, difficulty, access), checkbox bulk selection, bulk access change, bulk delete with confirmation
- `src/app/(admin)/admin/library/SheetFormModal.tsx` - create/edit modal with four tabs: Metadata (title, category, level, difficulty selector with chilli icons, intro text), Vocabulary (dynamic add/remove/reorder word rows storing to JSONB `{ words: [] }`), Exercises (full MCQ builder per question: question text, four options, correct answer selector, explanation), Access (radio selection: All Teachers / Teacher+Exam Only / Admin Only)
- `src/app/(admin)/admin/library/AssignSheetModal.tsx` - assign any sheet to any student directly without a lesson link (admin-only flow)
- `src/app/api/admin/library/route.ts` - GET all sheets, POST create
- `src/app/api/admin/library/[id]/route.ts` - PATCH update, DELETE single
- `src/app/api/admin/library/assign/route.ts` - POST direct admin assignment (lesson_id nullable)

### Break/Fix Log

**Issue 1**
- Symptom: Edit sheet returned 500 - `PATCH /api/admin/library/[id]` failing
- Cause: Next.js 15 changed dynamic route `params` to a Promise; accessing `params.id` synchronously throws at runtime
- Fix: Changed both `PATCH` and `DELETE` signatures to `{ params }: { params: Promise<{ id: string }> }` and added `const { id } = await params` before use
- Lesson: All `[id]` route handlers in Next.js 15 must await params - apply this pattern to any future dynamic routes without exception

### Session result
Admin Portal Step 10 is fully complete. The client can create, edit, and delete study sheets from the admin portal, with a full vocabulary word table editor and MCQ exercise builder built into the form modal. Access control per sheet (All Teachers / Teacher+Exam Only / Admin Only) is working. Bulk actions for access change and delete are functional. Direct sheet assignment to students from admin is wired up. Began investigating MS Graph API integration for Teams meeting creation but deferred - dev server was not running at time of test. Azure credentials are confirmed in `.env.local` and the `graph.ts` stub is fully written; Azure API permissions still need to be verified before a live test can be run.

---


## Session 32 - 08 April 2026 - Admin Portal Step 9: Billing

### What was built
- Admin Billing page with three tabs: Teacher Invoices, Student Billing, and Company Billing
- Teacher Invoices tab: filterable by teacher, month, and status; invoice template upload and management; expandable invoice rows showing itemised lesson list with billability labels and subtotal; Mark Paid flow with confirmation modal; View PDF button (signed URL); Export CSV
- Student Billing tab: filter by student and date range, on-demand load, summary bar showing total classes and billable total, lessons table with billability flag per row
- Company Billing tab: filter by company and date range, on-demand load, lessons grouped by company, 48hr policy cancellations surfaced in an orange callout - visible in admin only, never exposed to teachers or students
- Billability logic implemented consistently across UI and CSV export: `completed` → billable, `student_no_show` → billable, `cancelled` with less than 24hr notice → billable, `teacher_no_show` → not billable, `cancelled` with more than 24hr notice → not billable, `cancelled` between 24–48hr where student `cancellation_policy = '48hr'` → 48hr B2B flag (not billable to teacher, flagged for company billing only)
- Mark Paid API route: PATCH `/api/admin/billing/mark-paid` with admin role check
- CSV export API route: GET `/api/admin/billing/export` supporting 6 export types - teacher invoices, teacher earnings summary, student hours usage, company billing report, student progress report, pending reports log
- 4 files delivered: `src/app/api/admin/billing/mark-paid/route.ts`, `src/app/api/admin/billing/export/route.ts`, `src/app/(admin)/admin/billing/page.tsx`, `src/app/(admin)/admin/billing/BillingAdminClient.tsx`

### Break/Fix Log
No issues this session. All four files landed and worked correctly on first load. Billability logic, Mark Paid flow, invoice detail expansion, and CSV export all confirmed working via browser testing.

### Session result
Admin Portal Step 9 is fully complete. The Billing section gives the client full visibility over teacher invoices, student billing, and company billing from a single page. The billability logic correctly distinguishes all class status combinations including the 48hr B2B cancellation policy, which surfaces only in the Company Billing tab as required. Mark Paid updates invoice status in real time. CSV export works across all six report types. The admin nav already had a Billing entry wired to `/admin/billing` so no navigation changes were needed.

---



## Session 31 - 08 April 2026 - Admin Portal Step 8: Reports

### What was built
- All Reports list page with status filters (All / Pending / Completed / Flagged), teacher filter, class type filter, and date range filter
- Colour-coded rows: soft yellow for pending reports, soft red for flagged reports
- Flagged reports show time elapsed since flagging (e.g. "Flagged 109h 25m ago") in red
- Reopen button on flagged reports with confirmation modal - sets report back to pending so teacher can submit late
- Report Detail page (read-only): class info, date/time, duration, did class take place, flagged timestamp, teacher and student participant cards, feedback text, additional details, SVG radar chart for student level assessment, assigned study sheets
- Live Classes Trace tab: last 50 lessons in reverse chronological order, polling every 30 seconds, auto-refresh timestamp, lesson status badges, report status badges, View report links
- 7 files delivered: `src/app/api/admin/reports/route.ts`, `src/app/api/admin/reports/[id]/route.ts`, `src/app/api/admin/reports/live-trace/route.ts`, `src/app/(admin)/admin/reports/page.tsx`, `src/app/(admin)/admin/reports/ReportsClient.tsx`, `src/app/(admin)/admin/reports/[id]/page.tsx`, `src/app/(admin)/admin/reports/[id]/ReportDetailClient.tsx`

### Break/Fix Log

**Issue 1**
- Symptom: Reports list showed "No reports match these filters" despite the right panel showing 3 flagged reports
- Cause: Three-level nested Supabase join (`reports → lessons → students`) causes silent empty results — Supabase returns no rows without any error when a join is nested this deeply
- Fix: Split into two queries — Query 1 fetches reports + lessons + teacher profile (two levels), Query 2 fetches students by their IDs collected from Query 1 results using `.in('id', studentIds)`
- Lesson: Never nest Supabase joins more than two levels deep. Always use the two-query pattern when a student or third entity needs to be resolved

**Issue 2**
- Symptom: API route returned 500 with `column lessons_1.start_time does not exist`
- Cause: The `lessons` table uses `scheduled_at`, not `start_time` — assumed the wrong column name without verifying schema first
- Fix: Queried `information_schema.columns` for the `lessons` table, confirmed correct column name, updated all 7 files
- Lesson: Always run the schema verification query before writing any database-connected code. The `lessons` table uses `scheduled_at` (not `start_time`) and `teams_join_url` (not `teams_link`)

**Issue 3**
- Symptom: API route returned 500 with `column profiles_1.avatar_url does not exist`
- Cause: The `profiles` table uses `photo_url`, not `avatar_url` - same assumption error as Issue 2
- Fix: Queried `information_schema.columns` for `profiles` and `students`, confirmed both use `photo_url`, updated all 7 files
- Lesson: The photo field is `photo_url` on both `profiles` and `students` - never assume `avatar_url`

### Session result
Admin Portal Step 8 is fully complete. The Reports section gives the client full visibility over all class reports - pending, completed, and flagged. The reopen flow works correctly, updating the list in real time after a flagged report is set back to pending. The Live Classes Trace tab loads all lessons with their report status and auto-refreshes every 30 seconds. Three schema debugging cycles were required due to unverified column name assumptions, reinforcing the rule to always query the schema before writing any database-connected code.

---



## Session 30 - 08 April 2026 - Admin Portal Step 7: Classes

### What was built
- `src/app/api/admin/classes/route.ts` - GET list + POST create
- `src/app/api/admin/classes/[id]/route.ts` - GET detail + PATCH edit/cancel
- `src/app/(admin)/admin/classes/page.tsx` - server component
- `src/app/(admin)/admin/classes/ClassesListClient.tsx` - list UI with filters and status tags
- `src/app/(admin)/admin/classes/new/page.tsx` - booking flow server wrapper
- `src/app/(admin)/admin/classes/new/BookingFlowClient.tsx` - 5-step booking flow
- `src/app/(admin)/admin/classes/[id]/page.tsx` - detail server component
- `src/app/(admin)/admin/classes/[id]/ClassDetailClient.tsx` - detail UI with cancel modal
- `src/app/(admin)/admin/classes/[id]/edit/page.tsx` - edit server component
- `src/app/(admin)/admin/classes/[id]/edit/EditClassClient.tsx` - edit form

### Break/Fix Log
Issue 1: Class detail page threw "Failed to parse URL from undefined" / Server components were fetching from the API using NEXT_PUBLIC_SITE_URL which is not set in dev / Replaced API fetch with direct Supabase queries in both detail and edit server components / Always query Supabase directly in server components - never self-fetch API routes
Issue 2: Cancel modal confirmed but class status did not update / RLS had no UPDATE policy covering admin users — Supabase silently updated 0 rows and returned 200 / Added "Admins can update lessons" RLS policy / Always audit UPDATE policies separately from SELECT - missing UPDATE policies fail silently with no error

### Session result
Admin Portal Step 7 complete. The Classes section gives the client full visibility and control over all lessons across all teachers — list view with filters, manual booking flow, class detail with cancellation, and edit capabilities with no time restrictions.

---


## Session 29 - 08 April 2026 - Admin Portal Steps 5 & 6: Edit Student + Companies

### What was built
- `src/app/(admin)/admin/students/[id]/edit/page.tsx` - server component pre-fetching student, active training, assigned teacher IDs, companies, and teachers
- `src/app/(admin)/admin/students/[id]/edit/EditStudentClient.tsx` - four-section pre-populated edit form (Personal Info, Learning Info, Training Setup, Notes); email read-only; no temp password field
- `src/app/api/admin/students/[id]/route.ts` - PATCH handler updating students table, active training record, and training_teachers (delete + re-insert on teacher change)
- `src/app/(admin)/admin/companies/page.tsx` - companies list server component
- `src/app/(admin)/admin/companies/CompaniesListClient.tsx` - searchable/filterable table with status and cancellation policy display
- `src/app/(admin)/admin/companies/new/page.tsx` + `CreateCompanyClient.tsx` - create company form
- `src/app/(admin)/admin/companies/[id]/page.tsx` - detail server component fetching company, students, hours remaining, and assigned teachers
- `src/app/(admin)/admin/companies/[id]/CompanyDetailClient.tsx` - three-tab detail view: General Info, Students, Notes
- `src/app/(admin)/admin/companies/[id]/edit/page.tsx` + `EditCompanyClient.tsx` - edit form pre-populated from existing data
- `src/app/api/admin/companies/route.ts` - POST handler
- `src/app/api/admin/companies/[id]/route.ts` - PATCH handler

### Break/Fix Log
No issues.

### Session result
Two admin steps completed in one session. Edit Student is fully functional - the form pre-populates from existing data and saves changes across the students, trainings, and training_teachers tables in a single PATCH call. The Companies module is fully functional - the client can create, view, edit, and manage B2B companies, with a Students tab showing hours remaining, assigned teachers, and cancellation policy per student. Admin Portal Steps 5 and 6 are complete.


---

## Session 28 - 07 April 2026 - Admin Portal Step 5: Student Management (Part 1)

### What was built
- `src/app/(admin)/admin/students/page.tsx` - student list server component with company, training hours, and assigned teachers via nested joins
- `src/app/(admin)/admin/students/StudentsListClient.tsx` - searchable, filterable student table with status badges, hours badges, teacher tags, and low-hours quick filter
- `src/app/(admin)/admin/students/new/page.tsx` - create student server component fetching companies and teachers for dropdowns
- `src/app/(admin)/admin/students/new/CreateStudentClient.tsx` - four-section create form (Personal Info, Learning Info, Training Setup, Notes) with admin-only field labelling and cancellation policy toggle
- `src/app/api/admin/students/route.ts` - POST route: creates Supabase auth user, upserts student row, creates training record, inserts training_teachers rows, sends welcome email via Resend
- `src/app/(admin)/admin/students/[id]/page.tsx` - student detail server component with separate queries for student, training, lessons, hours log, reports, and reviews
- `src/app/(admin)/admin/students/[id]/StudentDetailClient.tsx` - six-tab detail view: Overview, Classes, Hours Log (with Add/Remove), Reports, Messages (placeholder), Reviews
- `src/app/api/admin/students/[id]/hours/route.ts` - POST route: adds or removes hours by updating training record and writing to hours_log table

### Break/Fix Log
Issue 1: Student detail page returning 404 / Symptom: clicking student name in list returned 404. Cause: Next.js dynamic route folder was created as `` `[id`] `` (with literal backticks) instead of `[id]` due to PowerShell escaping behaviour in `New-Item`. Fix: stopped dev server, used `Rename-Item -LiteralPath` to rename folder to `[id]`. Lesson: `New-Item` accepts square brackets without escaping - never use backticks when creating dynamic route folders.

Issue 2: Same backtick folder problem on API route / Symptom: Add Hours returned "Unexpected token '<'" JSON parse error - Next.js was returning an HTML 404 page instead of the API response. Cause: same `[id]` folder naming issue on `src/app/api/admin/students/[id]/hours/`. Fix: same rename approach after stopping dev server.

Issue 3: Duplicate file in Downloads causing stale copy to be deployed / Symptom: `StudentDetailClient.tsx` showed 2026/04/02 date after copy. Cause: browser saved new download as `StudentDetailClient (1).tsx` without overwriting the old file. Fix: copied the `(1)` version explicitly. Lesson: delete all `.tsx` and `.ts` files from Downloads after each session to prevent this.

Issue 4: Admin portal content not centred / Symptom: all admin pages rendered left-aligned instead of centred like the teacher and student portals. Cause: `<main>` in `AdminLayoutClient.tsx` had no max-width or margin auto. Fix: wrapped `{children}` in `<div className="max-w-6xl mx-auto">`. Lesson: layout-level centring belongs in the shell, not individual pages.

### Session result
Student Management for the Admin Portal is now partially complete. The student list, create student flow, and student detail page are all working end to end. A new student can be created with full personal, learning, training, and notes data — the auth user, student row, training record, and teacher assignments all save correctly in one API call. The student detail page shows all data across six tabs, and the Hours Log tab supports adding and removing hours with full transaction history. The next session will continue with Edit Student and then move on to the remaining Admin Portal steps.

---

Go to your JOURNAL.md on GitHub, paste this at the top, and then sync locally with `git pull origin dev`.


## Session 27 - 07 April 2026 - Admin Portal Step 4: Teacher Management

### What was built
- `src/app/(admin)/admin/teachers/page.tsx` - server component fetching all teacher profiles with lesson counts
- `src/app/(admin)/admin/teachers/TeachersListClient.tsx` - searchable, filterable teacher list table with status badges, role tags, and hourly rate
- `src/app/(admin)/admin/teachers/new/page.tsx` - server component shell for create teacher page
- `src/app/(admin)/admin/teachers/new/CreateTeacherClient.tsx` - two-section create form (Account & Login / Profile & Admin Info) with multi-select account types, language toggles, admin-only fields, and amber admin notes panel
- `src/app/api/admin/teachers/route.ts` - POST handler: creates Supabase auth user via service role, upserts profile row, sends welcome email with password reset link via Resend
- `src/app/(admin)/admin/teachers/[id]/page.tsx` - server component fetching teacher profile, lessons, invoices, and history log
- `src/app/(admin)/admin/teachers/[id]/TeacherDetailClient.tsx` - four-tab detail view (Overview, Classes, Invoices, History) with soft-delete (deactivate) functionality
- `src/app/(admin)/admin/teachers/[id]/edit/page.tsx` - server component supporting `?section=public` query param to open directly on Profile & Admin Info tab
- `src/app/(admin)/admin/teachers/[id]/edit/EditTeacherClient.tsx` - full edit form pre-populated from existing profile data; saves via PATCH with history logging
- `src/app/api/admin/teachers/[id]/route.ts` - PATCH handler: updates profile, diffs changed fields, writes to teacher_history_log; rolls back auth user on profile failure

### Break/Fix Log
Issue 1: Supabase trigger auto-creates profile row on auth user creation / Profile insert failed with duplicate key error / Changed `.insert()` to `.upsert()` in POST handler / Supabase has a trigger that inserts a profile row immediately after auth user creation - always use upsert when inserting a profile tied to a new auth user.

Issue 2: Clicking teacher row caused "Router action dispatched before initialization" error / `onClick` with `router.push()` fired before Next.js router was ready / Replaced row onClick with a `Link` component wrapping the teacher name / Use `Link` for navigation in tables, not `router.push()` on row click.

Issue 3: Edit form save failed with PGRST204 - columns not found / `date_of_birth`, `title`, `gender`, `nationality`, `phone`, `qualifications` did not exist on the profiles table / Added all missing columns via `ALTER TABLE` in Supabase SQL Editor / Always verify column existence in Supabase before writing any update payload — schema additions from the brief are not automatically applied.

### Session result
Admin Portal Step 4 is complete. The full teacher management flow is working: the client can view all teachers in a searchable list, create new teacher accounts (which triggers a welcome email with a password reset link), view full teacher detail across four tabs, edit all profile fields, and deactivate teachers with a soft delete. All profile changes are recorded in the teacher_history_log for audit purposes. Admin-only fields (hourly rate, VAT, date of birth, admin notes, follow-up) are clearly labelled and will be protected at the RLS level in the Step 15 hardening pass.

---


## Session 26 - 07 April 2026 - Admin Portal Step 3: Dashboard

### What was built
- `src/app/(admin)/admin/page.tsx` - server component fetching all dashboard data in parallel
- `src/app/(admin)/admin/DashboardClient.tsx` - client component rendering dashboard UI
- `src/app/(admin)/layout.tsx` - updated to fetch right panel stats and pass as props
- `src/app/(admin)/AdminLayoutClient.tsx` - right panel wired with live counts

### Break/Fix Log
Issue 1: Teacher names missing in Today's Classes feed / Test lesson records had a student auth_user_id in the teacher_id column / Updated the lesson records in Supabase to point to the correct profiles row / Always verify test data FK relationships before debugging code

### Session result
The admin dashboard is fully live. Six stat cards show real-time counts for classes today, pending reports, flagged reports (red when > 0), low hours students, invoices to review, and active announcements. The live classes feed shows today's classes with computed status badges. The pending reports panel surfaces flagged reports first in red with reopen links. The alerts panel flags zero-balance students with upcoming classes and classes missing a Teams link. The right panel is wired across the entire admin shell. Auto-refresh runs every 30 seconds via router.refresh().

---


## Session 25 - 07 April 2026 - Admin Portal Step 2: Database Schema

### What was built
- Added admin columns to `profiles` table: contract_start, orientation_date, observed_lesson_date, vat_required, account_types, teacher_type, status, follow_up_date, follow_up_reason, admin_notes, native_languages, specialties, quote, video_url
- Added admin columns to `students` table: company_id, cancellation_policy, customer_number, is_private, academic_advisor_id, status, follow_up_date, follow_up_reason, admin_notes, teacher_notes
- Added columns to `study_sheets` table: allowed_roles, intro_text
- Created six new tables: companies, hours_log, announcements, announcement_dismissals, admin_tasks, teacher_history_log
- Enabled RLS on all new tables with policies created immediately
- Created `is_admin()` helper function used across RLS policies
- Set the client's account_types to ['teacher', 'school_admin']

### Break/Fix Log
Issue 1: Student cancellation action returned success but lessons remained as 'scheduled' in the UI.
Cause: No UPDATE RLS policy on the `lessons` table - Supabase blocked the write silently with no error.
Fix: Added "Students can cancel their own lessons" UPDATE policy scoped to the student's own records.
Lesson: RLS can block UPDATE while allowing SELECT on the same table - always audit all CRUD operations, not just reads.

### Session result
All database schema updates for the Admin Portal are in place. Existing tables extended with admin-specific columns, six new tables created, and RLS policies applied immediately. The client's profile correctly carries the school_admin account type. Ready for Admin Portal Step 3: Dashboard.


---


## Session 24 - 07 April 2026 - MS Graph API Wired + Admin Portal Step 1

### What was built
- `src/lib/microsoft/graph.ts` - MS Graph API service with three functions: `createTeamsMeeting`, `updateTeamsMeeting`, `cancelTeamsMeeting`. All meetings created under a shared M365 organiser account tied to the client's tenant.
- `src/app/api/student/book/route.ts` - stub replaced with real Graph API call. Teams join URL now included in confirmation emails to both student and teacher. Booking proceeds safely if Graph API fails — lesson is saved with `TEAMS_LINK_PENDING` and Sentry captures the error.
- `src/proxy.ts` - admin route protection added. Checks `profiles.role === 'admin'`; redirects unauthenticated users to `/login` and non-admin users to `/upcoming-classes`.
- `src/app/(admin)/layout.tsx` - admin layout server component with auth and role gate.
- `src/app/(admin)/AdminLayoutClient.tsx` - full admin shell: dark sidebar, orange header, right panel with placeholder widgets, mobile hamburger menu, Back to Teacher Portal and Log Out links.
- `src/app/(admin)/admin/page.tsx` - placeholder dashboard confirming `/admin` route is live.
- Installed `@microsoft/microsoft-graph-client` and `@azure/identity` packages.

### Break/Fix Log
Issue 1: middleware.ts conflict / Cause: Project uses `proxy.ts` instead of standard `middleware.ts` — both cannot coexist. / Fix: Deleted `middleware.ts` and merged admin route protection into existing `proxy.ts`. / Lesson: Always check for `proxy.ts` before creating `middleware.ts` in this project.

Issue 2: Graph API - wrong tenant ID / Cause: `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` were swapped in `.env.local`. / Fix: Corrected both values in `.env.local` using the app registration Overview page. / Lesson: Both values are UUIDs and look identical - always verify against the Azure portal labels, not position on the page.

Issue 3: Graph API - 404 UnknownError on onlineMeetings endpoint / Cause: The client's Microsoft 365 Business Basic subscription was purchased today and the license has not yet propagated to the organiser account. Microsoft can take up to 24 hours to activate. / Fix: Deferred - code is correct. Retest tomorrow once license is active. / Lesson: New M365 subscriptions are not instant - build the stub fallback pattern so the app never breaks while waiting.

### Session result
Admin Portal Step 1 is complete and the MS Graph API is wired in across the student booking flow. Authentication is confirmed working - the 404 error on meeting creation is a license propagation delay, not a code issue. The admin portal shell loads correctly for the client's admin account and redirects all other users appropriately. Both the admin portal and Graph API work are committed to the dev branch. Next session starts with Admin Portal Step 2 — database schema updates.

---


## Session 23 - 06 April 2026 - Student Portal Layout Fixes & Centering Pass

### What was built
- Centred all student portal page layouts by adding `margin: '0 auto'` or `mx-auto` to the outermost wrapper div on affected pages
- `MyClassesClient.tsx` - added `margin: '0 auto'` to outer div
- `StudyClient.tsx` - added `mx-auto` to outer div
- `StudySheetClient.tsx` - added `mx-auto` to outer div
- `AccountClient.tsx` - added `margin: '0 auto'` to outer div
- `PastClassesClient.tsx` - already centred, no change needed
- `ProgressClient.tsx` - already centred, no change needed
- `StudentMessagesClient.tsx` - intentionally full width, no change needed

### Break/Fix Log
Issue 1: All student portal pages were left-pinned rather than centred / Pages had a maxWidth set but no margin auto, causing content to sit hard against the left edge / Added margin: '0 auto' or mx-auto to the outermost wrapper div on each affected page / Always pair maxWidth with margin auto when centering a constrained content area

### Session result
Quick polish pass to fix the layout alignment across all student portal pages. All pages with constrained content widths are now properly centred in the available space. The messages page was correctly left as full width as it uses a two-panel chat layout that should fill the content area. The student portal is now visually consistent across all pages.

---


## Session 22 - 06 April 2026 - Student Portal Steps 11 & 12: My Account and Email Notifications

### What was built
- `src/app/(student)/student/account/page.tsx` - server component fetching student record, active training, and full training history
- `src/app/(student)/student/account/AccountClient.tsx` - full My Account page with five sections: profile photo upload (Supabase Storage, avatars bucket), general information (name and email read-only, timezone and language preference editable), learning profile (goals, interests, self-assessed level), hours and training (remaining/used/total cards, progress bar, low hours warning, training history list), and password change (verifies current password via re-authentication before updating)
- `src/lib/email/templates.ts` - full replacement adding all student and teacher email content builders: booking confirmation, cancellation by student, cancellation by teacher, reschedule, 24h and 1h class reminders, homework assigned, low hours warning, new message; also fixed a broken `<a>` tag in the existing `newMessageEmailContent` function; added shared `formatClassTime` helper using `Intl.DateTimeFormat` to safely format UTC timestamps per timezone
- `src/app/api/cron/class-reminders/route.ts` - Vercel Cron job running every 15 minutes; sends 24h and 1h reminder emails to both student and teacher for upcoming lessons; uses `reminder_24_sent` and `reminder_1h_sent` flags on the `lessons` table to prevent duplicate sends
- `src/app/api/cron/low-hours-warning/route.ts` - Vercel Cron job running daily at 8am UTC; finds active trainings below 2 hours remaining and sends a low hours warning email to the student; uses `low_hours_warning_sent` flag on the `trainings` table to send only once per training package
- `vercel.json` - cron schedule configuration in project root

### Break/Fix Log
Issue 1: `reminder_24h_sent` column name mismatch / The lessons table had already been created with the column named `reminder_24_sent` (no h) / Used the actual column name from the schema in all cron job queries / Always verify exact column names against Supabase schema before writing queries

Issue 2: Broken `<a>` tag in existing templates.ts / The opening `<a` tag was missing from `newMessageEmailContent`, leaving a bare `href=` attribute in the HTML / Fixed when rewriting templates.ts

### Session result
Steps 11 and 12 of the Student Portal are complete. Students can now manage their full account - profile photo, preferences, learning profile, hours overview, training history, and password change. All transactional email templates are in place for both portals, and two Vercel Cron jobs handle automated reminders and low hours warnings. The `CRON_SECRET` environment variable was added to `.env.local` and must be added to Vercel environment variables before deployment.

---


## Session 21 - 06 April 2026 - Student Portal Step 10: Study Tab

### What was built
- `src/app/(student)/student/study/page.tsx` - server component fetching assignments, exercise completions, and full study sheet library for the logged-in student
- `src/app/(student)/student/study/StudyClient.tsx` - client component with two manual tab sections: Assigned by Your Teacher (pending/completed split with status cards) and Practice on Your Own (searchable, filterable library table)
- `src/app/(student)/student/study/[id]/page.tsx` - server component fetching individual study sheet, its exercises, and whether the student has already completed this sheet
- `src/app/(student)/student/study/[id]/StudySheetClient.tsx` - full exercise interaction UI: vocabulary list with browser-native pronunciation audio, multiple choice exercises with correct/incorrect highlighting, explanation boxes, progress bar, and completion screen
- `src/app/api/student/exercise-complete/route.ts` - POST endpoint saving exercise_completions records with student ownership verification

### Break/Fix Log
Issue 1: TypeError on exercises tab - `currentExercise` was undefined / The exercise card rendered even when `totalExercises === 0` because the empty-state check did not prevent the card block from rendering / Added `totalExercises > 0` guard to the card render condition / Always guard array-index access when the array may be empty.

### Session result
Step 10 complete. The Study tab renders both the assigned homework section and the self-directed practice library. Individual study sheets display the vocabulary list with browser speech synthesis for pronunciation, and walk students through multiple choice exercises one at a time with immediate feedback and explanations. Completions are saved to the exercise_completions table via a verified API route. Both sections confirmed working against real test data.

---


## Session 20 - 06 April 2026 - Student Portal Steps 8 & 9

### What was built
- `src/app/(student)/student/progress/page.tsx` - server component fetching training data, completed lessons, latest report level data, and exercise completion stats for the logged-in student
- `src/app/(student)/student/progress/ProgressClient.tsx` - client component displaying training overview (total/used/remaining hours, end date, progress bar), radar/spider chart (recharts, #FF8303) showing CEFR skill levels from the latest teacher assessment, class history summary (total classes, total learning time, average classes per week), and exercises progress (assigned/completed/pending with progress bar)
- `src/app/(student)/student/messages/actions.ts` - server actions for sending messages and marking messages as read; sender resolved from students table via auth_user_id; receiver always a teacher or admin
- `src/app/(student)/student/messages/page.tsx` - server component fetching assigned teachers via training_teachers, building contacts list from message history with unread counts
- `src/app/(student)/student/messages/StudentMessagesClient.tsx` - full messaging UI with contacts list, conversation thread, Tiptap rich text composer, real-time Supabase subscription for incoming messages, and new message modal limited to assigned teachers only

### Break/Fix Log
Issue 1: recharts not installed / Build error on ProgressClient.tsx - Module not found: Can't resolve 'recharts' / Ran `npm install recharts` / recharts must be explicitly installed even when used in other parts of the project; it is not a default Next.js dependency

### Session result
Student Portal Steps 8 and 9 are complete. The Progress page displays live training data, a CEFR radar chart, class history stats, and exercise progress. The Messages page is fully functional with real-time updates, Tiptap rich text, and is correctly scoped so students can only message their assigned teachers. Both features are tested and working in the browser. Code pushed to dev branch.

---


## Session 19 - 06 April 2026 - Student Portal Step 7: Past Classes

### What was built
- `src/app/(student)/student/past-classes/page.tsx` - server component fetching all completed, student_no_show, and teacher_no_show lessons for the logged-in student, including teacher details, report data, and existing reviews
- `src/app/(student)/student/past-classes/PastClassesClient.tsx` - searchable past classes list with status tags, review nudge badges, and feedback preview per class card
- `src/app/(student)/student/past-classes/[id]/page.tsx` - server component fetching full lesson detail, assignments, and existing review for a single past class
- `src/app/(student)/student/past-classes/[id]/PastClassDetailClient.tsx` - full detail view including teacher feedback, assigned study sheets, radar/spider chart (recharts, #FF8303) showing CEFR skill levels, and interactive star rating review form
- `src/app/api/student/reviews/route.ts` - POST route handling review submission with auth check, ownership validation, duplicate prevention, and Supabase insert
- `student_reviews` table created in Supabase with RLS enabled and temporary permissive policies (scoped properly in Step 14 hardening pass)

### Break/Fix Log
No issues this session.

### Session result
Student Portal Step 7 is complete. Students can now view all past classes in a searchable list, open a full detail view for any class showing the teacher's written feedback, assigned study sheets, and a radar chart of their assessed CEFR skill levels at that session. After each completed class, students are prompted to leave a star rating and optional written review. Reviews are saved to the student_reviews table and displayed on the teacher's profile via the Teacher Portal. The MS Graph API integration remains stubbed pending the client upgrading to Microsoft 365 Business Standard.

---


## Session 18 - 06 April 2026 - Student Portal Step 6: Booking Flow Complete

### What was built
- `src/app/api/student/book/route.ts` - POST route handling full booking confirmation: validates request, checks hours balance, cancels old lesson on reschedule, creates lesson record with TEAMS_LINK_PENDING placeholder, deducts hours from training, sends confirmation emails to student and teacher via Resend
- MS Graph API integration stubbed with TODO comment - ready to slot in real credentials when the client upgrades to Microsoft 365 Business Standard
- Fixed `BookingClient.tsx` - teacher selection step now always shown (skipTeacherStep = false) per the client's requirement
- Fixed calendar date header timezone bug - day numbers now rendered in student's timezone using Intl.DateTimeFormat instead of getDate()
- Updated Join Class availability window from 15 minutes to 10 minutes (900 → 600 seconds)
- Updated Join Class label text to "available 10 min before"

### Break/Fix Log
Issue 1: Book a Class button redirecting back to My Classes / Cause: training_teachers table had no RLS SELECT policy — Supabase join returned empty array, page redirected as safety measure / Fix: Added SELECT policy with `true` on training_teachers / Lesson: Always audit RLS policies on junction tables, not just main tables

Issue 2: profiles table blocked student from reading teacher data / Cause: Only "Users can view own profile" SELECT policy existed — students couldn't read teacher profile rows / Fix: Added "Students can view teacher profiles" SELECT policy with `true` / Lesson: Teacher profiles are not sensitive - any authenticated user should be able to read them

Issue 3: Booking confirmation returning 500 / Cause: lessons table had no INSERT policy for students / Fix: Added "Students can insert their own lessons" INSERT policy with `true`

Issue 4: Calendar showing TUE 8 but confirm screen showing Tuesday 7 April / Cause: day.getDate() uses browser local timezone (SAST UTC+2) while slots are keyed in student timezone (Europe/London) - 1 day offset / Fix: Replaced getDate() with Intl.DateTimeFormat using studentTimezone

Issue 5: Already-booked slots showing as available in calendar / Cause: lessons table had no SELECT policy - availability API couldn't read existing lessons to block them / Fix: Added "Authenticated users can view lessons" SELECT policy with `true`

Issue 6: Test Student showing 0h remaining / Cause: students.auth_user_id was set to teacher's profile ID instead of the student's actual Supabase auth user ID; training student_id also mismatched / Fix: Corrected both values in Supabase table editor directly

### Session result
Student Portal Step 6 is fully complete. The booking flow works end to end - teacher selection, duration check against hours balance, availability calendar with correct timezone display, confirmation screen, lesson creation in Supabase, hours deduction, and confirmation emails via Resend. MS Graph API is stubbed and ready for credentials. All RLS policy gaps on lessons, profiles, and training_teachers tables have been resolved.

---

## Session 17 - 04 April 2026 - Student Portal Step 6: Booking Flow Foundation

### What was built

- `src/app/(student)/student/my-classes/actions.ts` - cancellation server action replacing the TODO direct Supabase call; handles hours refund logic atomically (>24hrs = refund by decrementing `hours_consumed`, <24hrs = no refund)
- `src/app/(student)/student/my-classes/MyClassesClient.tsx` - updated to import and use `cancelLessonAction` from the new server action; removed direct Supabase client call and `createClient` import
- `src/app/(student)/student/book/page.tsx` - server component fetching student, active training, assigned teachers via `training_teachers`, and reschedule lesson if applicable; redirects if no active training or no teachers assigned
- `src/app/(student)/student/book/BookingClient.tsx` - full multi-step booking UI: Step 1 teacher selection (skipped if only one teacher), Step 2 duration selection with hours balance check, Step 3 availability calendar with week navigation, Step 4 confirmation screen with hours deduction preview
- `src/app/api/student/availability/route.ts` - API route calculating bookable 30-minute slots for a given teacher and week; queries `availability` table (not `availability_templates`), converts teacher's local times to UTC using `Intl.DateTimeFormat` offset calculation, blocks slots covered by overrides and already booked lessons, blocks past slots

### Break/Fix Log

**Issue 1:** Availability API route initially queried `availability_templates` table / Cause: assumed wrong table name before checking / Fix: confirmed via schema query that the Teacher Portal saves to `availability` table with a `type` column distinguishing general vs override records / Lesson: always confirm table names against actual schema before writing queries.

**Issue 2:** Availability times stored as teacher's local time, not UTC / Cause: Teacher Portal `GeneralAvailability.tsx` saves times exactly as displayed on screen with no UTC conversion / Fix: rewrote `localTimeToUtcMs()` helper in the API route to convert teacher's local `HH:MM` time on a specific date to UTC using `Intl.DateTimeFormat` offset detection; handles DST automatically / Lesson: always check how times are saved before building anything that reads them.

**Issue 3:** Test data mismatch - availability records belonged to teacher `03abd97e` but all active trainings pointed to teacher `5285a0bc` / Fix: updated all active trainings to point to `03abd97e`; inserted 4 rows into `training_teachers` table which was empty / Lesson: confirm test data is internally consistent before testing a feature end to end.

### Session result

Completed the foundation of the Student Portal booking flow. The cancellation server action is wired in and working. The multi-step booking UI is built with teacher selection, duration selection, availability calendar, and confirmation screen. The availability API route is built and correctly handles teacher timezone conversion. The booking confirmation server action (Step 6 final piece) was not started - the session ended before confirming whether MS Graph API credentials are set up, which determines how the action is written. That is the starting point for the next session.

---

## Session 16 - 04 April 2026 - Student Portal Steps 3-5

### What was built
- Step 3: Database schema updates - added 6 new columns to `students` table
  (`language_preference`, `learning_goals`, `interests`, `self_assessed_level`,
  `placement_test_result`, `placement_test_taken_at`); altered existing `reviews`
  table to add `class_id`, `moderated_by_admin`, `admin_edited_text` rather than
  creating a duplicate table; created `exercise_completions` table with RLS and
  4 policies; added 2 student-facing RLS policies to `reviews`
- Step 4: Verified layout shell was already complete from Step 2 - no changes needed
- Step 5: `src/app/(student)/student/my-classes/page.tsx` - server component
  fetching upcoming lessons with teacher info, last completed lesson feedback
- Step 5: `src/app/(student)/student/my-classes/MyClassesClient.tsx` - full
  client component with next class card, real-time countdown, join class button
  (active 15 min before), reschedule/cancel with 24-hour rule, inline warning
  modal for within-24hr cancellations, grouped upcoming classes list with
  expand/collapse, hide cancelled toggle
- Step 5: `src/app/(student)/student/layout.tsx` - updated to fetch next lesson,
  active training, and exercise counts for right panel
- Step 5: `src/components/student/layout/StudentRightPanel.tsx` - live data wired
  in: real-time countdown, join button, hours remaining with low balance warning,
  training end date, exercises progress bar

### Break/Fix Log
No issues this session.

### Session result
Completed database schema updates for the Student Portal and built the My Classes
dashboard. The page renders correctly with empty state handling for students with
no active training or upcoming lessons. All cancellation logic and 24-hour rule
enforcement is in place. Booking flow (Step 6) is next.

---


## Session 15 - 04 April 2026 - Student Portal Step 2: Authentication

### What was built
- `src/app/(student-auth)/student/login/actions.ts` - login server action with Supabase sign-in and role check; teachers blocked by querying `students` table for matching `auth_user_id`; deactivated students blocked at this layer too
- `src/app/(student-auth)/student/login/page.tsx` - student login page; Lingualink Orange branding, error display, forgot password link, teacher portal redirect at bottom
- `src/app/(student-auth)/student/forgot-password/actions.ts` - sends Supabase password reset email with redirect to `/student/reset-password`; always returns success regardless of whether email exists (security best practice)
- `src/app/(student-auth)/student/forgot-password/page.tsx` - forgot password page with success state
- `src/app/(student-auth)/student/reset-password/page.tsx` - reset password page; client component that listens for Supabase `PASSWORD_RECOVERY` event before showing form; handles first-time password setup for new students Shannon invites
- `src/proxy.ts` - updated to exclude `/student/forgot-password` and `/student/reset-password` from auth protection; removed authenticated-student redirect that was causing a redirect loop
- `src/app/(student)/student/layout.tsx` - added `is_active` check; deactivated students redirected to login even with a valid session
- `src/components/student/layout/StudentLeftNav.tsx` - corrected nav colours to match teacher portal (white background, grey border, dark text)
- `src/components/student/layout/StudentRightPanel.tsx` - corrected Chat with Admin button from black to #FF8303

### Break/Fix Log
Issue 1: `createServerSupabaseClient` does not exist / Cause: Wrong function name used - the project uses `createClient` from `@/lib/supabase/server` / Fix: Corrected import in both `login/actions.ts` and `forgot-password/actions.ts` / Lesson: Always check the actual export name in `src/lib/supabase/server.ts` before writing server actions.

Issue 2: `ERR_TOO_MANY_REDIRECTS` on `/student/login` / Cause: Proxy was redirecting authenticated users from `/student/login` to `/student/my-classes`, but the layout then redirected back because the logged-in user was a teacher with no student record / Fix: Removed the authenticated-student redirect from proxy - the layout handles it correctly / Lesson: The proxy cannot distinguish teacher sessions from student sessions; role checks belong in the layout.

Issue 3: Repeated `Unexpected token` / `Unterminated regexp literal` parse errors in TSX files / Cause: Special characters (`←`, `…`, `••••••••`) were silently corrupted during copy-paste from chat into Cursor / Fix: Generated all affected files as downloads and replaced them cleanly; removed all special characters from source / Lesson: For any file containing special characters, always use the download approach - never paste directly.

Issue 4: `forgot-password` folder placed inside `login` folder / Cause: Manual folder creation error / Fix: Moved folder up one level to sit alongside `login` under `(student-auth)/student/`

Issue 5: `StudentRightPanel.tsx` overwritten with forgot-password page code / Cause: Download file pasted into the wrong file in Cursor / Fix: Regenerated correct `StudentRightPanel.tsx` as a download and replaced

Issue 6: Student portal nav rendered with black background (#1a1a1a) / Cause: `StudentLeftNav.tsx` was created in Step 1 with a dark sidebar - colour consistency rule was not yet established / Fix: Updated to white background with grey border matching teacher portal; colour rule now saved to memory and applies to all future portals

### Session result
Student Portal Step 2 is complete. The authentication system is fully functional — students can log in, reset their password, and set a new password via email link. The role check correctly blocks teachers from accessing the student portal. A test student account was created in Supabase to verify all flows. The student portal shell now matches the teacher portal colour scheme exactly. A hard colour consistency rule has been saved to memory and applies to all future portal components including the Admin portal.

---

## Session 14 - 04 April 2026 - Student Portal Step 1: Shell & Navigation

### What was built
- Updated `src/proxy.ts` to protect all `/student/*` routes - unauthenticated users are redirected to `/student/login`
- Created route group `src/app/(student)/student/` with `layout.tsx` - validates session, fetches student record by `auth_user_id`, and renders the three-panel shell
- Created route group `src/app/(student-auth)/student/login/` with stub `page.tsx` — placeholder replaced in Step 2
- Created placeholder `page.tsx` files for all 6 student nav pages: `my-classes`, `past-classes`, `progress`, `messages`, `study`, `account`
- Created `src/components/student/layout/StudentLeftNav.tsx` - dark sidebar with orange active state using inline style props (Tailwind v4 pattern)
- Created `src/components/student/layout/StudentTopHeader.tsx` - orange header bar with greeting and profile photo linking to My Account
- Created `src/components/student/layout/StudentRightPanel.tsx` - placeholder shell for right panel (live countdown, hours balance, and exercises progress wired in Step 5)

### Break/Fix Log
Issue 1: Module not found error on `StudentLeftNav` / Cause: File was placed in `src/components/layout/` (teacher folder) instead of `src/components/student/layout/` / Fix: Moved file to correct folder using PowerShell `Move-Item` command / Lesson: Always verify file landed in the correct folder after creating it in Cursor.

Issue 2: `ERR_TOO_MANY_REDIRECTS` on `/student/my-classes` / Cause: Middleware was redirecting authenticated teacher sessions away from `/student/login` back to `/student/my-classes`, creating an infinite loop / Fix: Removed the `/student/login` redirect from `proxy.ts` - this will be added back correctly in Step 2 once role-based checking is in place / Lesson: Login redirect logic must account for role - being authenticated is not the same as being authenticated as the right role.

### Session result
Student Portal Step 1 is complete. The shell is in place - the three-panel layout renders correctly, all six nav routes exist, and the middleware correctly protects student routes from unauthenticated access. The teacher portal is unaffected. The dev server runs clean with no TypeScript errors. All changes committed and pushed to the dev branch. Step 2 (authentication) begins in the next session.


---

## Session 13 - 03 April 2026 - My Account

### What was built
- `src/app/(dashboard)/account/page.tsx` - server component fetching profile, resources, and reviews for the current user
- `src/app/(dashboard)/account/AccountClient.tsx` - full My Account page with four tabs: General Info, Professional Info, Useful Resources, Student Feedback
- `resources` table - admin-managed useful links with RLS policies (all authenticated users read, admin manages)
- `reviews` table - student feedback and star ratings per teacher with RLS policies
- `avatars` Supabase Storage bucket — public bucket for profile photos with per-user upload policies
- Profile photo upload - validates type (JPG/PNG/WebP) and size (max 2MB), stores at `avatars/{userId}/avatar.{ext}`, cache-busts URL on upload
- Tag input component - keyboard-friendly add/remove for teaching and speaking languages (stored as arrays)
- Timezone selector - drives all class time display for the teacher
- Student feedback tab - average rating summary card, per-review cards with student photo and date
- "See My Public Profile" button in page header - opens a modal showing exactly what students will see: photo, name, star rating, languages, bio, and up to 3 reviews. Modal reflects unsaved changes in real time
- Toast notification system - success and error feedback on all save actions

### Break/Fix Log
Issue 1: Missing shadcn textarea component
- Symptom: Build error - `Module not found: Can't resolve '@/components/ui/textarea'`
- Cause: `textarea` shadcn component had not been added to the project
- Fix: Ran `npx shadcn@latest add textarea` in Terminal 2
- Lesson: shadcn components must be explicitly added before use - they are not auto-available from the package install

Issue 2: Console warning on tab buttons
- Symptom: React warning about conflicting `borderBottom` shorthand and `borderBottomWidth`/`borderBottomStyle` properties on tab buttons
- Cause: Both the shorthand `borderBottom` and individual `borderBottom*` properties were set simultaneously in the same style object
- Fix: Removed the shorthand entirely, replaced with explicit `borderTop/Left/Right: 'none'` and individual `borderBottomWidth`, `borderBottomStyle`, `borderBottomColor` properties
- Lesson: Never mix CSS shorthand and longhand properties for the same value in React inline styles

Issue 3: Security tab removed per the client's request
- Symptom: The client does not want teachers to be able to change their own passwords
- Cause: Business decision - if a teacher leaves the company, the client needs control over account access
- Fix: Removed Security tab entirely. Password changes will be handled by the client via admin controls in a future session
- Lesson: Always confirm with the client before building self-service features that could affect account security

### Session result
Step 13 is complete. Teachers can now manage their own profile including photo upload, timezone, teaching languages, bio, and view their public-facing profile preview. The Useful Resources and Student Feedback tabs are wired to live database tables and will populate as the client adds resources and students leave reviews. Password management is admin-only by design. Microsoft 365 subscription noted as needing upgrade from Family to Business Standard before the Teams Graph API integration can be built in the Student Portal phase.

---


## Session 12 - 03 April 2026 - Billing & Invoices

### What was built
- `src/app/(dashboard)/billing/page.tsx` - server component, fetches profile and passes to client
- `src/app/(dashboard)/billing/BillingClient.tsx` - full billing UI with three views: My Invoices, My Billing Info (read-only), Admin View
- `invoices` table - added `reference_number` unique column
- `profiles` table - added billing info columns: `preferred_payment_type`, `paypal_email`, `iban`, `bic`, `tax_number`, `street_address`, `area_code`, `city`
- `profiles` table - added `hourly_rate numeric` column for auto-calculating invoice amounts
- `settings` table - created with RLS policies for admin-managed key/value config (used for invoice template path)
- Supabase Storage - created `invoices` (private) and `templates` (public) buckets with full RLS policies
- Invoice amount auto-calculation: `(duration_minutes / 60) × hourly_rate` summed across all billable lessons per month, written to `amount_eur` on every page load
- System auto-generates a unique reference number (e.g. `INV-202604-XXXX`) for each teacher on the 1st of every month
- PDF upload flow: teachers upload invoice PDF within 1st–10th window; stored at `invoices/{teacher_id}/{year}-{month}.pdf`
- PDF viewing via Supabase signed URLs (60-second expiry) for both teachers and admin
- Admin View: the client sees all teachers' invoices grouped by teacher, can view PDFs, mark invoices as paid with auto-calculated amount confirmation
- Admin template management: the client uploads Lingualink branded PDF template; stored in public `templates` bucket, path saved in `settings` table
- My Billing Info: read-only display for teachers; editing deferred to Step 13 teacher profile

### Break/Fix Log

**Issue 1: Invoice amount required manual entry**
- Symptom: Original design asked teachers to type their invoice total before uploading
- Cause: No hourly rate stored in the system; no auto-calculation logic
- Fix: Added `hourly_rate numeric` to profiles table; rewrote billing logic to calculate amounts automatically from completed and student_no_show lessons × hourly rate; removed amount input entirely
- Lesson: Always trace where a displayed number comes from before building the UI around it

**Issue 2: Billing info was editable by teachers**
- Symptom: First version included an editable form for IBAN, BIC, PayPal etc.
- Cause: Brief says that the client updates billing info per teacher - not teachers themselves
- Fix: Replaced editable form with read-only display; billing info editing moved to teacher profile in Step 13
- Lesson: Re-read who owns each piece of data before building edit controls

### Session result
Step 12 is complete. The billing system auto-generates monthly invoice records with unique reference numbers, calculates amounts live from lesson data using each teacher's hourly rate, handles PDF uploads within the correct window, and gives the client a clean admin view to manage all teacher invoices and mark payments. The `hourly_rate` field exists in the schema but will be populated through the teacher profile UI in Step 13, at which point invoice amounts will calculate correctly for all teachers.

---


## Session 11 - 3 April 2026 - Study Sheets & Exercises

### What was built
- `src/app/(dashboard)/study-sheets/page.tsx` - server component fetching all active study sheets
- `src/app/(dashboard)/study-sheets/StudySheetsClient.tsx` - list page with search, level filter, category filter, chilli pepper difficulty display, and row navigation
- `src/app/(dashboard)/study-sheets/[id]/page.tsx` - server component fetching individual sheet and its exercises
- `src/app/(dashboard)/study-sheets/[id]/StudySheetDetailClient.tsx` - detail page with vocabulary table, exercise cards with multiple choice interactions, correct/incorrect colour states, and amber explanation box
- `src/app/(dashboard)/study-sheets/new/page.tsx` - admin-only guard page for content creation
- `src/app/(dashboard)/study-sheets/new/StudySheetFormClient.tsx` - full content creation form for the client: title, category, level, difficulty, vocabulary word rows, and multiple choice exercise builder with radio button correct answer selection
- `src/components/shared/AssignStudySheetsModal.tsx` - shared modal component for assigning study sheets to a student from within a class report; supports search, category and level filters, multi-select with checkbox UI, preview link per sheet, and saves/removes assignments to the assignments table
- `src/app/(dashboard)/reports/[id]/ReportFormClient.tsx` - updated to accept assignedSheetIds prop, wire in the assignment modal, and display assigned sheet count
- `src/app/(dashboard)/reports/[id]/page.tsx` - updated to query existing assignments for the lesson and pass IDs to the form
- RLS policies added: INSERT/UPDATE/DELETE on study_sheets and exercises for admins; SELECT/INSERT/DELETE on assignments for authenticated users

### Break/Fix Log
**Issue 1: Build errors from corrupted special characters**
- Symptom: "Unexpected token. Did you mean {'>'} or &gt;?" on multiple files
- Cause: Special characters (← arrow, opening `<a` tags) were dropped or corrupted during copy-paste from chat into Cursor
- Fix: Generated clean file downloads instead of relying on copy-paste; replaced files directly from download
- Lesson: For large files with special characters, always download and replace rather than copy-paste from chat

**Issue 2: No pending report available for testing**
- Symptom: Only a flagged report existed in the database; could not test the assignment modal
- Cause: Test data was insufficient
- Fix: Manually inserted a test lesson and pending report via Supabase SQL editor
- Lesson: Keep at least one pending report in the test dataset at all times during active development

### Session result
Step 11 is complete. The study sheets library is fully functional - the client can create vocabulary and grammar sheets with exercises via the admin form, teachers can browse and filter the library, and the assignment modal is wired into the class report form allowing teachers to assign sheets to students mid-report. All data is persisted correctly to Supabase with RLS policies in place. The next step is Step 12 - Billing & Invoices.

---

## Session 10 - 02 April 2026 - Messages & Email Notifications

### What was built
- `src/app/(dashboard)/messages/page.tsx` - server component fetching message history, building contacts map with unread counts, fetching student/profile details
- `src/app/(dashboard)/messages/MessagesClient.tsx` - full messaging UI: contacts list, conversation thread, Tiptap rich text composer (Bold, Italic, Underline), new message modal, realtime subscription via Supabase
- `src/app/(dashboard)/messages/actions.ts` - sendMessage and markMessagesAsRead server actions with Resend email notification on every new message
- `src/lib/email/client.ts` - shared Resend client instance
- `src/lib/email/templates.ts` - branded HTML email template builder and new message content function
- `src/components/layout/LeftNav.tsx` - unreadMessageCount prop wired to real data, badge hidden when zero
- `src/app/(dashboard)/layout.tsx` - unread count query added, passed to LeftNav
- RLS policies added to messages table (SELECT, INSERT, UPDATE)
- Fixed receiver_type constraint to include 'admin'

### Break/Fix Log
**Issue 1**
- Symptom: Tiptap SSR hydration mismatch error on page load
- Cause: useEditor runs during server-side render without immediatelyRender: false set
- Fix: Added immediatelyRender: false to useEditor config
- Lesson: Always set immediatelyRender: false when using Tiptap in Next.js App Router

**Issue 2**
- Symptom: Clicking empty space in message composer box did not focus the editor
- Cause: Tiptap EditorContent only occupies the text content area, not the full container div
- Fix: Added onClick={() => editor?.commands.focus()} and cursor-text to the container div
- Lesson: When wrapping Tiptap in a styled container, always forward clicks to the editor

**Issue 3**
- Symptom: Tiptap warning — duplicate extension names for 'underline'
- Cause: StarterKit includes its own underline extension by default
- Fix: Added StarterKit.configure({ underline: false }) to disable the built-in one
- Lesson: When adding individual Tiptap extensions, always check if StarterKit already includes them and disable the duplicate

**Issue 4**
- Symptom: React hydration mismatch on message timestamps
- Cause: Server rendered time in 24hr format, client rendered in 12hr format due to locale differences
- Fix: Replaced toLocaleTimeString() with manual HH:MM string construction using padStart
- Lesson: Never use toLocaleTimeString() in components that render on both server and client - locale differences cause hydration failures

### Session result
Built the full in-portal messaging system and wired up the Resend email layer in a single session. Teachers can start conversations with students, send rich text messages with bold, italic, and underline formatting, and see their full message history with real-time updates. The unread badge in the left nav reflects live data from Supabase. On every new message, the recipient receives a branded Lingualink Online email with a direct link to the Messages page — confirmed working via the Resend dashboard. The same email template infrastructure will be reused for class reminders, report overdue alerts, and invoice reminders in later steps.

---

## Session 9 - 02 April 2026 - Students & Trainings

### What was built
- `src/app/(dashboard)/students/page.tsx` - server component fetching all trainings with joined student and teacher data, split into current and past, role-aware (admin sees all, teacher sees own)
- `src/app/(dashboard)/students/StudentsClient.tsx` - two-column layout with Current Trainings and Past Trainings, student cards showing hours progress bar, package type, end date, and initials avatar, searchable per column
- `src/app/(dashboard)/students/[id]/page.tsx` - server component fetching individual training detail with joined lessons and completed reports, access-controlled by role
- `src/app/(dashboard)/students/[id]/StudentDetailClient.tsx` - 4-tab student detail page: General Info (hours summary cards, progress bar, training details grid, editable notes), Next Classes (upcoming lessons with Join button and status badge), Past Classes (reverse chronological with report status badges and feedback snippets), Messages (placeholder for Step 10)

### Break/Fix Log
**Issue 1**
- Symptom: Error fetching trainings - PGRST201 ambiguous relationship between trainings and profiles
- Cause: Two foreign key relationships exist between trainings and profiles (direct teacher_id FK and the training_teachers junction table), so Supabase could not determine which to use
- Fix: Changed `profiles` to `profiles!trainings_teacher_id_fkey` in the Supabase select query to explicitly target the correct relationship
- Lesson: When a table has multiple relationships to another table, Supabase requires the FK name to be specified explicitly in the select query

**Issue 2**
- Symptom: Students & Trainings page returned 0 results despite data existing in the database
- Cause: RLS was enabled on the trainings table but no policies had been created, causing all queries to return empty silently
- Fix: Created four RLS policies - admin select all, teacher select own, admin insert, admin update
- Lesson: Always create RLS policies immediately after enabling RLS on a table. Missing policies fail silently and return empty results rather than an error, making them easy to overlook

**Issue 3**
- Symptom: Build error - Expected a semicolon at the href attribute of an anchor tag
- Cause: The opening `<a` tag was dropped during copy-paste, leaving bare attributes with no element
- Fix: Replaced the entire file using a downloaded file rather than a manual paste to eliminate copy-paste truncation risk
- Lesson: For large files, use file download and full replacement rather than copy-paste to avoid silent truncation errors

### Session result
Built the complete Students & Trainings feature including the main two-column training list and the four-tab individual student detail page. Resolved an RLS misconfiguration that was silently blocking all training data from loading, and fixed a Supabase ambiguous relationship error by specifying the explicit foreign key name in the query. All four tabs render correctly and the page is access-controlled so teachers only see their own students while admin sees all.

---

## Session 8 - 02 April 2026 - CI/CD Fixes, Environment Variables and TypeScript Errors

### What was built
- Environment variables added to Vercel project settings (Production, Preview, Development)
- Environment variables added to GitHub Actions repository secrets
- `.github/workflows/ci.yml` updated to pass secrets to the build step
- TypeScript array type errors fixed on `reports/page.tsx`, `reports/[id]/page.tsx`, and `upcoming-classes/page.tsx` - Supabase nested joins return arrays which needed flattening before passing to client components
- `GeneralAvailability.tsx` fixed - missing `start_at` and `end_at` fields added to temp record type

### Break/Fix Log

**Issue 1**
- Symptom: CI pipeline failing on every push, Vercel deployment failing
- Cause: Neither GitHub Actions nor Vercel had the environment variables needed to build the app
- Fix: Added all five variables to Vercel via import, added all five as GitHub Actions repository secrets, updated ci.yml to pass them to the build step
- Lesson: Environment variables must be explicitly configured in every environment the app runs in - local, CI, and hosting

**Issue 2**
- Symptom: TypeScript build errors on reports and upcoming classes pages
- Cause: Supabase returns nested joined relations as arrays even when only one record is expected - our types assumed single objects
- Fix: Added flattening logic using `Array.isArray()` checks before passing data to client components
- Lesson: Always flatten Supabase nested joins before using them - treat all joined relations as potentially arrays regardless of the relationship type

### Session result
Fixed the CI/CD pipeline which had been failing since the Class Reports build. Root causes were missing environment variables in both Vercel and GitHub Actions, and TypeScript type mismatches caused by Supabase returning nested joins as arrays. All issues resolved - CI is now green and Vercel preview deployments are working correctly on every push to dev.



---

## Session 7 - 01 April 2026 - Class Reports Page, Auto-Flagging, Admin Reopen & Font Switch

### What was built
- `src/app/(dashboard)/reports/page.tsx` - server component fetching reports with joined lesson, student and teacher data from Supabase
- `src/app/(dashboard)/reports/ReportsClient.tsx` - reports list page with pending reports (soft yellow cards, deadline countdown) and completed reports (searchable, status badges)
- `src/app/(dashboard)/reports/[id]/page.tsx` - dynamic route server component fetching a single report by ID
- `src/app/(dashboard)/reports/[id]/ReportFormClient.tsx` - full report form with Yes/No toggle, feedback box with character counter, CEFR level assessment grid (7 skills × 11 levels), no-show type selection with business rule messages, additional details field, read-only state for submitted reports
- `src/app/(dashboard)/reports/actions.ts` - server action for admin reopen functionality
- RLS policies on `public.reports` table - teachers see own reports, admins see all
- `public.flag_overdue_reports()` PostgreSQL function - flips pending reports to flagged when deadline_at has passed
- pg_cron job `flag-overdue-reports` - runs every 15 minutes automatically, no external server required
- `src/app/layout.tsx` - switched font from Poppins to Inter
- `src/app/globals.css` - updated `--font-sans` to use Inter variable, set base font size to 15px

### Break/Fix Log

**Issue 1**
- Symptom: Reports folder returned 404
- Cause: Folder was named `Reports` with a capital R
- Fix: Renamed to lowercase `reports`
- Lesson: Next.js route folders must be lowercase

**Issue 2**
- Symptom: ReportsClient.tsx failed to parse with "Unexpected token" error
- Cause: Long className string was truncated during copy-paste, breaking JSX syntax
- Fix: Rebuilt the file with className strings split across array joins to prevent truncation
- Lesson: For long className strings use array join pattern or inline styles - never rely on long single-line strings surviving copy-paste

**Issue 3**
- Symptom: Yes and No buttons became invisible when selected
- Cause: Tailwind v4 does not apply dynamically constructed colour classes at runtime
- Fix: Replaced all dynamic colour classes with inline `style` props for selected states across all interactive buttons
- Lesson: Any button or element whose colour changes based on state must use inline styles in this project - Tailwind v4 dynamic classes are unreliable throughout

**Issue 4**
- Symptom: globals.css build error after attempting to add font size
- Cause: `@layer base` block was accidentally placed inside the `@theme inline` block during manual editing, then the file structure was further corrupted on a second edit attempt
- Fix: Replaced the entire globals.css file cleanly with correct structure - `@layer base` placed after the closing brace of `@theme inline`
- Lesson: Never manually edit inside globals.css - always replace the whole file to avoid bracket mismatches

### Session result
Built the complete Class Reports feature including the reports list page, full report form with CEFR level assessment, automatic 12-hour deadline flagging via pg_cron, and admin reopen functionality. All flows tested end to end — pending reports appear correctly, the form submits and redirects, flagging works on demand and will run automatically every 15 minutes in production, and admin reopen moves a flagged report back to pending instantly. Also switched the portal font from Poppins to Inter at 15px base size, significantly improving readability and the overall professional feel of the UI.


---

## Session 6 - 01 April 2026 - Schedule & Availability Page

### What was built
- `public.availability` table created in Supabase with RLS policies (teachers manage own availability, admins manage all)
- Unique constraint added to prevent duplicate general slots per teacher/day/time
- `src/app/(dashboard)/schedule/page.tsx` - server component fetching availability from Supabase
- `src/app/(dashboard)/schedule/ScheduleClient.tsx` - tab shell with manual tab implementation (replaced shadcn Tabs due to Tailwind v4 incompatibility)
- `src/app/(dashboard)/schedule/tabs/GeneralAvailability.tsx` - weekly recurring grid with click and click-drag multi-select, instant visual feedback, batch save to Supabase on mouse release
- `src/app/(dashboard)/schedule/tabs/DayToDay.tsx` - FullCalendar week view with recurring availability as background tint, specific available/unavailable blocks, booked classes with student names, Add Availability/Unavailability mode buttons, now indicator (current time red line), 30-minute slot increments
- `src/app/(dashboard)/schedule/tabs/Holidays.tsx` - date range picker, validation, planned unavailability list with delete, warning banner about existing bookings
- `src/components/layout/TopHeader.tsx` - updated to solid Lingualink orange (#FF8303) background with white text and logo

### Break/Fix Log

**Issue 1**
- Symptom: ScheduleClient.tsx threw a parse error on load
- Cause: Instructional text from chat was accidentally pasted into the file alongside the code
- Fix: Replaced entire file with clean code only
- Lesson: Always verify file contents after pasting - editor gives no warning if non-code text is present

**Issue 2**
- Symptom: shadcn Tabs component rendered unstyled with labels merging together
- Cause: Tailwind v4 does not apply shadcn component styles reliably without additional configuration
- Fix: Replaced shadcn Tabs with a manually built tab implementation using plain buttons and state
- Lesson: shadcn components may need extra setup with Tailwind v4 - when a component misbehaves visually, a manual implementation is faster than debugging the CSS pipeline

**Issue 3**
- Symptom: General availability slots switching tabs wiped data from other tabs
- Cause: Each tab was receiving only its filtered slice of the availability array and passing that slice back to the parent on save, overwriting all other records
- Fix: All tabs now receive the full availability array and merge their changes back into the full list before calling onAvailabilityChange
- Lesson: When multiple components share a parent state, every component must be aware of the full state - never pass a filtered subset and expect it to merge correctly on the way back up

**Issue 4**
- Symptom: General availability times appearing incorrectly on Day to Day calendar (e.g. Monday showing 6:00 - 2:00)
- Cause: toISOString() converts dates to UTC before returning a string - in Cape Town (UTC+2) this shifts the date backward, placing slots on the wrong day and wrong time
- Fix: Replaced toISOString() with a toLocalDateStr() function that builds the date string directly from local date parts, bypassing UTC conversion entirely. Added timeZone="local" to FullCalendar
- Lesson: Never use toISOString() when working with local dates. Cape Town is UTC+2 so any date operation using UTC will be off by 2 hours - enough to shift a slot to the previous day late at night

**Issue 5**
- Symptom: Monday column appeared darker than other days on Day to Day calendar
- Cause: Drag testing created duplicate general slots for Monday in the database - stacked background events multiplied the opacity of the tint
- Fix: Deleted duplicates via SQL (keeping one record per unique teacher/day/start/end combination), then added a UNIQUE constraint to prevent recurrence
- Lesson: Always add database-level constraints to enforce business rules - application-level checks alone are not enough if data can be written from multiple places

### Session result
Built the complete Schedule & Availability page across three tabs. General Availability uses a custom click-and-drag weekly grid that saves recurring slots directly to Supabase. Day to Day uses FullCalendar with timezone-safe date handling for Cape Town, showing recurring availability as a background tint and booked classes with student names. Holidays provides a date range picker with validation and a deletable planned unavailability list. A database unique constraint was added after duplicate slots were discovered during testing. The top header was updated to solid Lingualink orange across all pages.

---


## Session 5 - 01 April 2026 - Upcoming Classes Page with Live Data

### What was built
- `src/app/(dashboard)/upcoming-classes/page.tsx` - server component that fetches upcoming classes from Supabase and passes data to the client component
- `src/app/(dashboard)/upcoming-classes/UpcomingClassesClient.tsx` - client component rendering collapsible day groups, class cards, live countdown timers, expand/collapse chevrons, and action buttons (Reschedule, Chat, Join Class)
- `public.classes` table created in Supabase with RLS policies (teachers see own classes, admins see all)
- `teacher_id` column added to existing `public.trainings` table via ALTER TABLE
- Test data seeded: 2 students (Marie Dubois, Hans Müller), 2 trainings, 3 upcoming classes linked to the logged-in teacher

### Break/Fix Log

**Issue 1**
- Symptom: Seed data failed with `column "teacher_id" of relation "trainings" does not exist`
- Cause: The trainings table was created in a previous session without the teacher_id column
- Fix: Used `ALTER TABLE public.trainings ADD COLUMN teacher_id uuid references public.profiles(id)` to add the missing column
- Lesson: When tables already exist from a previous session, check their structure before running inserts that depend on new columns

**Issue 2**
- Symptom: Build error - `Expected a semicolon` at the href attribute inside the Join Class anchor tag
- Cause: Pasting code from chat into Cursor corrupted the curly brace characters inside JSX attributes
- Fix: Replaced the anchor tag with a button using `window.open()` in an onClick handler, which avoided the problematic JSX attribute syntax entirely
- Lesson: When the same paste error occurs twice, change the approach rather than re-pasting the same code

**Issue 3**
- Symptom: Collapse chevron arrows rendering as huge oversized icons
- Cause: Tailwind v4 does not reliably constrain SVG size with `w-4 h-4` utility classes
- Fix: Extracted chevrons into a dedicated `ChevronIcon` component using explicit `width="16" height="16"` HTML attributes and inline `style` for rotation, bypassing Tailwind entirely for SVG sizing
- Lesson: In Tailwind v4, always use explicit width/height attributes on SVGs rather than utility classes

### Session result
Built the first real feature page of the LinguaLink portal - the Upcoming Classes dashboard. The page fetches live data from Supabase, groups classes by day, displays collapsible day sections and individual class cards with real-time countdown timers. Three test students and classes were seeded into the database to validate the full data flow from Supabase through to the UI. All changes pushed to the dev branch on GitHub.

---

## Session 4 - 1 April 2026 - Brand Colours, Layout Shell & Navigation

### What was built
- Brand colours registered in `src/app/globals.css` under the `@theme inline` block using Tailwind v4 syntax — `brand-orange`, `brand-orange-light`, `brand-red`, `brand-yellow`, `brand-yellow-light`, `brand-grey`
- Dashboard layout created at `src/app/(dashboard)/layout.tsx` - fetches the authenticated user's profile from Supabase server-side and passes name, photo URL, and role down to all layout components. Automatically wraps every page inside the `(dashboard)` route group
- Left navigation component created at `src/components/layout/LeftNav.tsx` - all 9 nav items with icons, active route highlighted in Lingualink orange, Admin Controls visible to admin role only, unread badge on Messages, Log Out button pinned to the bottom
- Top header component created at `src/components/layout/TopHeader.tsx` - logo placeholder on the left, first name greeting and profile photo on the right, photo links to My Account
- Right panel component created at `src/components/layout/RightPanel.tsx` - real-time countdown timer to next class using `setInterval`, Join Class button logic set to appear 15 minutes before class, billing summary section, What's New section, Help & Support section
- Middleware file renamed from `src/middleware.ts` to `src/proxy.ts` and exported function renamed from `middleware` to `proxy` to comply with Next.js 16 requirements
- Layout shell confirmed working in browser - all components rendering correctly with Lingualink branding
- All code committed and pushed to GitHub on dev branch

### Break/Fix Log

**Issue 1**
- Symptom: `tailwind.config.ts` not found in project root
- Cause: Project uses Tailwind v4, which removed the config file entirely and moved all configuration into CSS
- Fix: Added brand colour variables directly to the `@theme inline` block in `src/app/globals.css` instead
- Lesson: Always check the Tailwind version before looking for a config file - v4 works differently from v3

**Issue 2**
- Symptom: Dev server warning on startup - "The middleware file convention is deprecated. Please use proxy instead"
- Cause: Next.js 16 renamed `middleware.ts` to `proxy.ts` and requires the exported function to also be named `proxy`
- Fix: Renamed the file using `mv src/middleware.ts src/proxy.ts` and updated the exported function name from `middleware` to `proxy`
- Lesson: Renaming the file alone is not enough - the exported function name must also be updated to match

**Issue 3**
- Symptom: `git push` rejected with "Updates were rejected because the remote contains work that you do not have locally"
- Cause: JOURNAL.md had been edited directly on GitHub the night before, so the remote branch was ahead of local
- Fix: Ran `git pull origin dev` to pull and merge the remote changes, then pushed successfully
- Lesson: Always pull before pushing if you have edited any files directly on GitHub

### Session result
Brand colours registered and available across the entire project, layout shell fully built and confirmed working in the browser with correct Lingualink branding, role-based nav filtering working correctly for the client's admin account, and all code pushed to GitHub on the dev branch.

---

## Session 3 - 31 March 2026 - Supabase Client, Database Schema & Authentication

### What was built
- Supabase browser client created at `src/lib/supabase/client.ts`
- Supabase server client created at `src/lib/supabase/server.ts`
- Middleware created at `src/middleware.ts` — refreshes user sessions on every request and handles route protection
- Full database schema written and executed in Supabase SQL Editor - 13 tables created: `profiles`, `students`, `trainings`, `training_teachers`, `lessons`, `reports`, `study_sheets`, `exercises`, `assignments`, `availability_templates`, `availability_overrides`, `invoices`, `messages`
- Row Level Security (RLS) enabled on all 13 tables with policies ensuring teachers can only access their own data
- Automatic profile creation trigger set up — a profile row is created in the `profiles` table whenever a new auth user is added
- Login page built at `src/app/(auth)/login/page.tsx` with Lingualink branding - orange button, Poppins font, grey background
- Server action for authentication created at `src/app/(auth)/login/actions.ts`
- Placeholder dashboard page created at `src/app/(dashboard)/dashboard/page.tsx`
- Poppins font added to global layout in `src/app/layout.tsx`
- The client's test user created in Supabase Auth, profile updated to role `admin`
- Login tested and confirmed working end-to-end
- All code committed and pushed to GitHub on dev branch

### Break/Fix Log

**Issue 1**
- Symptom: Build error on the login page - `Module not found: Can't resolve '@/components/ui/card'`
- Cause: shadcn/ui components are not installed automatically - each component must be added individually using the CLI
- Fix: Ran `npx shadcn@latest add card button input label` in a second terminal while the dev server was still running in the first
- Lesson: Always install shadcn/ui components before importing them. Initialising shadcn does not pre-install any components

**Issue 2**
- Symptom: PowerShell threw an error when running `ls src/app/(auth)/`
- Cause: PowerShell interprets brackets as command syntax, not as part of a file path
- Fix: Wrapped the path in single quotes - `ls 'src/app/(auth)/'`
- Lesson: On Windows PowerShell, always quote paths that contain parentheses

**Issue 3**
- Symptom: Dashboard displayed Role: teacher for the client instead of Role: admin
- Cause: The database trigger creates the profile row automatically when a user is added, but defaults the role to `teacher` - it has no way of knowing the intended role
- Fix: Manually edited the client's row in the Supabase Table Editor and set the role field to `admin`
- Lesson: After creating an admin user in Supabase Auth, always manually update their role in the profiles table immediately after

### Session result
Supabase client fully configured, all 13 database tables live, authentication working end-to-end with role-based access confirmed, login page styled in Lingualink branding, and all code pushed to GitHub.

---

## Session 2 - 31 March 2026 - Next.js Initialisation

### What was built
- Backed up `.env.local` before initialisation to avoid losing credentials
- Moved conflicting files (`.env.local`, `.github/`, `README.md`) out of the project folder temporarily to allow Next.js to initialise cleanly
- Initialised Next.js 16.2.1 with TypeScript, Tailwind CSS, ESLint, App Router, and src directory
- Installed Supabase packages: `@supabase/supabase-js` and `@supabase/ssr`
- Installed Sentry: `@sentry/nextjs`
- Initialised shadcn/ui with the Nova preset
- Created full folder structure inside `src/`: `app/(auth)/login`, `app/(dashboard)`, `app/api`, `components/layout`, `components/shared`, `hooks`, `lib`, `types`
- Restored `.env.local` with all 7 variables correctly named and prefixed: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `SENTRY_DSN`, `NEXT_PUBLIC_APP_URL`, `NODE_ENV`
- Confirmed app running at `localhost:3000`
- Pushed to GitHub, CI passing green on dev branch

### Break/Fix Log

**Issue 1**
- Symptom: `npx create-next-app` refused to run, reporting that the directory contained conflicting files
- Cause: `.env.local`, `.github/`, and `README.md` already existed in the project folder from the previous session
- Fix: Used `Move-Item` in PowerShell to temporarily move all three files out of the folder, ran the initialisation, then moved them back with `Move-Item -Force`
- Lesson: `create-next-app` cannot initialise into a folder that already contains files it expects to create - always move conflicting files out first when initialising into an existing repo

**Issue 2**
- Symptom: `mkdir` commands for `(auth)` and `(dashboard)` folders threw `CommandNotFoundException` errors
- Cause: PowerShell interprets parentheses as command syntax, not as part of a folder name
- Fix: Wrapped the paths in quotes: `mkdir "src/app/(auth)/login"` and `mkdir "src/app/(dashboard)"`
- Lesson: On Windows PowerShell, any folder name containing parentheses must be quoted in mkdir commands

**Issue 3**
- Symptom: shadcn `init` stopped without completing when the Custom preset was selected
- Cause: The Custom preset requires a pre-built configuration from the shadcn website - it cannot complete locally without that
- Fix: Re-ran `npx shadcn@latest init` and selected the Nova preset instead. Brand colours will be applied manually in the global CSS file during the UI build phase
- Lesson: Use an existing shadcn preset as a starting point and override colours in CSS - do not use the Custom preset without a pre-built configuration

### Session result
Next.js application successfully initialised with the full agreed stack, folder structure in place, environment variables confirmed, app running locally, and first real commit pushed to GitHub with CI passing.

---

## Session 1 - 31 March 2026 - Environment Setup

### What was built
- GitHub repository created at github.com/LeopoldTydtgat/lingualink-lms with README, .gitignore, and MIT license
- Main branch protected, dev branch created as the daily working branch
- Git configured locally with name, email, and SSH authentication to GitHub
- Project cloned to `C:\Projects\lingualink-lms` - intentionally outside OneDrive
- PowerShell execution policy updated to allow npm scripts to run
- Cursor Pro opened, connected to correct project folder, workspace trusted, confirmed on dev branch
- Node.js v24.14.1 and npm v11.11.0 confirmed working
- Vercel account connected to GitHub, lingualink-lms repository imported, auto-deploy active on dev branch
- Supabase project confirmed, publishable and secret API keys collected
- `.env.local` created with Supabase credentials
- Resend account confirmed, domain lingualinkonline.com verified in EU West (Ireland) region, DNS records added, API key saved to `.env.local`
- Sentry project created for Next.js, DSN key saved to `.env.local`
- GitHub Actions CI workflow created at `.github/workflows/ci.yml`, pushed to dev branch, workflow triggered and passed successfully

### Break/Fix Log

**Issue 1**
- Symptom: Project folder was inside OneDrive.
- Cause: Folder was created in the default Windows documents location which syncs automatically to OneDrive
- Fix: Created `C:\Projects` directory outside OneDrive and cloned the repository there instead
- Lesson: Never put Git repositories inside OneDrive - background sync causes file conflicts and potential corruption

**Issue 2**
- Symptom: `npm --version` returned a security error - script could not be loaded
- Cause: Windows PowerShell execution policy is set to restricted by default, blocking npm scripts from running
- Fix: Ran `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
- Lesson: Windows requires explicit permission to run PowerShell scripts - this is a one-time fix per machine

**Issue 3**
- Symptom: Cursor was pointing at the old OneDrive folder, not the cloned repository
- Cause: Cursor had been opened previously with the wrong folder path
- Fix: File → Open Folder → navigated to `C:\Projects\lingualink-lms`
- Lesson: Always confirm Cursor is pointing at the correct project folder at the start of each session

**Issue 4**
- Symptom: API key accidentally pasted into chat and then into the terminal instead of `.env.local`
- Cause: Unfamiliarity with the workflow - the copied value went to the wrong destination twice
- Fix: Deleted the exposed keys on Resend immediately, generated fresh keys, and pasted them directly into `.env.local`
- Lesson: API keys go directly into `.env.local` only - never in chat, the terminal, or any other file

**Issue 5**
- Symptom: Confusion about whether Payfast needed to be integrated into the portal
- Cause: The brief mentioned Payfast but the client's actual business flow handles payments on the existing WordPress website separately
- Fix: Confirmed with the client that the portal never handles money - students pay on the website and the client activates accounts manually in the portal
- Lesson: Always validate brief requirements against the actual business workflow - the client's confirmed process overrides what the brief says

### Session result
All development tools configured and connected end-to-end, credentials secured in `.env.local`, CI pipeline live on GitHub, and one major scope decision confirmed - the portal has no payment integration.

---
