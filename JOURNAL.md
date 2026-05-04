## Session 80 - 04 May 2026 - Welcome Email Removal, Forced Password Change Strip, UI Cleanup, 1hr Reminder Plain Link

### What was built
- src/app/api/admin/teachers/route.ts: removed Resend import, removed welcome email send block (recovery link generation plus inline HTML template), removed must_change_password write on profile upsert
- src/app/api/admin/students/route.ts: removed welcome email send block, removed must_change_password write on student insert (kept the separate "new student assigned" notification to teachers)
- src/app/(dashboard)/layout.tsx: removed must_change_password column from select and the redirect to /change-password
- src/app/(student)/student/layout.tsx: removed must_change_password column from select and the redirect to /student/change-password
- Deleted dead first-login pages and routes: src/app/(auth)/change-password/page.tsx, src/app/(student-auth)/student/change-password/page.tsx, src/app/api/teacher/change-password/route.ts, src/app/api/student/change-password/route.ts
- src/components/UpcomingClassesClient.tsx: removed the dead admin-gated "+ Add Class" button on /upcoming-classes (no onClick handler, admin booking lives in the admin portal)
- src/components/layout/TopHeader.tsx: standardised the avatar to inline styles, mirrored StudentTopHeader structure, fixed the oval avatar bug by adding explicit width/height to the Image style
- Standardised avatar rounding across MyClassesClient, BookingClient, PastClassesClient, PastClassDetailClient: all profile photos now use inline style with borderRadius 50% and objectFit cover
- src/lib/email/templates.ts: replaced the "Join Class on Teams" button in both teacher and student 1hr reminder emails with a plain-text Teams URL ("Join your class on Teams: <link>"). 24hr reminder untouched. buildButton helper retained for booking, cancellation, homework, and message emails

### Break/Fix Log

Issue 1: Student admin password reset returned 404 from auth.admin.updateUserById
Symptom: Admin reset on a student account failed with "User not found".
Cause: Route was passing students.id (table primary key) to auth.admin.updateUserById, which requires the auth.users UUID. Students have an indirection via students.auth_user_id.
Fix: src/app/api/admin/students/[id]/password/route.ts now fetches students.auth_user_id via .maybeSingle() and passes the auth UUID to updateUserById. Returns 404 with explicit messages if the student row is missing or auth_user_id is null.
Lesson: All auth.admin.* calls must receive the auth.users UUID. For profiles this is profiles.id by code convention. For students this is students.auth_user_id - never the students table PK.

Issue 2: Profile completion banner did not render for new accounts
Symptom: New teacher accounts did not see the profile-completion banner on /upcoming-classes despite profile_completed being false in the database.
Cause: Two compounding faults. First, the live profiles.profile_completed column had been created with DEFAULT true instead of DEFAULT false (drift between the migration file and what was applied to production). Second, missing table-level GRANT SELECT on profiles and students for the authenticated role: PostgREST returned null for the entire row with no error, masked by a `?? true` fallback that hid the banner whenever data was null.
Fix: Ran in Supabase SQL editor: ALTER TABLE profiles ALTER COLUMN profile_completed SET DEFAULT false; GRANT SELECT (profile_completed, must_change_password) ON profiles TO authenticated; GRANT SELECT ON public.profiles TO authenticated; GRANT SELECT ON public.students TO authenticated. Switched the banner fallback in src/app/(dashboard)/upcoming-classes/page.tsx and src/app/(student)/student/my-classes/page.tsx from `?? true` (hide if uncertain) to `?? false` (show if uncertain).
Lesson: Table-level GRANT SELECT must exist on restricted tables, not just column-level grants - missing table grant returns null silently. Default fallbacks must fail safe: for UI that signals an action the user must take, the fallback when data is null is the state that prompts the action, not the state that hides it.

Issue 3: Welcome email flow conflicted with how the client onboards users
Symptom: System sent an automated welcome email with a "Set My Password" link on every account creation, but the client wanted to send credentials manually with a personal touch and forced password change at first login was redundant.
Cause: Original onboarding design assumed self-service password setup. Client preference is admin-managed credential delivery.
Fix: Removed welcome email send from both creation routes. Removed must_change_password redirect from both layouts. Deleted the four first-login change-password files (pages and API routes). Kept the forgot-password and reset-password flow, the admin password override routes, and the profile-page self-service password change.
Lesson: Forced-change-on-first-login was theatre against most realistic risks. If admin email is compromised, an attacker reads the welcome message before the user does. The mitigation that actually matters is splitting the channel - send username and password in separate messages, not the same email.

Issue 4: "+ Add Class" button rendered on /upcoming-classes for admin accounts but had no onClick handler
Symptom: Admin saw a non-functional orange button on the teacher upcoming-classes page. The admin booking flow already lives in the admin portal.
Cause: Button was added in the initial implementation of the page (April 2026) and never wired up or removed.
Fix: Stripped the entire `{profile.role === 'admin' && (...)}` block from src/components/UpcomingClassesClient.tsx and simplified the wrapping flex container.
Lesson: When a UI element has been dormant for months without an onClick or a route, the cleanest disposition is removal, not preservation.

Issue 5: Avatar in teacher TopHeader rendered as an oval, not a circle
Symptom: Computed height 22px against width 36px. Box model showed content 32x18.
Cause: The Image element had width and height props (36, 36) and inline style with borderRadius and objectFit, but no explicit width or height in the inline style. The flex parent's vertical sizing rules let the next/image element collapse vertically. The student version worked because route-level CSS happened to mask the same gap.
Fix: Added `width: '36px'` and `height: '36px'` to the inline style on the Image element. Also converted the wrapping header and inner div from Tailwind classes to inline styles to mirror StudentTopHeader exactly.
Lesson: When a leaf component renders fine in one route and broken in another, the cause is upstream (parent layout, global CSS, or implicit sizing). Diagnosing in DevTools Computed tab finds the actual rendered dimensions in seconds. Iterating on the leaf without measuring wastes turns.

Issue 6: 1hr reminder email needed a crash-proof Teams link
Symptom: Client wanted teacher and student to be able to join the meeting from the email even if the portal was unreachable. The existing button worked but a copyable URL was preferred.
Cause: Original template only included a styled "Join Class on Teams" button via buildButton, no plain URL fallback.
Fix: Replaced the button in both 1hr templates with a plain-text paragraph: "Join your class on Teams:" followed by the raw URL as a styled anchor. 24hr reminder left untouched. buildButton retained for use by booking, cancellation, homework, and message emails.
Lesson: For operational emails where reliability matters more than aesthetics, a copyable URL beats a button. Buttons depend on email client rendering; raw links are universal.

### Session result

Session shipped four commits to dev: student admin password reset fix, exact retry countdown on rate-limited logins, profile-completion banner fail-safe, and the welcome-email-plus-forced-change strip combined with avatar cleanup and the 1hr reminder plain-link change. The 1hr cron was tested end-to-end via local dev server and Supabase test row (lesson scheduled NOW + 60 minutes, reminder_1h_sent reset to false, curl Bearer call to /api/cron/class-reminders); email arrived at the expected address with the plain link rendering correctly. Test row deleted afterward. Working tree clean. Five commits ahead of main awaiting PR.

---

## Session 75 - 1 May 2026 - Invoice Upload Window + Self-Assessed Level Consolidation

### What was built
- Layer 1 client fix: hid invoice upload/replace button on the current-month card and outside the 1st-10th window in src/app/(dashboard)/billing/BillingClient.tsx. Both gate conditions now check (isUploadWindow && !isCurrentMonth).
- Layer 2 server enforcement: replaced the existing UPDATE RLS policy on the invoices table with one that enforces the upload window in the database. Teachers can only update invoices where billing_month equals the previous month in their timezone AND day-of-month is between 1 and 10 in their timezone. Admins retain full access.
- Added missing storage UPDATE policy on the invoices bucket (was missing entirely; upsert: true on Replace was failing silently before this).
- handleUpload now uses .select() to detect 0-row updates from RLS blocks and surfaces a clear error message instead of false success.
- Added CRON_SECRET auth check to /api/keep-alive to match the rest of the cron surface.
- Consolidated split-brain student level columns: dropped self_reported_level, kept self_assessed_level as canonical, backfilled data, renamed all 6 read sites in the teacher portal and admin create route. Updated UI label from "self-reported" to "self-assessed".

### Break/Fix Log

Issue 1: Current-month invoice card was showing an upload button on day 1 of the month
Symptom: On the first of any month, teachers saw an Upload Invoice button on the running-month card (e.g. May 2026) which should not be uploadable until the month closes.
Cause: Both render conditions for the upload and replace buttons in BillingClient.tsx checked only isUploadWindow (day 1-10) and missed an !isCurrentMonth check. The current-month invoice row exists because ensureCurrentInvoice creates it on page load to display the running total, but it should not be uploadable.
Fix: Added && !isCurrentMonth to both gate conditions. The fallback text "Upload window opens on the 1st of next month." became reachable for the current month during the upload window.
Lesson: A display-time card and an upload-eligible card are not the same thing. When the same data structure drives both, the eligibility check must be a separate predicate, not assumed from membership in the list.

Issue 2: Replace button was failing silently after Layer 2 RLS was added
Symptom: After adding the table-level RLS policy, replacing an existing invoice PDF returned "Upload failed. Please try again." even within the valid window.
Cause: The error came from Supabase Storage, not the table policy. The invoices bucket had INSERT, SELECT, and DELETE policies but no UPDATE policy. upsert: true on an existing object requires UPDATE permission. The Replace flow had been working before only because no policy was actively blocking it during prior testing; the gap had always been there.
Fix: Added a "Teachers can update own invoices" policy on storage.objects scoped to the invoices bucket and the teacher's own folder.
Lesson: Storage policies are independent from table policies. upsert: true is INSERT plus UPDATE under the hood and needs both permissions explicitly. Audit storage policies separately whenever upsert is in play.

Issue 3: Silent no-op when RLS blocks an UPDATE
Symptom: Without client-side detection, an out-of-window upload would write the PDF to storage, then have its DB update silently blocked by RLS, and show a green success indicator to the teacher.
Cause: The .update() call destructured only error. Supabase returns 0 rows updated with no error when RLS blocks a write.
Fix: Switched to .update(...).select() and checked the returned array. Empty array now surfaces "Invoice upload is only allowed between the 1st and 10th of the month following the billing period."
Lesson: For any UPDATE behind RLS, always use .select() and check the returned rows. Treating "no error" as success is unsafe.

Issue 4: Split-brain on student self-assessed level
Symptom: Teachers viewing a student's profile always saw a blank or stale self-assessed level even after the student had updated it.
Cause: Two columns existed on the students table: self_assessed_level and self_reported_level. The student portal wrote to self_assessed_level. The teacher portal and the admin create route used self_reported_level. Data lived in different columns depending on who last touched the row.
Fix: Backfilled self_reported_level into self_assessed_level where the latter was null. Renamed all 6 code sites that referenced self_reported_level. Dropped the self_reported_level column. Updated the UI label "Student Level (self-reported)" to "Student Level (self-assessed)" to match the brief.
Lesson: When two near-synonym column names exist for the same concept, half the system will pick one and half will pick the other. Catch this in code review or with a single canonical types file. A grep across all read and write sites for both names is a 5-minute audit that prevents months of silent data loss.

### Session result
Two production bugs fixed end-to-end with both client and server enforcement. The invoice upload window is now defended in three layers: the UI hides the button outside the valid window, the table RLS policy blocks the DB write outside the window, and the client surfaces a clear error if a write is silently blocked. The student self-assessed level column split was a hidden data-integrity bug that had been quietly losing student input for an unknown duration; resolving it required a backfill, a code rename across 6 sites, a column drop, and a copy update. Both fixes pushed to dev (commits d8c5376 and 012e773).

---
## Session 74 - 30 April 2026 - Billing refactor: single source of truth

### What was built
- src/lib/billing/billability.ts - canonical billability function 
  covering all lesson statuses including <24h cancellations and 48hr policy
- src/lib/billing/monthRange.ts - timezone-aware month boundary helper 
  using the two-pass UTC conversion pattern
- Refactored 6 billing calculation sites onto the shared util:
  * teacher right panel (current and projected amounts)
  * teacher billing page
  * admin billing client (student billing + company billing tabs)
  * admin export route (teacher_earnings, company_billing, teacher_invoices)
- Added per-row Amount column + Total to the teacher invoice detail view 
  (previously admin-only)
- Split "Amount (currency symbol)" into separate Amount + Currency 
  columns across all three CSV exports

### Break/Fix Log

Issue 1: Teachers were silently underpaid in their own billing view.
Cause: Right panel and teacher billing page never queried cancelled 
lessons - only completed and student no-show. The 24h cancellation rule 
existed in admin code but not in teacher-facing code.
Fix: Shared util applied to all 6 calc sites with consistent rules.
Lesson: Three duplicate implementations of the same logic is two too many.

Issue 2: Month boundary inconsistency across the codebase.
Cause: Right panel used server UTC, teacher billing page used browser 
local time, admin/export used server local time. A teacher in Cape Town 
near month-end could see a class belong to two different months 
depending on which page rendered.
Fix: All sites now use getMonthRangeInTz / getMonthKeyInTz with the 
teacher's profiles.timezone.
Lesson: Never trust new Date() local time for anything timezone-sensitive.

Issue 3: Invoice writeback overwrote paid invoices.
Cause: Reactive recalculation in BillingClient fired on every load and 
silently rewrote amount_eur even when status = 'paid'.
Fix: Added explicit skip when invoice.status === 'paid'.
Lesson: Reactive write-backs need state guards or they become a foot-gun.

Issue 4: Teacher billing page showed zero amount and wrong currency.
Cause: page.tsx fetched billingInfo with createClient (auth/RLS), but 
hourly_rate, currency, and timezone are column-REVOKE'd from the 
authenticated role. The fetch silently returned null for these fields.
Fix: Switched to createAdminClient, mirroring the pattern already used 
in (dashboard)/layout.tsx.
Lesson: Column-level REVOKEs on profiles need an admin client server-side 
or they fail silently. Not the first time this has caught us.

Issue 5: Stale paid_at and status='paid' on a test invoice.
Cause: Test data created during earlier sessions, never cleaned up.
Fix: Manual SQL update in Supabase to clear status and paid_at.
Lesson: Test data needs an owner. Add a cleanup script if this keeps 
recurring.

### Session result
The billing system now has one canonical billability function used 
across every calculation site - teacher right panel, teacher billing 
page, admin billing tabs, and all CSV exports. Three real bugs caught 
and fixed along the way: teachers being underpaid for <24h cancellations, 
month boundaries drifting between sites, and the page.tsx auth client 
silently returning null for hourly_rate. Currency and timezone are now 
fully dynamic and respect each teacher's profile settings end-to-end.

---

## Session 73 - 30 April 2026 - Auth signal cleanup, cross-role email guard, UX polish

### What was built
- src/app/(student-auth)/student/login/actions.ts: student login now gates on status alone to match proxy.ts. The is_active read was removed.
- src/app/(student)/student/layout.tsx: student layout guard now checks status instead of is_active.
- src/app/api/admin/teachers/route.ts: added a pre-flight email lookup against the students table. Rejects with 409 if the email is already in use by a student account.
- src/app/api/admin/students/route.ts: added a pre-flight email lookup against the profiles table. Rejects with 409 if the email is already in use by a teacher account. Standardised to use createAdminClient() to match teachers/route.ts.
- src/app/(dashboard)/upcoming-classes/UpcomingClassesClient.tsx: countdown timer now matches the student portal format (Xd Yh ZZm when 24 hours or more away, live HH MM SS ticker otherwise). Reschedule modal title, helper text, and confirm button reworded to consistently lead with the cancel action.
- src/app/(student)/student/account/AccountClient.tsx: self-assessed level dropdown default changed from "Select level..." to "I'm not sure". Helper text reassures students that not knowing is fine.

### Break/Fix Log
Issue 1 (Bug 11): Symptom: student auth was checked twice using two different signals. proxy.ts gated on status while the student login action and student layout gated on is_active. Cause: the two checks could drift out of sync, leading to inconsistent access enforcement. Fix: removed is_active reads from the student login action and student layout, replaced with the same status check used by proxy.ts. Lesson: when the same access decision is made in multiple places, every layer must read the same column or drift is inevitable.

Issue 2 (Bug 6 closed): Symptom: historic concern that creating a teacher and student with the same email caused a duplicate or ghost profile. Cause: a Supabase trigger on auth.users (on_auth_user_created calling handle_new_user) inserts a profiles row automatically when an auth user is created. The admin create routes had been changed in earlier sessions to use upsert with onConflict on email, which already handles the trigger correctly. Fix: a read-only audit confirmed zero orphan profiles, zero ghost profiles, and a 1:1 ratio between auth users and profiles. No code change needed. The bug is closed. Lesson: not every flagged bug is still a bug. Audit before assuming.

Issue 3 (cross-role email collision): Symptom: when a teacher account was deleted that shared an email with a student, the student row survived but lost its auth_user_id link, leaving the student unable to log in. Cause: Supabase deletes the auth.users row on teacher deletion. The students.auth_user_id foreign key was set to ON DELETE SET NULL, so the link was nulled. Sharing an email across two roles meant deleting one role corrupted the other. Fix: added a pre-flight email lookup to both admin create routes that rejects with a clear 409 error if the email is already in use by the other role. Lesson: shared identifiers across roles invite cascade corruption. Block them at the create step.

Issue 4 (P5 countdown format): Symptom: teacher portal countdown showed values like "71h 19m 44s" instead of "2d 23h 19m" when classes were more than a day away. The student portal already had the correct format. Cause: the teacher Countdown component computed total raw hours without extracting days first. Fix: rewrote the formatting logic to match the student portal. When days is greater than zero, format as Xd Yh ZZm with no seconds. Otherwise keep the live HH MM SS ticker. Lesson: when two portals share visual conventions, format helpers should live in one place rather than being duplicated.

Issue 5 (P5 reschedule modal labelling): Symptom: teacher reschedule modal title said "Request reschedule" while the confirm button said "Send & cancel class". Inconsistent language confused users about whether the action was rescheduling or cancelling. Cause: the labels were written at different times during the build. Fix: title is now "Cancel class & request reschedule", confirm button is "Send message & cancel class", and the helper text was rewritten to clearly explain that the class is cancelled and the student books a new time themselves. Lesson: every label in a single flow should describe the same action.

Issue 6 (P4 self-assessed level): Symptom: student account page forced students to either pick a CEFR level or leave a "Select level..." placeholder, with no friendly opt-out. Cause: the dropdown was built with the assumption that students could self-assess accurately, which most cannot. Fix: replaced the placeholder option with "I'm not sure" (still maps to empty string then null on save). Updated helper text to reassure students that not knowing is fine and the teacher will assess. Lesson: optional fields should make the opt-out the default, not the placeholder.

### Session result
Cleared four pinned bugs in a single session. Bug 11 removed the auth signal drift between proxy.ts and the student path. Bug 6 was investigated and closed clean with zero orphans found. The cross-role email guard was added to both admin create routes, eliminating an entire class of corruption that occurred when a single email was shared across roles. Two P5 UX issues (countdown format and reschedule modal labelling) and one P4 polish item ("I'm not sure" option) were shipped. Four commits on dev: 3f3c958, a001281, 67c0bed, 4141da8. The session followed the working rules throughout: audit first, capture rollback hash, line-by-line diff review, local test before commit.

---

# LinguaLink Online - Build Journal

## Session 72 - 30 April 2026 - Bug 7: "To be assessed" fluency level rejected by validation

### What was built
- Admin student create form: collapsed two sentinel <option> entries (`- Select -` and `To be assessed`) into a single `<option value="">To be assessed</option>` so the displayed default option sends an empty string.
- Admin student create form: added explicit `current_fluency_level: form.current_fluency_level || null` to the POST submit body so the empty string coerces to null before reaching the server.
- Admin student edit form: same `<option>` collapse. Submit handler already had `|| null` from a previous fix - left untouched.

### Break/Fix Log
Issue: Selecting "To be assessed" on the admin student create form returned HTTP 400.
Cause: The dropdown sent the literal string "To be assessed" as the option value. The POST route validates the body with `CreateStudentSchema`, where `current_fluency_level: z.enum(CEFR_LEVELS).optional().nullable()` only accepts the eleven CEFR literals, null, or undefined. Zod rejected the string and the route returned 400. The edit form had the same dropdown but its PATCH route has no Zod validation, so it silently saved the literal "To be assessed" to the DB column whenever it was used (the column is unconstrained text).
Fix: Two-part. (1) Both forms now use `<option value="">To be assessed</option>` so the visible default sends an empty string instead of the literal label. (2) The create form's submit body explicitly coerces empty string to null with `|| null`, matching the pattern the edit form already used. Net effect: selecting "To be assessed" now writes null to the DB on both forms.
Lesson: Zod schemas on POST routes catch garbage that PATCH routes silently accept. When two forms share a component pattern but only one has server-side validation, bugs hide on the unvalidated path until someone audits the column. Pre-fix SELECT confirmed zero existing rows had the literal "To be assessed" value, so no data cleanup was needed - but only because nobody had successfully used the option. The audit-before-fix pattern paid for itself again: read paths in admin detail view, student portal, and teacher portal all already handled null correctly via existing `|| '-'` and `?? '-'` fallbacks, so the change carried zero ripple risk.

### Session result
Bug 7 closed. Post-fix rollback hash cf54f10 on dev branch (not yet merged to main). Five open bugs remain: Bug 11 (phase out is_active), Bug 6 (DB trigger ghost profile), P5 UI fixes (countdown format, reschedule modal labelling), P4 (self-assessed level "I am not sure" option). Pinned low-priority: centre booking wizard card, inactivity timeout question.

---

## Session 71 - 30 April 2026 - Auth Hardening, Messaging Cleanup, Cross-Portal Cleanup on Purge

### What was built
- Bug 3: Cross-portal cleanup of ghost profiles row on student purge. New delete added to the student purge route inside the existing if (authUserId) block, runs before the auth signOut and deleteUser calls. Closes the orphan-profile gap left by the database trigger that auto-creates a profiles row at student auth-user creation.
- Bug 10: Student names now resolve correctly on the teacher and admin messages pages. Two pages were querying students.auth_user_id when the messages table actually stores students.id. Four lines changed across two files - .in('auth_user_id', ...) and the matching .find((s) => s.auth_user_id === ...) corrected to use id in both call sites. Student-side messages pages audited - no inverted bug exists.
- Bug 9 (revised): One-time data cleanup of a single orphan message row. Discovered during the Bug 3 audit when a message row was found pointing at a student's auth UUID instead of the canonical students.id. Audit of all three message-insert sites in the codebase confirmed every current code path uses students.id correctly - the orphan was a historical anomaly, not a systemic bug. Deleted via direct SQL.
- Bug 8: Former and on_hold accounts can no longer log in. Five files modified as one coordinated fix:
  - Teacher login action: queries profiles.status after successful credential check, rejects former/on_hold with signOut and clears the proxy cache cookie. Now also rejects auth users with no profiles row.
  - Student login action: same status guard added alongside the existing is_active check.
  - Teacher PATCH route: when admin sets status to former or on_hold, calls auth.admin.signOut(id, 'global') to kill all existing sessions immediately.
  - Student PATCH route: same pattern, using students.auth_user_id resolved from the existing pre-check select.
  - Proxy: per-request status check with a 60-second cookie-based cache. Uses the admin client (not the user-scoped client) to avoid RLS lockout. Falls through profiles then students. Blocks former/on_hold and any orphaned auth user with no business record. Preserves Supabase auth-cookie writes onto the redirect response to avoid stale-cookie redirect loops.

### Break/Fix Log

Issue 1: Ghost profiles row left behind after every student purge.
- Symptom: Every student in the database had a corresponding profiles row created at auth-user creation by a database trigger. The student purge cascade did not clean it up. Auth account and students row were deleted; the profiles row stayed as an orphan.
- Cause: The auto-create trigger on auth.users fires for every new auth user regardless of role. The student creation flow does not need this row but inherits it. The student purge route was never updated to clean up the orphan.
- Fix: Added one delete to the student purge route inside the if (authUserId) block - .from('profiles').delete().eq('id', authUserId) - placed after all per-table deletes and before the auth signOut.
- Lesson: The database schema is not in the repo as SQL. FK behaviour and trigger behaviour have to be inferred from purge cascade order and journal entries. When the audit cannot read the schema directly, runtime SQL queries against real data are the next-best evidence. The audit predicted the orphan would have no FK references; runtime data showed one - which led directly to discovering Bug 10.

Issue 2: Student names rendering as "Unknown" on teacher and admin messages pages.
- Symptom: When loading historical conversations, the student contact name appeared as "Unknown" instead of the student's real name.
- Cause: Both the teacher messages page and the admin messages page resolve student display names by querying the students table with the IDs harvested from message rows. They were querying .in('auth_user_id', studentIds) but the messages table stores students.id (the row PK), not auth_user_id. Lookup returned nothing, .find returned undefined, fallback rendered "Unknown".
- Fix: Four lines changed across two files - .in('auth_user_id', ...) corrected to .in('id', ...), and the corresponding .find((s) => s.auth_user_id === contact.id) corrected to s.id === contact.id.
- Lesson: Code-level audit of all message-insert sites was essential. The bug existed for weeks without anyone noticing because most users see real-time conversations rather than reloaded history. A surface-level "messages work" check would have missed it. Reading every insert site for the actual id-vs-auth_user_id pattern surfaced the bug.

Issue 3: Former and on_hold accounts could log in and access the portals.
- Symptom: A teacher or student set to status='former' (or 'on_hold') could still log in cleanly. Existing sessions of newly-archived users were never invalidated.
- Cause: Three layered gaps. Login flows did not check status at all (teacher) or only checked is_active (student, which the archive action did not even set). Archive PATCH routes only updated the database row - no session invalidation. The proxy validated the JWT cryptographically but never consulted the database, so an archived user could keep navigating until their refresh token naturally expired.
- Fix: Five files changed in one commit. Login flows now reject former and on_hold with signOut. Archive PATCH routes call auth.admin.signOut(id, 'global') after the database update. Proxy adds a per-request status check with a 60-second cookie cache to protect against any path that bypasses the login and archive guards. The proxy uses the admin client to avoid RLS lockout and preserves Supabase auth-cookie writes onto the blocked-redirect response.
- Lesson: A clean Claude Code "build passes" report and a clean diff are not proof of correctness. Reading the actual file contents top to bottom caught three concrete bugs in the first attempt - RLS lockout from using the user-scoped client, stale cache cookies leaking across logins, and lost auth-cookie state on the blocked redirect. A second pass caught two more - .single() throwing on no-row, and the teacher login silently logging in users with no profiles row. None would have been caught by the build. All would have shipped if the rule "always read the actual code, never trust the summary" had not been applied.

Issue 4: Inconsistency between is_active and status as the source of truth for active accounts.
- Symptom: Teacher archive sets both { status: 'former', is_active: false }. Student archive sets only { status: 'former' } and ignores is_active. The student login's is_active check therefore did nothing for former students.
- Cause: Two flags doing similar work, set inconsistently across portals. Drift over time.
- Fix: Bug 8 establishes status as the canonical source of truth at every layer (login flows, archive routes, proxy). is_active left in place for now alongside status to keep the security fix scoped. Cleanup of is_active deferred to its own session as Bug 11.
- Lesson: When two flags express overlapping state, one must be the source of truth and the other must either be removed or kept in lockstep automatically. Manual lockstep across multiple code paths drifts.

### Session result
Three real bugs shipped, one historical anomaly cleaned up, one new bug logged for a dedicated future session. All commits separately rollback-able. The session was driven by a strict working rule: read the actual code, never trust summaries. That rule paid for itself five times over - five distinct correctness issues caught in code that had already been reported as "build clean, diff matches". The portal's auth surface is now genuinely hardened, the messaging UI now shows real names instead of "Unknown", and the database is one orphan row lighter.

---

## Session 70 - 29 April 2026 - UTC bug fix and unified calendar visual redesign

### What was built

- Completed the Priority 1 UTC bug audit. Cross-codebase scan of all 72 toISOString() usages identified one genuine bug in src/app/(dashboard)/layout.tsx where the billing month-start was constructed using server-local Date parts before being converted to UTC. Replaced with explicit UTC construction. The bug was latent in production because Vercel runs in UTC but would have broken on AWS migration to any non-UTC region.
- Audited and ruled out src/app/api/student/availability/route.ts as a false positive. The toISOString().slice() pattern there is safe because the base date is pinned to UTC midnight via an explicit Z suffix and all subsequent operations use setUTCDate consistently.
- Redesigned the General Availability grid in src/app/(dashboard)/schedule/tabs/GeneralAvailability.tsx. Table now stretches to full width. Day headers use a soft red palette (#F6C5B8 background, #5C1F0A text) drawn from the brand colour set. Inactive slots are fully transparent so active orange slots dominate the grid visually. Whole table sits inside a white card with rounded corners and a 1px grey border. Solid horizontal dividers between every 30-minute row, plus subtle smaller half-hour labels for time-grid scanning.
- Brought the Day to Day calendar in line with the General Availability design via CSS class overrides on FullCalendar's internal classes (.fc-col-header-cell, .fc-timegrid-axis, .fc-timegrid-slot-label). Time axis received the same soft red tinting which actually framed the calendar nicely. Enabled half-hour slot labels by changing slotLabelInterval from "01:00:00" to "00:30:00", and forced 24-hour zero-padded format via slotLabelFormat to match the rest of the portal.
- Aligned the student portal booking calendar (src/app/(student)/student/book/BookingClient.tsx) with the teacher portal palette. Day headers switched from the earlier blue tint to the soft red, header text colours updated for contrast, and available slot fills set to #FFF0DC for exact consistency with the General Availability grid.
- Saved the full Lingualink brand colour palette to memory for future reference. White #FFFFFF, Grey #E0DFDC, Black #000000, Yellow #FFB942, Orange #FF8303 as the primary, and Red #FD5602. All permitted on portals so future design work can introduce variety without breaking the brand.

### Break/Fix Log

Issue 1 - UTC date construction in teacher portal layout
Symptom: Audit flagged a toISOString() call on a locally-constructed Date object.
Cause: new Date(year, month, 1) produces midnight in the runtime's local timezone before .toISOString() converts to UTC. On any non-UTC server, the resulting string shifts by one day depending on offset.
Fix: Replaced with a templated UTC string built from getUTCFullYear and getUTCMonth.
Lesson: The prohibited pattern needs to be removed at source even when the current runtime happens to be UTC. Latent bugs become invisible until the environment changes, and AWS migration is on the roadmap.

Issue 2 - Sticky table headers refused to render their bottom border
Symptom: The General Availability day headers had a borderBottom defined in their style props but the divider line was not visible in the rendered output.
Cause: When position sticky is applied to a table cell inside a table with border-collapse collapse, browsers do not render the bottom border reliably. The border collapses away during sticky positioning calculations.
Fix: Replaced the borderBottom with an inset box-shadow at the same position. Inset box-shadows render correctly on sticky elements regardless of border-collapse behaviour.
Lesson: Sticky table cells and border-collapse have a known interaction issue. Reach for box-shadow or pseudo-element overlays when borders refuse to render on sticky cells.

Issue 3 - FullCalendar header styling needed CSS class overrides
Symptom: Wanted to apply the same soft red header treatment to Day to Day but FullCalendar renders its own DOM and does not accept inline style props on day headers.
Cause: FullCalendar generates its column headers via internal classes that are not React-controlled.
Fix: Added CSS rules inside the existing style block at the top of the component, targeting FullCalendar's class names with important flags to override the library defaults.
Lesson: When working with calendar libraries that render their own DOM, plan for CSS class overrides up front. Use important sparingly but it is unavoidable here because FullCalendar's own styles are also specific.

Issue 4 - Inconsistent time label formats between the two calendars
Symptom: Day to Day rendered lowercase "8am" style labels while General Availability used "08:00" zero-padded labels. The two views in the same tab looked like they came from different products.
Cause: FullCalendar defaults to a locale-abbreviated time format. No slotLabelFormat prop was set on the component.
Fix: Added slotLabelFormat with hour 2-digit, minute 2-digit, hour12 false to force 24-hour zero-padded format.
Lesson: FullCalendar's default formatting is locale-dependent. For consistency across views, set slotLabelFormat explicitly even when defaults look acceptable in development.

### Session result

The UTC audit closed cleanly with one genuine bug fixed and one false positive ruled out. A larger visual redesign ran in parallel covering all three calendar surfaces in the application: General Availability, Day to Day, and the student booking flow. All three now share a unified soft red header palette drawn from the Lingualink brand colours, with consistent slot styling, time-grid dividers, and time formats across the portal. TypeScript compiles cleanly across the project, the full Next.js build of all 78 pages succeeds, and visual checks on localhost confirm all calendar surfaces render correctly. Brand colour palette saved to memory for future design work. All changes merged to dev branch.

---

## Session 69 - 29 April 2026 - Right Panel Wheel Forwarding and Admin Radar Chart Fix

### What was built

- Added wheel event forwarding from the right panel to the middle main content area on all three portals (Teacher, Student, Admin). Touches three files: src/components/layout/RightPanel.tsx, src/components/student/layout/StudentRightPanel.tsx, and src/app/(admin)/AdminLayoutClient.tsx. Pattern is identical across all three: a useRef on the right panel root, plus an onWheel handler that forwards e.deltaY to document.querySelector('main')?.scrollBy(). The handler only forwards when the panel itself cannot scroll further in the wheel direction; if the panel still has internal scroll headroom, the wheel event is left alone for the panel to handle natively. Manual testing across all three portals confirmed expected behaviour: hovering the right panel and scrolling now scrolls the middle content area, while internal scroll containers (calendars, message threads, contact lists, Tiptap editors) still scroll their own content when hovered directly.

- Fixed two bugs in the admin radar chart at src/app/(admin)/admin/reports/[id]/ReportDetailClient.tsx. Bug 1: the LevelData interface was typed as number, but the database stores CEFR strings ("B1+", "B2", etc.). String arithmetic was producing NaN, throwing console errors on every report view. Bug 2: the SKILLS array used wrong keys 'spoken' and 'written' when the database stores them as 'overall_spoken' and 'overall_written'. Those two skills had been silently rendering at zero on the admin chart since launch, regardless of what the teacher had actually entered. Fix copied the working CEFR_TO_NUM lookup pattern from the student portal's ProgressClient.tsx exactly, replaced the broken arithmetic with a string-to-fraction conversion, and corrected the two skill keys. Removed the now-unused maxValue and CEFR_LABELS constants. Manual testing confirmed the chart now renders all seven skills correctly with no console errors.

### Break/Fix Log

Issue 1: Initial misdiagnosis of the right panel scroll problem
- Symptom: The session started with a Session 68 handover brief proposing a full layout architecture refactor - removing h-screen, fixed-positioning the sidebar and right panel, and converting the page itself into the scroll container.
- Cause: The handover misread the underlying UX complaint. The actual frustration was narrow: when the cursor hovered the right panel, the mousewheel did nothing because the panel's overflow-y-auto caught the wheel event and dropped it. The user expected the middle content to scroll regardless of cursor position. This is a wheel-event capture issue, not a layout architecture issue.
- Fix: Discarded the layout refactor plan entirely. Replaced it with a small wheel-forwarding handler on each right panel root.
- Lesson: When a UX complaint is presented as architectural, restate the actual user behaviour in plain terms before drafting any fix. The originally proposed refactor would have introduced significant risk to existing scheduling, messages, and calendar logic for no actual gain over the simpler fix.

Issue 2: Admin radar chart silently showing zero on Spoken and Written for every report since launch
- Symptom: Console errors of "Received NaN for the cx attribute" and "Received NaN for the cy attribute" surfaced when viewing any admin report detail page.
- Cause: Two compounding bugs in ReportDetailClient.tsx. The chart code expected numeric level data but the database stores CEFR strings, producing NaN on every coordinate calculation. Separately, the SKILLS array used 'spoken' and 'written' as keys when the actual database keys are 'overall_spoken' and 'overall_written'. The wrong keys silently fell back to zero through the ?? 0 fallback, hiding behind the NaN error noise.
- Fix: Read both student-portal radar chart files to find the working pattern. ProgressClient.tsx already had a CEFR_TO_NUM lookup table converting strings to numbers correctly. Copied that exact lookup into the admin file, replaced the broken arithmetic, and corrected the two skill keys.
- Lesson: When fixing a visible bug, always check whether other bugs are hiding behind it. The NaN errors were noisy enough that they obscured the silent zero-data bug on Spoken and Written. The audit-before-fix discipline caught this; a quick null-guard patch would have left the wrong-keys bug undiscovered.

Issue 3: Pre-flight rollback discipline
- Symptom: No formal rollback hash had been captured at the start of code-change sessions previously.
- Cause: Habit gap rather than a technical issue.
- Fix: Captured commit aeb1cb82 as the rollback point before applying the wheel-forward fix, and commit 0835b037 as the rollback point before applying the radar chart fix. Recorded both before any apply step.
- Lesson: Every code-change session now opens by recording the current dev branch HEAD commit hash as a named rollback point. Costs nothing, protects everything.

### Session result
Two fixes shipped in one session, both small and isolated, both fully reversible. Right panel wheel forwarding works correctly across Teacher, Student, and Admin portals: hovering the right panel and scrolling moves the middle content as expected, while internal scroll regions (calendars, message threads) still scroll their own content when interacted with directly. Admin radar chart now renders all seven skills correctly, console is clean, and the previously hidden Spoken and Written zero-data bug is resolved. Session demonstrated the value of the audit-before-fix rule twice: once by replacing an unnecessarily large layout refactor with a 10-line wheel-forwarding handler, and once by surfacing a silent secondary bug behind the NaN errors. Both rollback hashes (aeb1cb82 and 0835b037) remain available if either fix needs to be unwound.

---

## Session 67 - 29 April 2026 - Scheduling Fixes, UTC Storage Bug, and DayToDay UX Improvements

### What was built

- Fixed UTC storage bug in DayToDay - teacher availability blocks were being saved as local time instead of UTC. Added localIsoToUtcIso helper function and wired it into handleDateSelect. timezone field added to Profile interface and propagated through schedule/page.tsx and ScheduleClient.tsx
- Fixed delete modal not appearing on unavailability blocks - root cause was a past-date guard in handleEventClick that fired on wrongly-stored blocks. Guard removed entirely; ownership check in the API route provides the necessary protection
- Fixed null push bug in handleDateSelect - POST route uses maybeSingle() which can return null on duplicate upsert. Added null guard before calling onAvailabilityChange to prevent corrupted state array
- Fixed General Availability scroll - replaced hardcoded pixel calculation with DOM-based offsetTop read from the actual 08:00 row minus 40px offset
- Fixed DayToDay scroll - height="auto" was preventing FullCalendar from scrolling. Changed to height="700px" with overflowY auto on wrapper, added useEffect with 150ms delay to scroll .fc-scroller-liquid-absolute to the 08:00 position
- Fixed "15 minutes" references - ClassReminderModal.tsx REMINDER_WINDOW_S changed from 15*60 to 10*60, booking confirmation email copy updated, stale comment in RightPanel.tsx updated
- DayToDay UX improvements - slotMinTime 05:00, slotMaxTime 23:00, Escape key exits add/unavailability mode, instruction text updated, navigation arrows repositioned to either side of week title, today column highlight changed from yellow to #EFF6FF

### Break/Fix Log

Issue 1 - DayToDay blocks displaying at wrong time
Symptom: Unavailability blocks set at 09:00 appearing at 02:00-03:00 on the calendar
Cause: FullCalendar with timeZone="local" produces local-time ISO strings with no UTC offset. The POST handler passed these verbatim to Supabase. The student availability reader assumed timestamps were UTC. For a UTC+2 teacher every block was stored 2 hours early
Fix: Added localIsoToUtcIso two-pass Intl correction function. Added timezone to Profile interface and fetched it in the page server component
Lesson: When timeZone="local" is set on FullCalendar, info.startStr and info.endStr are local time strings - never treat them as UTC

Issue 2 - Delete modal not appearing
Symptom: Clicking a red unavailability block did nothing
Cause: handleEventClick contained a past-date guard that compared info.event.startStr.slice(0,10) against today. Wrongly-stored blocks appeared to be in the past, so the guard fired and returned early before setPendingDelete could run
Fix: Removed the three-line past-date guard. API ownership check is sufficient protection
Lesson: Silent early returns with no error feedback make bugs very hard to diagnose

Issue 3 - Adding blocks would not stick after first add
Symptom: First block saved fine, subsequent blocks disappeared on next render
Cause: maybeSingle() returns null when upsert ignores a duplicate. Spreading null into the availability array caused a TypeError on the next render when calendarEvents tried to access properties on null
Fix: Added if (data) guard before calling onAvailabilityChange

Issue 4 - General Availability scroll landing at 06:30
Symptom: Page opened showing 06:30 instead of 08:00
Cause: Hardcoded scrollTop = 8 * 2 * 22 assumed 22px row height. Actual rendered height was larger due to browser default button sizing
Fix: Replaced with DOM-based offsetTop read from the actual tr at index 16, minus 40px

Issue 5 - DayToDay scroll ignoring initialScrollTime
Symptom: Calendar opened at midnight despite initialScrollTime="08:00:00"
Cause: height="auto" causes FullCalendar to expand to fit all slots - no scrollable container exists so initialScrollTime has nothing to scroll
Fix: Changed to height="700px", added overflowY auto on wrapper div, added useEffect that queries .fc-scroller-liquid-absolute after 150ms and sets scrollTop proportionally

### Session result

All six Priority 1 scheduling bugs from the Session 65 backlog are resolved. The UTC storage fix corrects how new availability blocks are saved going forward - the client must delete and recreate any unavailability blocks set before this session as they contain wrong timestamps. Ten bugs from the Priority 2-4 list remain and carry forward to Session 68.

---

## Session 66 - 28 April 2026 - Security Audit, Sentry Setup and Critical Bug Fixes

### What was built
- Verified session bleed issue was caused by shared email address between teacher and student test accounts, not a code bug. All session security fixes from Session 65 confirmed valid and retained
- Added subdomain separation (teacher/student/admin.lingualinkonline.com) to Step 14 hardening list - all three portals currently share app.lingualinkonline.com which means one shared session cookie per browser
- Added database-level double booking prevention: enabled btree_gist extension in Supabase and created an EXCLUDE constraint using tstzrange on the lessons table scoped to status = 'scheduled'. Added application-level overlap check in both /api/student/book/route.ts and /api/admin/classes/route.ts before the lesson insert, returning 409 if a conflict is found
- Fixed TEAMS_LINK_PENDING sentinel string in /api/student/book/route.ts - teamsJoinUrl now initialises as null instead of the string 'TEAMS_LINK_PENDING', so failed Graph API calls are correctly surfaced in the admin dashboard alert
- Wired up Sentry error monitoring - created sentry.client.config.ts, sentry.server.config.ts, sentry.edge.config.ts, and src/instrumentation.ts. Wrapped next.config.ts with withSentryConfig. Added SENTRY_DSN to Vercel environment variables. Confirmed events are being received in Sentry dashboard
- Fixed teacher timezone display in UpcomingClassesClient.tsx - all date and time formatting now uses Intl.DateTimeFormat with the teacher's stored profile timezone instead of the browser's local timezone. Added formatTime(), formatDate(), and getLocalDateKey() helpers matching the student portal pattern. Added mounted guard to prevent hydration mismatches
- Fixed company billing CSV export missing Amount column - the 9th column header existed but no value was pushed into the row. Updated the lessons query to fetch hourly_rate from the teacher profile join and added lessonAmount(duration_minutes, hourly_rate) as the 9th row value
- Identified and logged additional bugs for a future fix session (see break/fix log)

### Break/Fix Log
Issue 1: Session bleed between teacher and student portals / Cause: Test accounts shared the same email address, which maps to a single Supabase auth user. One session cookie overwrites the other on the shared domain / Fix: Deleted the duplicate teacher account, recreated student with the same email as a clean auth user. Not a code bug / Lesson: Never share email addresses across teacher and student test accounts. Permanent fix is subdomain separation in Step 14

Issue 2: Double booking not prevented / Cause: Neither booking route checked for overlapping lessons before inserting. No database constraint existed / Fix: Added btree_gist extension, EXCLUDE constraint on lessons table, and overlap query in both booking routes / Lesson: Any write that must be exclusive needs both a DB constraint and an application check

Issue 3: TEAMS_LINK_PENDING invisible to admin dashboard / Cause: Student booking route initialised teamsJoinUrl as the string 'TEAMS_LINK_PENDING' on Graph API failure. The admin alert filters for null, so these failures were never surfaced / Fix: Changed initialiser to null / Lesson: Sentinel strings bypass null checks silently

Issue 4: Sentry not initialised / Cause: sentry.server.config.ts is not auto-loaded by Next.js App Router. An instrumentation.ts hook is required in v8+ / Fix: Created src/instrumentation.ts with the register() function importing server and edge configs per runtime / Lesson: Always verify third-party SDK initialisation with a test event before considering it done

Issue 5: Teacher times shown in browser timezone / Cause: UpcomingClassesClient used date-fns format() which reads the browser's local clock, not the teacher's profile timezone / Fix: Replaced all date-fns calls with Intl.DateTimeFormat using teacherTimezone passed from the server component / Lesson: Always pass an explicit timezone to every date formatting function

Issue 6: Company billing CSV amount column always blank / Cause: The 9th column header was declared but the row push only contained 8 values. hourly_rate was also not fetched in the query / Fix: Added hourly_rate to the profile join and appended lessonAmount() as the 9th row value

### Bugs identified for next fix session
- Purge modal shows blank confirmation text when teacher or student has no full name - should fall back to email address
- Purge button not disabled when confirmation field is empty - allows purge with no input
- Purge does not cancel upcoming lessons before deletion - orphaned lessons remain and can trigger notification emails to deleted users
- Purge does not clean up cross-portal profiles - purging a teacher does not remove a student profile on the same auth user
- Purge does not invalidate active sessions - purged users retain portal access until their JWT expires. Fix: call auth.admin.signOut(userId) before deletion
- Database trigger auto-creates a teacher profile row for every new Supabase auth user - student account creation silently generates a ghost teacher record
- Create student form - "To be assessed" fluency level rejected by server-side validation - should save as null
- Student self-assessed level has no "I am not sure" option - should map to null
- Countdown format on teacher portal shows hours only (71h 19m 44s) - should show days and hours like student portal (2d 23h 19m)
- Request reschedule modal title and button label are inconsistent

### Session result
This session completed a full audit of six critical systems identified in the Session 65 handover. Double booking prevention was absent at both the application and database level and has now been added. Sentry was installed but never wired up and is now confirmed live and capturing errors. The TEAMS_LINK_PENDING sentinel string was silently bypassing the admin dashboard alert and has been corrected. Teacher timezone display was using the browser clock rather than the teacher's profile setting. The company billing CSV was missing its amount column entirely. All six items are now resolved. A separate list of lower-priority bugs was identified during exploratory testing and will be addressed in the next session.

---

## Session 65 - 28 April 2026 - Calendar and Booking System Overhaul

### What was built
- Fixed student and admin portal browser tab titles - both were inheriting "Teacher Portal" from root layout. Added correct metadata exports to src/app/(student)/student/layout.tsx and src/app/(admin)/layout.tsx
- Fixed DayToDay calendar showing no booked lessons - root cause was three bugs: wrong table name ('classes' instead of 'lessons'), wrong column names ('starts_at'/'ends_at' instead of 'scheduled_at'/'duration_minutes'), and missing Array.isArray() guard on the students join
- Fixed hours not rolling back on booking failure - if trainings.hours_consumed update failed after lesson insert, the lesson now gets deleted before returning a 500 error. Previously the lesson persisted with no hours deducted, corrupting the training balance
- Added revalidatePath('/schedule') to both availability API route handlers (POST and DELETE) so the schedule page cache invalidates correctly after availability changes
- Fixed General Availability default scroll position - was opening at 06:00 (offset 264), corrected to 08:00 (offset 8 * 2 * 22 = 352)
- Cleaned up localToUtc() DST handling in admin booking route - same correct algorithm, reduced from 20 lines to 12
- Added Supabase Realtime subscription to DayToDay.tsx - teacher calendar now updates in real time when any lesson is created, updated, or cancelled, without a page reload. Uses a visibleRangeRef to always fetch the currently visible week
- Added 30-second router.refresh() poll to student my-classes page - catches external changes (admin or teacher cancellations) without restructuring the server-component architecture
- Added availability warning modal to admin class booking flow - when admin selects a slot outside the teacher's set availability, an amber warning appears before proceeding. Admin can proceed anyway (intentional override) or go back and adjust. Warning clears automatically if date or time is changed
- Fixed critical session security issue in admin portal - the admin layout was using a hand-rolled Supabase SSR client with a silent no-op setAll() function, causing token refreshes to be silently discarded. Replaced with createClient() from @/lib/supabase/server matching all other layouts
- Changed admin layout profile query from anon client to createAdminClient() so the role check cannot silently fail due to RLS policy gaps
- Added explicit null profile guard in admin layout - null profile now redirects to /login?error=profile_error instead of falling through silently to /dashboard
- Added missing prefetch={false} on mobile sidebar "Back to Teacher Portal" link in AdminLayoutClient.tsx - desktop version had it, mobile did not
- Moved createBrowserClient into a useRef in AdminLayoutClient.tsx so the Supabase client is created once, not on every render
- Fixed dashboard layout admin profile query from .single() to .limit(1).maybeSingle() to prevent PostgREST error when multiple admin profiles exist
- Audited all layout files (student, root, student-auth) against the same four criteria - all confirmed clean

### Break/Fix Log
Issue 1: DayToDay calendar showing no booked lessons / Cause: Query used wrong table name 'classes', wrong column names 'starts_at' and 'ends_at', and accessed students join without Array.isArray() guard / Fix: Corrected to 'lessons' table, 'scheduled_at' and 'duration_minutes' columns, computed end time as scheduled_at + duration_minutes, added Array.isArray() guard / Lesson: Always verify table and column names against a working query elsewhere in the codebase before writing a new one

Issue 2: Hours balance corruption on booking failure / Cause: If the hours deduction update failed after lesson insert, execution continued with only a console.error log - lesson persisted, hours not deducted / Fix: Added compensating delete of the lesson if hours update fails, then returns 500 / Lesson: Any two-step write operation that is not in a transaction needs explicit rollback logic on the second step

Issue 3: Availability saves showing stale data after navigation / Cause: Availability API routes had no revalidatePath call, so Next.js server cache was never invalidated after saves / Fix: Added revalidatePath('/schedule') to success path of both POST and DELETE availability route handlers

Issue 4: Admin could book outside teacher availability with no warning / Cause: Admin booking flow had no availability awareness - Step 4 was a bare date/time picker with no checks / Fix: Added availability fetch on Continue, with amber warning modal if selected slot is outside teacher's availability. Admin retains override ability via "Proceed anyway"

Issue 5: Users navigating to admin portal were occasionally redirected and ended up authenticated as a different account / Cause: Admin layout created its own inline Supabase SSR client with setAll(){} as a complete no-op. Token refreshes were silently discarded during admin layout rendering, leaving the browser with a stale session cookie. Next navigation failed authentication, triggered a redirect to /login, and browser autofill or cached credentials logged the user in as a different account. A second connected bug - null profile from a failed RLS query - was treated identically to a non-admin user, causing silent redirect to /dashboard / Fix: Replaced inline client with createClient() from server.ts, changed profile query to createAdminClient(), added explicit null profile guard that redirects to /login?error=profile_error. Also fixed missing prefetch={false} on mobile sidebar link and moved createBrowserClient to useRef in AdminLayoutClient / Lesson: Every layout must use the shared createClient() factory - never a hand-rolled SSR client. A no-op setAll is not harmless, it silently breaks token rotation. Null profile must always be handled as a distinct error case, never conflated with a permission failure.

### Session result
This session addressed the core booking and calendar reliability issues that had been present since the initial build. The DayToDay calendar was silently broken - querying a non-existent table - meaning booked lessons never appeared on the teacher's schedule view. Combined with the addition of Supabase Realtime and the 30-second student poll, the platform now reflects booking state in real time across all three portals. Data integrity is strengthened by the hours rollback fix. A full audit was also conducted across all booking and scheduling code, identifying remaining critical items to address in the next session - server-side double booking prevention, cron job verification, Teams link failure handling, invoice calculation accuracy, timezone display correctness, and Sentry configuration on live.

---

## Session 64 - 27 April 2026 - Hardening Verification and Bug Fixes

### What was built

- Verified Step 14 hardening status item by item - rate limiting confirmed wired into login action via `src/lib/rateLimit.ts` and `createAdminClient()`, security headers confirmed in `next.config.ts`, `NEXT_PUBLIC_SITE_URL` confirmed set to `https://app.lingualinkonline.com` in Vercel, GitHub branch protection confirmed correct for solo developer workflow
- Added MIME type validation to `src/app/api/messages/upload/route.ts` - allowed types: image/jpeg, image/png, image/webp, image/gif, application/pdf
- Fixed Join Class button appearing on cancelled and completed classes - added `BLOCKED_STATUSES` check to `src/components/layout/RightPanel.tsx`, `src/components/student/layout/StudentRightPanel.tsx`, `src/app/(dashboard)/students/[id]/StudentDetailClient.tsx`, `src/app/(student)/student/my-classes/MyClassesClient.tsx`, and `src/components/student/ClassReminderModal.tsx`
- Fixed Join Class button appearing on expired/past lessons - added 2-hour lookback filter to layout queries and end-time expiry check to all render sites
- Added Material as a third study sheet category alongside Vocabulary and Grammar - sky-blue badge, supports PDF/Word/PowerPoint/image uploads, view-only for teachers and students, no download
- Fixed category casing mismatch - admin was storing lowercase, student UI was filtering Title Case, causing student category filters to never match. Standardised to Title Case everywhere
- Made difficulty optional on all study sheet types - label updated, API validation updated
- Made level optional on all study sheet types - Not specified added as default option, API coerces empty string to null
- Added missing level variants (A1+, A2+, B1+, B2+, C1+) to student study filter dropdown
- Added To be assessed option to Current Fluency Level dropdown in admin student creation and edit forms
- Blocked assignment of empty study sheets - Vocabulary sheets require at least 1 word, Grammar sheets require at least 1 exercise, Material sheets require at least 1 uploaded file. Empty sheets are greyed out with No content yet label in the assignment modal and admin library
- Built DELETE /api/admin/assignments/[id]/route.ts - admin only, uses createAdminClient()
- Added Assignments tab to admin student detail page - shows all assigned sheets with category badge, level, source (Direct or From Class), date, and inline two-step Revoke button with optimistic row removal
- Added read-only Assigned Study Sheets section to teacher-facing student detail page
- Fixed hard-coded Lingualink Admin in homework assigned email - now looks up real admin name from profiles table
- Fixed assignments query using wrong column names - corrected to use lesson_id and explicit FK notation study_sheets!assignments_study_sheet_id_fkey

### Break/Fix Log

Issue 1: Join Class button active on cancelled class in right panel - Condition only checked time, not lesson status / Added BLOCKED_STATUSES constant and status check to both RightPanel components and all other Join button render sites / Always check both time and status before activating any Join button

Issue 2: Join Class button active on expired past lessons - Math.max(0) clamps negative secondsUntil to 0 which satisfies the 10 min check, stale scheduled lessons from early April were never marked completed / Added 2-hour lookback filter to layout queries and end-time expiry check at all render sites / Always filter by both status and time window at the query level, not just at render time

Issue 3: Category casing mismatch between admin and student portals - Admin stored lowercase, student filtered Title Case, exact string match always failed / Standardised to Title Case across all dropdowns, badges, and filters / Confirm casing is consistent end-to-end when adding new category values

Issue 4: Empty study sheets assignable to students - No content validation on assignment, students received pending sheets with nothing to complete / Added per-category empty check in AssignStudySheetsModal and LibraryAdminClient / Validate content before allowing assignment not just after

Issue 5: Assignments tab showing 0 despite data existing - Query used non-existent column report_id and ambiguous FK join / Corrected to lesson_id and explicit FK notation / Always verify actual column names against the database schema before writing queries

Issue 6: Homework assigned email showing Lingualink Admin instead of real name - Hard-coded string in admin direct-assign route / Replaced with profiles table lookup using authenticated user ID / Never hard-code display names in email templates, always look up from the database

### Session result

This session was a hardening verification and bug fixing pass driven by workflow simulation testing. Step 14 hardening was confirmed complete with one gap found and closed - MIME type validation added to the messages upload route. Several bugs were resolved including the Join Class button appearing on cancelled and expired lessons across multiple components. New features added include the Material study sheet category with view-only file rendering, optional difficulty and level fields, and a full assignment management system allowing the client to revoke assignments from the student detail page with inline confirmation.

---

## Session 63 - 27 April 2026 - Audit Pass: Outlook Email Fix, Link Prefetch, Auth Hardening, TypeScript Cleanup

### What was built

- Confirmed src/app/api/test-emails/route.ts was already deleted from the previous session - no action needed
- Replaced all 11 email buttons in src/lib/email/templates.ts with a new buildButton() helper that outputs VML v:roundrect for Outlook and a standard anchor tag for all other clients - fixes square corner rendering in Outlook caused by CSS border-radius being ignored on anchor tags
- Fixed src/app/api/announcements/dismiss/route.ts - was trusting userId from the request body; now calls getUser() and uses the verified session user ID instead
- Added prefetch={false} to all Link tags found missing it across 5 files: EditClassClient.tsx (2 tags), ClassesListClient.tsx (2 tags), ReportDetailClient.tsx (1 tag), ReportsClient.tsx (2 tags), DashboardClient.tsx (4 tags) - full codebase scan confirmed zero remaining after fixes
- Fixed TypeScript errors in StudentsListClient.tsx and TeachersListClient.tsx - alt attributes now coerce null to empty string via nullish coalescing, and the teacher search filter no longer calls toLowerCase() on a potentially null full_name

### Break/Fix Log

Issue 1: Outlook renders email buttons with square corners
Symptom: Orange CTA buttons displayed without rounded corners in Outlook desktop.
Cause: Outlook ignores CSS border-radius on anchor tags entirely.
Fix: Introduced buildButton(href, label) helper in templates.ts that wraps every button in VML conditional comments - the mso block renders a v:roundrect with arcsize 13%, the non-mso block renders the standard anchor tag. All other clients ignore the VML block.
Lesson: Outlook requires VML for rounded buttons - CSS alone will never work.

Issue 2: Announcement dismiss route trusted client-supplied userId
Symptom: The dismiss endpoint accepted userId from the POST body without verifying the caller.
Cause: Original implementation passed userId from the client rather than reading it from the server session.
Fix: Route now calls getUser() first and uses user.id from the verified session. userId removed from the request body entirely.
Lesson: Never trust identity data from the request body - always derive it from the verified server session.

Issue 3: Link tags missing prefetch={false}
Symptom: Several Link components across admin pages were missing the required prefetch={false} prop.
Cause: Some were missed during original build, others were found during this audit pass.
Fix: Full codebase scan using PowerShell confirmed all instances - all fixed and re-scanned to zero remaining.
Lesson: After any audit fix, always re-run the scan to confirm zero remaining instances.

Issue 4: TypeScript errors in admin list components
Symptom: tsc --noEmit reported 3 errors - null not assignable to string or undefined on alt attributes, and toLowerCase() called on possibly null full_name.
Cause: full_name typed as string or null but used in contexts expecting string or undefined.
Fix: Applied nullish coalescing (?? '') to alt attributes and the search filter. TypeScript check now passes with zero errors.
Lesson: Run tsc --noEmit at the start of every session to catch pre-existing type errors before adding new code.

### Session result

Full audit pass session with no new features built. Identified and resolved four categories of issues across the codebase - Outlook email button rendering, missing Link prefetch props, an auth hardening gap in the announcement dismiss route, and pre-existing TypeScript errors. The codebase now passes tsc --noEmit with zero errors and every Link tag has prefetch={false}. No regressions introduced.

---

## Session 61 - 25 April 2026 - Email System Audit, Bug Fixes, and Missing Notifications

### What was built

- Fixed the Past Classes tab on the individual student detail page - the lessons query was filtering by `.eq('training_id', id)` where `id` was the URL route param. The route param is a training ID (the student list navigates using `training.id`), so the training fetch was corrected to `.eq('id', id)` and the lessons query left to use `id` directly.
- Fixed a 404 error on all student detail page links - root cause was the same misidentified param.
- Fixed Past Trainings on the Students and Trainings list page - the split was purely status-based, requiring manual status changes by the client for every completed training. Changed to a date-driven split using `end_date` so trainings automatically move to Past Trainings when their end date passes.
- Conducted a full email audit across the entire codebase and mapped findings against all three portal briefs.
- Removed the MS Teams join link from all emails except the 1-hour class reminder - previously the link appeared in booking confirmations and reschedule emails which was incorrect per the brief.
- Added student cancellation emails - student receives a confirmation and teacher receives a notification when a student cancels a class.
- Added teacher cancellation confirmation email - teacher now receives a confirmation email when they cancel or reschedule a class.
- Added message notification emails - when a teacher sends a message the student receives an email notification, and when a student sends a message the teacher receives an email notification.
- Added homework assigned email - student receives an email when a teacher assigns study sheets from a class report or when admin assigns directly from the library.
- Added report overdue cron job at `/api/cron/report-overdue` - runs daily at 08:00 UTC, identifies lessons past the 12-hour report deadline with no completed report, and emails the teacher. Requires `report_overdue_sent` boolean column on lessons table - migration applied.
- Added monthly invoice reminder cron job at `/api/cron/invoice-reminder` - runs on the 1st of every month at 08:00 UTC, emails all active teachers to upload their invoice between the 1st and 10th.
- Added invoice paid notification - teacher receives an email when the client marks their invoice as paid in the admin billing section.
- Added new student assigned notification - when the client creates a new student and assigns teachers, each assigned teacher receives an email introducing the student.
- Added training ending soon cron job at `/api/cron/training-ending-soon` - runs daily at 08:00 UTC, emails students 14 days before their training end date. Requires `training_ending_soon_sent` boolean column on trainings table - migration applied.

### Break/Fix Log

Issue 1
- Symptom: Past Classes tab on student detail page showed "No past classes yet" for all students
- Cause: The lessons query used `.eq('training_id', id)` where `id` was the URL route param. The param is a training ID passed from the student list via `router.push('/students/' + training.id)`, but the training fetch was querying `.eq('student_id', id)` - meaning it was looking for a training where student_id equals the training ID. No match was ever found.
- Fix: Changed training fetch to `.eq('id', id)` and left the lessons query using `id` directly since `id` is already the training ID.
- Lesson: Always trace the full data flow from URL param to query before assuming a code bug. The param name `id` inside a `[id]` route gives no indication of what entity it actually represents.

Issue 2
- Symptom: Clicking any student on the Students and Trainings page produced a 404
- Cause: Same root cause as Issue 1 - the training fetch was using the wrong field to match.
- Fix: Resolved by the same fix as Issue 1.
- Lesson: One wrong assumption in a server component can silently break an entire section of the portal.

Issue 3
- Symptom: Past Trainings column always showed 0 regardless of how many students had finished training
- Cause: The split used `status === 'active'` but all trainings had status 'active' - there was no mechanism to change status automatically and no UI for the client to do it efficiently at scale.
- Fix: Changed the split to use `end_date` - trainings with a past end date go to Past Trainings automatically.
- Lesson: Any data split that requires manual admin action to maintain does not scale. Always prefer computed or date-driven splits where the business logic allows it.

### Session result

This session resolved three interconnected bugs on the student detail and list pages, then conducted a full audit of the email system against all three portal briefs. Eleven email gaps were identified and all eleven were addressed - including new cron jobs, new API routes, and wiring of existing unused email templates. The Teams join link is now correctly restricted to the 1-hour reminder only. Two database migrations were applied for the new cron guard columns. All changes committed and pushed to the dev branch.

---

## Session 60 - 24 April 2026 - Live Test Bug Fixes & Teacher Portal Repairs

### What was built

- Teacher upcoming classes page fixed to query the `lessons` table instead of the abandoned `classes` table - all admin-booked classes now appear correctly
- `lesson_notes` removed from the lessons query (column does not exist on `lessons` table) - was causing a silent Supabase error returning empty results
- Lessons query switched to `createAdminClient()` to bypass RLS - the regular server client was silently returning no rows for the teacher session
- Admin SELECT policy added to `lessons` table in Supabase
- Join Class button window changed from 15 minutes to 10 minutes across teacher portal (UpcomingClassesClient) and right panel (RightPanel)
- Join Class button now hides after class end time (calculated as `scheduled_at + duration_minutes`) - previously remained visible indefinitely after class ended
- Reschedule button hidden entirely within 24 hours of class start - no greying out, no tooltip, simply absent
- Reschedule flow implemented: teacher clicks Reschedule - modal opens requiring a mandatory message to the student - on send, lesson is cancelled, hours refunded, message inserted into messages table, student receives cancellation email
- New server action `teacherRescheduleLesson` created at `src/app/(dashboard)/upcoming-classes/actions.ts` - enforces 24-hour rule server-side, verifies lesson ownership, cancels with status `cancelled`, refunds training hours, sends message and email
- Message button added to expanded class card - navigates to `/messages?studentId=<id>` to pre-open the correct conversation
- Messages page `studentId` query param resolution switched to `createAdminClient()` - regular client was blocked by RLS causing the deep-link to silently fail
- Booking confirmation emails implemented in admin class booking route - both teacher and student now receive branded confirmation emails immediately on booking
- `formatTime` function in MessagesClient rewritten with manual date construction - was using locale-dependent formatting causing server/client hydration mismatch
- Teacher messages contacts list fixed to match by `auth_user_id` instead of `students.id` - contacts were showing as Unknown because `receiver_id` in the messages table stores the auth UUID not the students table primary key
- Admin messages contacts list fixed with the same `auth_user_id` matching fix
- Student detail page 404 fixed - page was querying `trainings.eq('id', studentId)` (wrong column) and using the regular client (RLS blocked the students join). Fixed to `.eq('student_id', id)` and switched all three queries (trainings, lessons, reports) to `createAdminClient()`
- Student name in upcoming class cards made clickable - links to `/students/<id>` with `stopPropagation` so card expand/collapse still works
- Admin messages view made fully read-only - composer and send button removed, replaced with a static banner: "This is a read-only view of the conversation between [teacher] and [student]." Support section and direct messaging from other parts of the platform unaffected
- `auth_user_id` data integrity resolved for existing student records - root cause identified as students added before the admin creation flow was fully implemented. Fixed by matching `auth.users` on email and updating `students.auth_user_id` via SQL. Admin creation route confirmed to set `auth_user_id` correctly for all new students going forward
- `.npmrc` confirmed in repo root with `legacy-peer-deps=true` to fix CI pipeline failures caused by emoji-mart React 19 peer dependency conflict

### Break/Fix Log

**Issue 1 - Teacher upcoming classes showing empty despite bookings existing**
- Symptom: Teacher portal showed "No upcoming classes" even though classes had been booked through admin
- Cause: The upcoming classes page queried the `classes` table. All admin bookings write to the `lessons` table. These are two separate tables - nothing ever writes to `classes` making it permanently empty
- Fix: Updated `src/app/(dashboard)/upcoming-classes/page.tsx` to query `lessons` instead of `classes`, mapping `scheduled_at` to `starts_at`, calculating `ends_at` from `scheduled_at + duration_minutes`, and mapping `teams_join_url` to `teams_link` to match the shape the client component expected
- Lesson: When two parts of the app write and read from different tables for the same entity, data will never appear. Always verify which table an API route actually writes to before building the read side

**Issue 2 - Silent Supabase error on lessons query**
- Symptom: Even after switching to the `lessons` table, the query returned an empty error object `{}`
- Cause: The select included `lesson_notes` which does not exist as a column on the `lessons` table. Supabase returns a silent error object when a non-existent column is selected
- Fix: Removed `lesson_notes` from the select and set `lesson_notes: null` in the mapping instead
- Lesson: Supabase does not throw a clear error for missing columns - it returns `{}` which looks like a network or auth issue. Always verify column names against the actual table schema before writing queries

**Issue 3 - Contacts showing as Unknown in teacher and admin messages**
- Symptom: Message threads sent to students appeared as Unknown in the contacts list on both teacher and admin messages pages
- Cause: The contacts list extracted `receiver_id` from the messages table (which stores `auth.users.id`) and then looked up the student name by matching against `students.id` (a different UUID). The two IDs never matched so full_name was never found
- Fix: Updated both the student fetch query and the `.find()` match to use `auth_user_id` consistently in both teacher messages page and admin messages page
- Lesson: The messages table uses auth UUIDs as sender/receiver identifiers. The students table has its own primary key UUID. These are different values. Always join via `auth_user_id` when resolving student identity from a message record

**Issue 4 - Student detail page returning 404**
- Symptom: Clicking a student name in the teacher portal returned a 404 page
- Cause: The student detail page queried `trainings` with `.eq('id', studentId)` - passing the student UUID to the training ID filter. No training matched so the page called `notFound()`. Additionally the regular Supabase client was blocked by RLS on the students join
- Fix: Changed filter to `.eq('student_id', id)` and switched all three queries (trainings, lessons, reports) to `createAdminClient()`
- Lesson: Always verify which column a filter applies to. Passing the wrong UUID to the wrong column fails silently with no rows returned

**Issue 5 - Reschedule message routing to wrong student**
- Symptom: Teacher reschedule message was delivered to the wrong student
- Cause: Two students had the same `auth_user_id` value - one student row had been manually linked to the wrong auth account during a previous data fix attempt
- Fix: Located the correct auth account via `auth.users` by email and updated `students.auth_user_id` to the correct UUID
- Lesson: Always verify `auth_user_id` uniqueness across student records after any manual data operations. Two students sharing an auth ID will cause messages and auth-dependent features to bleed between accounts

### Session result

Session 60 was a focused bug-fix session addressing failures discovered during a live platform test. The most critical fix was the upcoming classes page being permanently empty because admin bookings write to `lessons` while the teacher portal was reading from the abandoned `classes` table. A chain of follow-on fixes resolved silent Supabase errors, RLS blocks, and student identity mismatches across the messages system. The reschedule flow was built from scratch - mandatory teacher message, server-side 24-hour enforcement, lesson cancellation, hours refund, and student email notification. The admin messages view was made read-only. By end of session the core booking and communication loop was working end to end - admin books a class, teacher sees it, teacher can reschedule with a mandatory message to the student, student receives the cancellation email and the personal message in their inbox.

---




## Session 57 - 20 April 2026 - Custom Domain, Auth Fixes & Form Improvements

### What was built

- Custom domain app.lingualinkonline.com configured in Vercel and DNS CNAME record added by domain manager - domain live and green with valid SSL certificate
- NEXT_PUBLIC_SITE_URL updated in Vercel environment variables from http://localhost:3000 to https://app.lingualinkonline.com
- Supabase URL Configuration updated - Site URL changed to https://app.lingualinkonline.com, wildcard redirect URL https://app.lingualinkonline.com/** added to whitelist
- Client login email updated from the previous address to info@lingualinkonline.com in both auth.users and profiles table via SQL
- returnUrl pattern implemented in proxy.ts and both login components - navigating to a protected route while logged out now preserves the intended destination and redirects there after login
- Contact emails corrected on login pages - teacher login shows teachers@lingualinkonline.com, student login shows support@lingualinkonline.com
- Self-assessed level field removed from Add Student form and Zod validation schema - the client assesses all students herself
- Hardcoded default email removed from Add Student and Add Teacher forms - both email fields now start empty
- autoComplete="off" added to email fields and autoComplete="new-password" added to password fields on Add Student and Add Teacher forms to prevent browser credential autofill
- Unauthorised error on student creation resolved - root cause was inline Supabase client with empty setAll() causing token refresh failures
- IBAN and SWIFT/BIC fields replaced with a single free-text banking_details textarea on Add Teacher form - more flexible for teachers across different banking systems
- Database column added: banking_details text on profiles table

### Break/Fix Log

**Issue 1 - Student creation returning Unauthorised**
- Symptom: The client received an Unauthorised error when attempting to create a new student account from the admin portal
- Cause: The student creation API route was using an inline Supabase client with an empty setAll(){} implementation. When the session token expired and Supabase attempted to refresh it, the new token could not be persisted. Supabase then found no valid session and returned null from getUser(), treating the request as unauthenticated
- Fix: Replaced the inline client with createServerSupabaseClient() from src/lib/supabase/server.ts which correctly implements setAll and handles token refresh properly
- Lesson: Never create inline Supabase server clients in API routes. Always use the shared createServerSupabaseClient() helper. A missing or empty setAll() fails silently on active sessions but breaks on any token refresh

**Issue 2 - Admin portal not redirecting correctly after login**
- Symptom: Navigating to /admin while logged out redirected to /login but after login the user landed on /dashboard instead of /admin
- Cause: proxy.ts was redirecting unauthenticated users to /login without preserving the intended destination. The login components always redirected to the default dashboard after successful login regardless of where the user was trying to go
- Fix: Updated proxy.ts to append the intended path as a returnUrl query parameter on redirect. Updated both teacher and student login components to read returnUrl after successful login and redirect there if it starts with /. Added validation to ensure returnUrl must start with / to prevent open redirect attacks
- Lesson: Always preserve intended destination on auth redirects. Validate returnUrl server-side - only accept values starting with /

**Issue 3 - Browser autofilling credentials into Add Student and Add Teacher forms**
- Symptom: When opening the Add Student or Add Teacher form, the email field was pre-populated with the client's saved login email and the password field was pre-populated with her saved password
- Cause: Two separate issues - the email field had info@lingualinkonline.com hardcoded as a default value from a previous session, and the browser was autofilling credentials into fields labelled email and password
- Fix: Removed the hardcoded default email value from both forms. Added autoComplete="off" to email fields and autoComplete="new-password" to password fields to prevent browser autofill
- Lesson: Never hardcode admin credentials as default values in forms. Always add appropriate autoComplete attributes to forms that are not login forms

### Session result

Session 57 focused on taking the platform from the Vercel preview URL to a fully configured production domain. The custom domain app.lingualinkonline.com is now live with valid SSL, all Supabase auth redirects are correctly configured, and the client's login credentials have been updated to her preferred email address. Three meaningful bugs were resolved - the Unauthorised error blocking student creation, the broken returnUrl redirect pattern, and browser credential autofill on admin forms. The banking details field on the Add Teacher form was simplified from rigid IBAN and SWIFT/BIC fields to a flexible free-text textarea to accommodate teachers across different banking systems. The platform is in a strong state ahead of the MS Teams integration test planned for the next session.

---

## Session 56 - 19 April 2026 - Visual Polish Pass Across All Portals

### What was built
- src/components/layout/RightPanel.tsx - section labels replaced with orange bar accent pattern; card backgrounds changed to bg-white; aside background changed to #f9fafb
- src/components/student/layout/StudentRightPanel.tsx - all four sections wrapped in white cards; aside background changed to #f9fafb; gap and padding tightened
- src/app/(dashboard)/upcoming-classes/UpcomingClassesClient.tsx - page title bottom border separator added
- src/app/(dashboard)/reports/ReportsClient.tsx - page title border added; Pending Reports and Completed Reports sub-headings replaced with orange bar pattern; divider added between sections
- src/app/(dashboard)/reports/[id]/ReportClient.tsx - all report form section headings replaced with orange bar pattern; skill row dividers added; CEFR guide grid layout applied; level button fixed widths added
- src/app/(dashboard)/schedule/ScheduleClient.tsx - page title border added; Holidays, Add unavailability period, Planned Unavailability headings replaced with orange bar pattern
- src/app/(dashboard)/students/StudentsClient.tsx - page title border added; Current Trainings and Past Trainings headings replaced with orange bar pattern
- src/app/(dashboard)/study-sheets/StudySheetsClient.tsx - page title border added
- src/app/(dashboard)/billing/BillingClient.tsx - page title border added
- src/app/(dashboard)/account/AccountClient.tsx - page title border added
- src/app/(student)/student/my-classes/MyClassesClient.tsx - page title border added; Book a Class button moved into header flex row
- src/app/(student)/student/past-classes/PastClassesClient.tsx - page title border added
- src/app/(student)/student/progress/ProgressClient.tsx - page title border added; Training Overview, Level Tracker, Class History, Exercises Progress headings replaced with orange bar pattern
- src/app/(student)/student/study/StudyClient.tsx - page title border added
- src/app/(student)/student/account/AccountClient.tsx - page title border added; Profile Photo, General Information, Learning Profile, Hours and Training, Training History, Change Password headings replaced with orange bar pattern
- src/app/(admin)/AdminLayoutClient.tsx - live unread count state and Supabase realtime subscription added for messages and support badges; liveUnreadMessages and liveUnreadSupport replace static props in NavLink badge logic
- src/app/(admin)/admin/messages/AdminMessagesClient.tsx - optimistic message replaced with real inserted message from server action; duplicate-id guard added
- src/app/(admin)/admin/messages/actions.ts - sendAdminMessage now chains .select().single() and returns inserted message
- src/app/(admin)/admin/support/AdminSupportClient.tsx - read_at: null added to optimistic message to fix TypeScript build error
- src/app/(admin)/admin/AdminDashboardClient.tsx - page title border added; Today's Classes and Pending Reports headings replaced with orange bar pattern; AT A GLANCE label replaced with orange bar pattern
- src/app/(admin)/admin/teachers/TeachersListClient.tsx - page title border added
- src/app/(admin)/admin/students/StudentsClient.tsx - page title border added
- src/app/(admin)/admin/companies/CompaniesListClient.tsx - page title border added
- src/app/(admin)/admin/classes/ClassesListClient.tsx - page title border added
- src/app/(admin)/admin/reports/ReportsAdminClient.tsx - page title border added
- src/app/(admin)/admin/billing/BillingAdminClient.tsx - page title border added
- src/app/(admin)/admin/library/LibraryAdminClient.tsx - page title border added
- src/app/(admin)/admin/announcements/AnnouncementsClient.tsx - page title border added; ACTIVE and INACTIVE section headings replaced with orange bar pattern
- src/app/(admin)/admin/tasks/TasksClient.tsx - page title border added
- src/app/(admin)/admin/exports/ExportsClient.tsx - page title border added
- src/app/(admin)/admin/settings/SettingsClient.tsx - page title border added

### Break/Fix Log
Issue 1: Vercel build failed on dev branch / TypeScript error - read_at missing from optimistic message object in AdminSupportClient.tsx / Added read_at: null to the optimistic message / Always include all required fields from the interface when building optimistic UI objects

Issue 2: Student right panel cards not visible / Card backgrounds were white on a white aside background - no contrast / Changed aside background to #f9fafb so white cards sit visibly on top

Issue 3: Teacher right panel cards not visible / Same root cause - bg-gray-50 cards on a bg-gray-50 aside / Changed card sections to bg-white

Issue 4: Page title border not spanning full width / Border wrapper div was narrower than the content area / Added width: 100% to all border wrapper divs; restructured headers with flex space-between to include action buttons inside the bordered row

Issue 5: Admin Messages badge not clearing / AdminLayoutClient used static unreadMessagesCount prop with no realtime subscription / Added useState and useEffect with Supabase realtime channel listening for INSERT and UPDATE events on messages and support_messages tables

Issue 6: Admin Messages ticks not updating / Optimistic message used crypto.randomUUID() as ID - real INSERT arrived via realtime with different ID causing duplicate; UPDATE matched real ID but not fake one / Removed optimistic message pattern; sendAdminMessage now returns inserted record; client appends real message directly with duplicate-id guard

### Session result
A full visual polish pass was completed across all three portals - teacher, student, and admin. Every page received a consistent bottom-border page title separator and orange bar accent treatment on sub-section headings. The right panel widgets on both teacher and student portals were given proper card styling with white backgrounds on a light grey aside. Two functional bugs were also fixed - the admin messages nav badge now updates in real time without a page refresh, and message read ticks now correctly flip from single grey to double orange when the recipient reads the message. The Vercel build error from the previous session was resolved. All changes were CSS and layout only except for the two messaging fixes, and no existing functionality was broken.

---

## Session 55 - 19 April 2026 - Support Chat, Messaging Fixes and Live Nav Badges

### What was built
- src/components/ChatWidget.tsx - fully decoupled from left nav Messages tab; writes to support_messages table only; fetches FAQs from DB filtered by participant_type; unread badge on bubble; marks admin messages as read on open; temp message replaced with real DB message so ticks flip correctly
- src/app/api/support/send/route.ts - new API route writing to support_messages; all message notification emails removed
- src/app/(admin)/admin/support/page.tsx - new admin support inbox; conversations grouped by participant; the client can read and reply to teacher support messages
- src/app/(admin)/admin/support/AdminSupportClient.tsx - two-panel support UI with FAQs tab; the client can add/edit/delete/toggle FAQs; read ticks on sent messages; conversation unread badge clears on open; realtime UPDATE listener for tick flips; student FAQ audience options removed
- src/app/(admin)/AdminLayoutClient.tsx - Support nav item added with unread badge
- src/app/(admin)/layout.tsx - unread support messages count added and passed to AdminLayoutClient
- src/app/(student)/student/layout.tsx - ChatWidget removed from student portal entirely
- src/app/(dashboard)/layout.tsx - ChatWidget hidden for admin role; userId passed to LeftNav
- src/app/(dashboard)/messages/actions.ts - message notification emails removed; booking and cancellation emails untouched
- src/app/(student)/student/messages/actions.ts - message notification emails removed
- src/app/(dashboard)/messages/page.tsx - createAdminClient added; student name lookups and assigned student queries switched to admin client fixing Unknown contact bug and teacher student search; allStudents filtered to assigned students only via trainings table
- src/components/layout/LeftNav.tsx - userId prop added; realtime Supabase subscription updates unread badge live without page refresh
- src/components/student/layout/StudentLeftNav.tsx - unreadMessageCount prop and badge added; userId prop added; realtime subscription updates badge live
- src/app/(student)/student/layout.tsx - unread message count query added; userId and unreadMessageCount passed to StudentLeftNav
- src/app/(admin)/admin/messages/AdminMessagesClient.tsx - ReadTicks component added; realtime UPDATE listener added; ticks show on sent messages
- src/app/(student)/student/messages/StudentMessagesClient.tsx - formatTime and date separator fixed to use manual string construction
- Supabase SQL editor - support_user_mark_read RLS policy added on support_messages table allowing participants to mark their own messages as read

### Break/Fix Log
Issue 1: Support chat bubble badge persisting after reading on refresh / Cause: RLS policy missing - teacher update to mark admin messages as read was silently blocked / Fix: added support_user_mark_read policy on support_messages / Lesson: Supabase silently blocks writes with no error when RLS is missing - always verify before assuming a write failed

Issue 2: Student contact showing as Unknown in teacher Messages / Cause: regular Supabase client blocked by RLS from reading students table / Fix: switched all student lookups in messages/page.tsx to createAdminClient() / Lesson: never use the regular client for reads on restricted tables

Issue 3: Teacher could not find assigned students in New Message picker / Cause: same RLS block on trainings and students queries / Fix: switched both to createAdminClient() / Lesson: same as above

Issue 4: Tick never flipping from grey to orange on support chat / Cause: optimistic update used a temp UUID that realtime UPDATE could not match to the real DB record / Fix: replaced temp message with real DB message returned from API response / Lesson: optimistic messages must be replaced with real DB records before relying on realtime UPDATE matching

Issue 5: Nav badges requiring page refresh to clear / Cause: unread counts were static server-side props / Fix: added Supabase realtime subscriptions in LeftNav and StudentLeftNav listening for INSERT and UPDATE on messages table / Lesson: static server props need realtime subscriptions on the client side for live badge updates

Issue 6: Runtime error on messages page after edits / Cause: stale Turbopack cache / Fix: deleted .next directory and restarted dev server / Lesson: clear .next when Turbopack throws reference errors that do not match actual code

### Session result
Support chat fully decoupled from regular messaging. Teachers contact the client via the bubble and messages land in a dedicated admin Support inbox separate from teacher/student Messages. FAQs managed by the client from the admin portal, teachers only. Message notification emails removed platform-wide to stay within Resend limits. Unknown student bug fixed, teacher student search fixed, live nav badges working without page refresh across all portals. Read ticks working on support chat, admin messages, and teacher and student portal messages.

---


## Session 54 - 18 April 2026 - Admin Messages, Login Cleanup, Email Logo Fix

### What was built
- src/app/(admin)/admin/messages/page.tsx - new server component, fetches all platform messages grouped by teacher/student conversation pair
- src/app/(admin)/admin/messages/AdminMessagesClient.tsx - two-panel chat UI, the client can read and send into any thread, real-time via Supabase channel
- src/app/(admin)/admin/messages/actions.ts - sendAdminMessage, markAdminThreadRead, getAdminThreadMessages server actions
- src/app/(admin)/admin/layout.tsx - unread messages badge added to Messages nav item, Messages nav item added
- src/app/(admin)/admin/messages/page.tsx - TS fix: attachments added to RawMessage type and Supabase select
- src/app/(admin)/admin/teachers/create/CreateTeacherClient.tsx - preferred_payment_type field added to create form
- src/app/login/page.tsx - subtitle removed, forgot password updated to teachers@lingualinkonline.com
- src/app/(student)/student/login/page.tsx - subtitle removed, Teacher sign in here link removed, forgot password updated to support@lingualinkonline.com
- src/lib/email/templates.ts - base64 logo replaced with hosted PNG URL
- public/lingualink-logo-email.png - logo extracted from base64 and committed as static file

### Break/Fix Log
Issue 1: Admin messages hydration error - timestamp format differed between server and client / Cause: locale-dependent date formatting / Fix: replaced with hardcoded DAYS/MONTHS arrays and midnight-normalised calendar day diff / Lesson: never use toLocaleDateString() or toLocaleTimeString() in components that render on both server and client

Issue 2: Build failed on PR - TS2322 type error in admin messages page / Cause: RawMessage type missing attachments field / Fix: added attachments to RawMessage interface and Supabase select column list / Lesson: always run npx tsc --noEmit before pushing

Issue 3: Email logo not rendering in Gmail / Cause: base64 data URIs stripped by Gmail security / Fix: extracted PNG to public/ and referenced via hosted URL / Lesson: Gmail blocks base64 image URIs - always use hosted URLs. Final fix deferred to custom domain setup

### Session result
Admin messages section built and deployed - the client can now monitor and participate in all teacher/student conversations from the admin portal. Login pages cleaned up. Email logo partially fixed - will complete when custom domain is live.

---


## Session 53 - 18 April 2026 - Admin Portal Fixes, Currency, First Login Flow & Profile Sync

### What was built
- `src/app/api/keep-alive/route.ts` - new GET route that pings Supabase daily to prevent free tier pausing
- `vercel.json` - added midnight UTC daily cron entry for `/api/keep-alive`
- `src/app/(admin)/admin/teachers/[id]/edit/page.tsx` - removed redirect after save, replaced with inline "Changes saved!" toast
- `src/app/(admin)/admin/students/[id]/edit/page.tsx` - same save confirmation fix
- `src/app/api/admin/teachers/[id]/route.ts` - fixed save not persisting, added revalidatePath calls, surfaced real Supabase errors to client
- `src/app/api/admin/students/[id]/route.ts` - added revalidatePath calls after successful save
- `src/app/(teacher)/dashboard/account/page.tsx` - added `export const dynamic = 'force-dynamic'`
- `src/app/(student)/student/account/page.tsx` - added `export const dynamic = 'force-dynamic'`
- `src/app/(admin)/admin/teachers/page.tsx` - dynamic currency symbol (€/$/ £) in Rate column, floating point display fixed globally
- `src/app/(admin)/admin/_components/DatePartInput.tsx` - new three-part DD/MM/YYYY input component with auto-advance focus
- `src/app/(admin)/admin/teachers/new/CreateTeacherClient.tsx` - YouTube URL field removed, all date fields replaced with DatePartInput, date validation fixed
- `src/app/(admin)/admin/teachers/[id]/edit/EditTeacherClient.tsx` - same date and validation fixes
- `src/app/(admin)/admin/students/new/CreateStudentClient.tsx` - date fields replaced with DatePartInput, end_date made optional
- `src/app/(admin)/admin/students/[id]/edit/EditStudentClient.tsx` - end_date made optional, validation removed
- `src/app/(admin)/admin/teachers/schemas.ts` - date validation updated to accept YYYY-MM-DD or null
- `src/app/(teacher)/dashboard/account/AccountClient.tsx` - currency symbol now dynamic, hourly rate section removed from teacher view
- `src/app/(teacher)/dashboard/_components/RightPanel.tsx` - billing section currency symbol now dynamic
- `src/app/api/admin/teachers/route.ts` - new teachers created with `must_change_password: true` and `profile_completed: false`
- `src/app/(auth)/change-password/page.tsx` - new forced password change page for teachers on first login
- `src/app/api/teacher/change-password/route.ts` - updates auth password and clears `must_change_password` flag
- `src/app/(teacher)/dashboard/layout.tsx` - redirects to `/change-password` if `must_change_password` is true
- `src/app/(teacher)/dashboard/upcoming-classes/UpcomingClassesClient.tsx` - orange profile completion banner added
- `profiles` table - `must_change_password` and `profile_completed` columns added via Supabase SQL editor
- `profiles` table - `currency` column added via Supabase SQL editor
- Admin password override added to teacher and student detail/edit pages in admin portal
- Password eye icon toggle added to all password fields across all three portals

### Break/Fix Log
Issue 1: Teacher save not persisting / Cause: PATCH route was spreading entire request body into PostgREST - unrecognised columns caused silent abort / Fix: Explicit column whitelist in updatePayload, real Supabase error now surfaced to client / Lesson: Never spread request body directly into a Supabase update - always whitelist columns explicitly

Issue 2: Currency column missing from profiles / Cause: Column did not exist in database / Fix: Added via Supabase SQL editor, PATCH route already handled it correctly / Lesson: Always confirm column exists in schema before writing API code against it

Issue 3: Admin changes not reflecting in teacher/student portals / Cause: Server Components were serving stale cached data / Fix: Added revalidatePath after every successful PATCH, added force-dynamic to account pages / Lesson: Any admin write that should be visible elsewhere needs revalidatePath on all affected routes

Issue 4: Floating point display (e.g. 49.99 instead of 50) / Cause: toFixed(2) applied during save path, not just display / Fix: Raw string from input parsed once with parseFloat, formatting only applied at display / Lesson: Never apply toFixed during save - only during display

Issue 5: Date input not auto-advancing on Windows Chrome / Cause: Native type="date" inputs do not auto-advance between segments on Windows / Fix: Replaced with custom DatePartInput component - three separate inputs (DD/MM/YYYY) with focus auto-advance / Lesson: Never rely on native date input behaviour across browsers on Windows

Issue 6: Date validation rejecting valid dates / Cause: Schema regex running before empty string was coerced to null / Fix: Empty strings coerced to null before regex runs / Lesson: Always handle empty string → null coercion before running format validation

### Session result
A large batch of admin portal fixes were completed this session. Teacher profile saves now persist correctly with real error messages surfaced to the client. Admin changes to teacher and student profiles now reflect immediately in their respective portals via cache revalidation. Currency is fully dynamic across all three portals. The teacher first-login flow is implemented - new teachers are forced to change their password and shown a profile completion banner. Admin can override any teacher or student password at any time. Date inputs have been rebuilt with a reliable three-part component. The hourly rate is now hidden from teachers entirely. Several quality-of-life improvements were made including eye icon toggles on all password fields and optional date fields throughout the admin forms.

---

## Session 52 - 16 April 2026 - Signal Bars, Admin Header & Library Polish

### What was built
- Signal bar difficulty icons rolled out across all 3 portals - replaced 
  `DifficultyDots` (●●●) with `DifficultyBars` in 5 files:
  `StudySheetsClient.tsx`, `StudySheetDetailClient.tsx`, 
  `AssignStudySheetsModal.tsx`, `StudySheetClient.tsx`, `StudyClient.tsx`
- `StudySheetFormClient.tsx` (teacher portal new sheet form) - difficulty 
  selector updated to signal bar button style matching admin modal
- Admin library table column alignment fixed using percentage-based 
  `gridTemplateColumns` instead of rem values
- Removed broken Edit Sheet button from teacher portal study sheet detail 
  page - editing is admin-only via `/admin/library`
- Admin portal header restructured to full-width spanning the entire top - 
  sidebar now sits below header, eliminating the hard cut between black 
  sidebar and orange header
- Admin header gradient matches teacher portal: fades from `#fff3e8` at the 
  logo on the left to solid `#FF8303` on the right
- Admin portal now uses `lingualink-logo-clean.svg` matching teacher and 
  student portals - removed white logo variant from admin layout

### Break/Fix Log
Issue 1: Admin library columns misaligned - Category data appearing under 
Level header
Cause: rem-based column widths calculated differently across header and data 
rows due to checkbox intrinsic size difference
Fix: Switched to percentage-based gridTemplateColumns on both header and data 
rows
Lesson: Use percentage columns for shared grid layouts - rem values can drift 
between rows with different content types

Issue 2: Edit Sheet button in teacher portal giving 404
Cause: Button pointed to `/study-sheets/${id}/edit` which does not exist - 
editing is done via admin portal modal only
Fix: Removed the button entirely from StudySheetDetailClient.tsx

Issue 3: Admin header had hard cut between black sidebar and orange header
Cause: Sidebar ran full height and header only covered the right portion
Fix: Restructured layout so header spans full width at top, sidebar sits 
below it - matches the structural approach of the teacher portal

### Session result
Difficulty icons are now consistent across all three portals using the signal 
bar style. The admin portal header now matches the teacher portal aesthetic 
with a smooth gradient fade from the logo area into solid orange. All library 
table columns align correctly.


---


## Session 51 - 16 April 2026 - Signal Bars + Library Polish

### What was built
- Replaced dot difficulty indicators (●●●) with graduated signal bar icons across 
  the admin study library - both the list table and the Edit Study Sheet modal
- `LibraryAdminClient.tsx` - new `DifficultyBars` component renders three bars 
  of increasing height (6px / 10px / 14px), orange for filled, light grey for empty
- `SheetFormModal.tsx` - new `DifficultyButton` component replaces `DotButton` with 
  the same bar style; selected state renders bars in white on orange background, 
  unselected shows orange bars on white with orange border
- Difficulty filter dropdown updated to use block characters (▁ ▁▂ ▁▂▃) to match

### Break/Fix Log
No issues this session.

### Session result
Quick polish session. Difficulty indicators are now visually consistent across the 
library list and the create/edit modal. Both components use the same bar proportions 
and colour logic.


---


## Session 50 - 15 April 2026 - Archive, Purge and Styled Confirmation Modals

### What was built
- Archive functionality added to Teacher Detail and Student Detail pages in admin portal
- Purge (hard delete) functionality added to Teacher Detail and Student Detail pages in admin portal
- Cascade delete order implemented: messages, exercise_completions, assignments, reports, invoices, classes, training records, hours_log, reviews, then auth user
- Purge blocked if any linked teachers or students are not yet archived - shows named list of blockers
- Purge confirmation modal requires the client to type the full name before confirming
- Native browser confirm() and alert() dialogs replaced with styled modal dialogs on both Archive and Purge actions
- Modals match portal design system throughout

### Break/Fix Log
Issue 1: Student Detail page missing Purge button / Cause: Button correctly hidden until status is 'former' - not a bug / Fix: Archive first, then Purge appears / Lesson: Archive is a prerequisite for Purge by design

Issue 2: Archive action using native browser confirm() dialog / Cause: Initial implementation used window.confirm() / Fix: Replaced with styled modal matching existing Purge dialog pattern in both TeacherDetailClient.tsx and StudentDetailClient.tsx / Lesson: Never use native browser dialogs in a portal - always use styled modals

### Session result
Archive and Purge functionality is fully working on both Teacher and Student detail pages in the admin portal. Archive is reversible and sets status to 'former'. Purge is permanent and cascades through all related data before removing the auth user. Both actions now use styled confirmation modals consistent with the portal design. Next step is filtering archived records out of the Teachers and Students list pages by default with a toggle to show them when needed.

---

## Session 49 - 15 April 2026 - Contact Emails, Logo Attempts, Clickable Nav, Admin Messages

### What was built
- Updated contact email addresses across entire codebase - all teacher-facing 
  emails now reference teachers@lingualinkonline.com and all student-facing 
  emails reference support@lingualinkonline.com. Updated files: login page, 
  billing client, teacher invite API, student account client, email templates, 
  and all cron/booking/message action files
- Refactored buildEmailTemplate in src/lib/email/templates.ts to accept 
  contactEmail as a dynamic parameter - every call site updated with the 
  correct address based on recipient type
- Added clickable logo to all three portals - teacher portal logo links to 
  /dashboard, student portal logo links to correct student home route, admin 
  portal logo links to /admin. Files updated: LeftNav.tsx, StudentLeftNav.tsx, 
  AdminLayoutClient.tsx
- Built read-only admin message access - the client can now read all 
  teacher-student conversations from both the Teacher Detail page and Student 
  Detail page in the admin portal. Implemented in TeacherDetailClient.tsx, 
  StudentDetailClient.tsx, and both corresponding page.tsx server components. 
  Uses createAdminClient() throughout with explicit column selects

### Break/Fix Log
Issue 1: Email logo not rendering in Gmail
Symptom: Logo image does not appear in sent emails despite URL being publicly 
accessible on Vercel
Cause: Gmail blocks externally hosted images by default. Switched to base64 
inline embedding but logo still did not render - root cause not fully resolved
Fix: Pinned for dedicated investigation in a future session. Base64 embed 
remains in place.
Lesson: Email client image rendering is inconsistent - Gmail in particular 
requires images to be explicitly loaded by the recipient or embedded in a 
way that bypasses content policies. SVG inline rendering may be the correct 
long-term solution.

Issue 2: Student portal clickable logo returning 404
Symptom: Logo link on student portal navigated to /student/dashboard which 
does not exist
Cause: Incorrect assumption about student portal home route
Fix: Checked actual route structure and updated StudentLeftNav.tsx to use 
the correct path
Lesson: Always verify actual route structure before hardcoding paths - never 
assume portal route naming mirrors teacher portal conventions.

### Session result
Contact email addresses are now correctly routed across the entire platform - 
teachers receive support contact details for teachers@lingualinkonline.com and 
students for support@lingualinkonline.com. All three portal logos are now 
clickable and navigate to the correct home page. The admin portal now has 
read-only visibility into all teacher-student message threads, giving the 
client full oversight of platform communications without requiring account 
impersonation. The email logo remains unresolved and is deferred.

---

## Session 48 - 14 April 2026 - Hardening Pass Continued: Privacy, Messages, Billing & Bug Fixes

### What was built
- **Student email privacy** - removed `email` from all teacher-facing student select queries (`students/page.tsx`, `students/[id]/page.tsx`) and stripped it from both client-side TypeScript types and rendered UI. Teachers can no longer see student email addresses.
- **Graceful profile fallback** - replaced three silent `if (!profile) return null` bail-outs in `billing/page.tsx`, `messages/page.tsx`, and `schedule/page.tsx` with a user-facing error message. Pages no longer render blank if the profile query returns empty.
- **Messages bullet list** - added a bullet list toolbar button to the message composer (StarterKit already included support; button was missing). Fixed Tailwind's preflight reset stripping list styles in both the composer and sent message bubbles by scoping CSS rules to `.messages-composer .ProseMirror` and `.message-bubble`.
- **Messages file attachments** - implemented end-to-end: created `messages` Supabase Storage bucket (private, 10MB limit, JPEG/PNG/WebP/PDF only) with three RLS policies; built `api/messages/upload/route.ts` POST handler; updated `sendMessage` action to accept and persist attachments; added paperclip button, hidden file input, pending attachment list with remove buttons, and attachment chip rendering in sent/received bubbles using signed URLs (7-day expiry).
- **RightPanel billing calculation** - wired up real billing data replacing hardcoded `€ –`. Layout now fetches current month lessons and calculates `currentAmount` (completed + student no-show) and `projectedAmount` (+ scheduled), passed as `billingData` prop to `RightPanel`.
- **Admin nav regression fix** - `hourly_rate` added to the profile select during billing work caused the entire profile query to fail silently (column-level RLS restriction). Fixed by removing `hourly_rate` from the regular profile select and fetching it separately via `createAdminClient()` which uses the service role. Admin Controls link restored to the client's nav.
- **Student detail back button** - added a `← Back to Students` button at the top of the student detail page. Fixed a `router is not defined` runtime error by adding the missing `const router = useRouter()` call inside the component body.

### Break/Fix Log

**Issue 1: Silent profile query failure killing admin nav**
Symptom: Admin Controls link disappeared from the client's nav after billing work.
Cause: `hourly_rate` added to the regular Supabase profile select - this field has column-level privileges revoked for non-service-role clients, causing the entire query to return nothing silently. `profile` became null, role defaulted to `'teacher'`, admin link was filtered out.
Fix: Removed `hourly_rate` from the regular profile select. Fetched it separately using `createAdminClient()` (service role) which bypasses column restrictions.
Lesson: Never add restricted columns to regular client selects. Any column touched by `REVOKE` at the column level must always be fetched via the admin client.

**Issue 2: Attachment URLs returning 404**
Symptom: Clicking an attachment link returned `Bucket not found` in the browser.
Cause: Upload route was calling `getPublicUrl()` - a synchronous method that constructs a public URL regardless of bucket permissions. The `messages` bucket is private, so the URL was invalid.
Fix: Replaced with `createSignedUrl(path, 604800)` - generates a time-limited signed URL valid for 7 days that works with private buckets.
Lesson: Private buckets always require signed URLs. `getPublicUrl()` only works on public buckets.

**Issue 3: Bullet list invisible in sent bubbles**
Symptom: Bullet list formatted correctly in composer but rendered as plain text in sent message bubbles.
Cause: Tailwind's preflight reset applies `list-style: none` globally. The CSS scope fix applied to `.messages-composer .ProseMirror` did not cover the bubble render area.
Fix: Added a `message-bubble` class to the bubble container div and added matching CSS rules scoped to `.message-bubble` in the same style block.
Lesson: When fixing CSS for a rich text editor, check both the input area and the output render area - they are separate DOM contexts and both need the reset overridden.

**Issue 4: `router is not defined` on back button**
Symptom: Runtime ReferenceError when clicking the back button in student detail.
Cause: `useRouter` was imported at the top of the file but `const router = useRouter()` was never called inside the component body.
Fix: Added `const router = useRouter()` as the first line of the component function body.
Lesson: Confirm hook instantiation exists in the component body, not just the import.

### Session result
A focused hardening session addressing four teacher portal issues raised by the client. Student email addresses are now fully removed from all teacher-facing views, protecting student privacy. The messages feature received two significant upgrades - bullet list formatting now renders correctly in both the composer and sent bubbles, and file attachments are fully functional end-to-end using a private Supabase Storage bucket with signed URLs. The RightPanel billing summary now shows real calculated values instead of hardcoded dashes. A silent profile query failure - introduced when `hourly_rate` was incorrectly added to a column-restricted select - caused the admin nav link to disappear for the client; this was diagnosed and resolved by moving the restricted field fetch to the admin client. A back navigation button was added to the student detail page.

---

## Session 47 - 14 April 2026 - Schedule Fixes, Rate Limiting & Report Improvements

### What was built
- `src/lib/rateLimit.ts` - new DB-backed IP rate limiter using `login_attempts` Supabase table; replaces broken in-memory rate limiter
- `src/app/(auth)/login/actions.ts` - wired new rate limiter (portal: 'teacher'), inlined IP extraction
- `src/app/(student-auth)/student/login/actions.ts` - same, portal: 'student'
- `src/lib/rate-limit.ts` - deleted (in-memory, stateless on Vercel serverless - was non-functional)
- `src/app/(dashboard)/schedule/tabs/DayToDay.tsx` - 6 fixes: 24hr calendar (00:00-24:00), left/right nav arrows, hint text updated, inline delete modal replacing browser confirm, hover brightness effect on availability blocks, Export to Calendar button generating .ics file, past-date guards on handleDateSelect and handleEventClick
- `src/app/(dashboard)/schedule/tabs/GeneralAvailability.tsx` - 24hr grid (00:00-23:30), auto-scroll to 06:00 on load, sticky day headers, column dividers, comment updated
- `src/app/(dashboard)/schedule/tabs/Holidays.tsx` - updated description and warning text, inline delete modal replacing browser confirm
- `src/app/(dashboard)/reports/[id]/ReportFormClient.tsx` - 150 character minimum on feedback field, 1000 character max, real-time character counter with remaining indicator
- `src/app/(dashboard)/reports/[id]/page.tsx` - fetches assigned study sheet titles alongside IDs
- `src/components/AssignStudySheetsModal.tsx` - onSaved callback updated to return full sheet objects instead of IDs only
- `src/app/(dashboard)/students/[id]/StudentDetailClient.tsx` - Messages tab replaced with deep-link button to /messages?studentId=
- `src/app/(dashboard)/messages/page.tsx` - student deep-link support via ?studentId= query param, auto-opens conversation on load

### Break/Fix Log
Issue 1: In-memory rate limiter non-functional on Vercel / Cause: Serverless functions are stateless - counter resets on every invocation / Fix: Replaced with DB-backed login_attempts table, admin client, 5 attempts per 10 minutes per IP per portal / Lesson: Never use in-memory state for anything that must persist across serverless invocations

Issue 2: validRange prop on FullCalendar caused infinite re-render loop / Cause: new Date() inside JSX creates a new object on every render, causing FullCalendar to think the range changed, triggering datesSet, triggering setVisibleRange, infinite loop / Fix: Removed validRange entirely - past-date guards in handleDateSelect and handleEventClick are sufficient / Lesson: Never pass new Date() directly into a FullCalendar prop - compute once via useRef

Issue 3: Newly assigned study sheets rendered as "Unknown sheet" / Cause: AssignStudySheetsModal.onSaved only returned IDs, not full sheet objects - newly assigned sheets were not in local state / Fix: Updated modal callback to return { id, title }[] objects; ReportFormClient updates both currentAssignedIds and currentAssignedSheets on save

### Session result
Significant hardening and UX improvements across the schedule, reports, and student profile sections. Rate limiting is now properly DB-backed and production-safe. The schedule calendar is fully 24-hour with improved navigation, inline modals, calendar export, and past-date protection. Class reports now enforce meaningful feedback with a 150-character minimum. Study sheet titles are visible on report forms. The student profile Messages tab now deep-links directly into a conversation with that student.

---

## Session 46 - 14 April 2026 - Timezone Selector, Language Selector & Teacher Login Fix

### What was built
- `src/components/TimezoneSelect.tsx` - shared searchable timezone dropdown with 63 IANA timezones grouped by region, UTC offsets computed client-side via Intl API to avoid hydration mismatches
- `src/components/LanguageSelect.tsx` - shared language dropdown listing 44 major world languages, values stored as English names
- Wired `TimezoneSelect` into teacher My Account page, replacing the previous inline select
- Wired `TimezoneSelect` and `LanguageSelect` into student My Account page, replacing both inline selects
- Fixed teacher login button not showing loading state - replaced useState/setLoading with useTransition/isPending to match React 19 transition behaviour
- Updated "Teaching Languages" label to "I Teach:" on teacher Professional Info tab and public profile preview modal

### Break/Fix Log
Issue 1: Teacher login button never showed "Signing in..." state
Symptom: Button stayed static during login - no visual feedback that sign-in was in progress
Cause: In React 19, calling setLoading(true) inside a transition does not flush a re-render before the await, so the button never visually entered the loading state
Fix: Replaced useState boolean with useTransition - isPending is updated reliably by React before async work begins
Lesson: In React 19 with form actions, useTransition is the correct pattern for pending UI states - useState loading flags are unreliable inside transitions

### Session result
Built two shared components - TimezoneSelect and LanguageSelect - and wired them into both the teacher and student My Account pages, replacing hardcoded inline selects. Fixed the teacher portal login button which had no visual loading state due to a React 19 transition behaviour difference. Small label wording update on the teacher Professional Info tab. Both portals tested and working on live Vercel deployment.

---

## Session 45 - 14 April 2026 - Student Portal Fixes & Self-Registration Foundation

### What was built
- Fixed student My Account page - switched to `createAdminClient()` with explicit 
  safe column list, resolving silent query failure caused by column-level REVOKEs
- Created `src/app/api/student/profile/route.ts` - POST (photo upload) and PATCH 
  (field updates) routes using admin client, replacing all direct browser-side 
  Supabase calls on the student account page
- Added `profile_completed` and `must_change_password` boolean columns to the 
  students table via Supabase SQL Editor
- Created `src/app/api/student/change-password/route.ts` - PATCH route that updates 
  auth password and sets `must_change_password: false` via admin client
- Created `src/app/(student-auth)/student/change-password/page.tsx` - standalone 
  full-page password change screen outside the student layout (no sidebar, no 
  redirect loop risk)
- Updated `src/app/(student)/student/layout.tsx` - switched student fetch to 
  `createAdminClient()`, added `must_change_password` redirect to change-password 
  page
- Added profile completion banner to student dashboard - dismissable per session, 
  links to My Account, disappears permanently once profile is saved
- Updated `src/lib/email/templates.ts` - added Lingualink logo above orange header 
  in all outgoing emails
- Updated `src/app/api/admin/students/route.ts` - replaced inline welcome email HTML 
  with `buildEmailTemplate`, removed recovery link, added "Log In" button linking to 
  student portal, added `profile_completed: false` and `must_change_password: true` 
  to student upsert

### Break/Fix Log

Issue 1: Student My Account showed "Account not found" after UUID was corrected
Symptom: Page showed fallback despite correct `auth_user_id` in students table
Cause: `select('*')` column list in page.tsx contained columns from the profiles/
teachers table that don't exist on students - Supabase returned null silently
Fix: Replaced column list with only valid students table columns
Lesson: Never assume column names - always verify against actual table schema before 
writing queries

Issue 2: Student login loop after adding must_change_password to layout
Symptom: Entering login credentials refreshed back to login page, clearing fields
Cause: `must_change_password` column was added to the layout select but lacked 
SELECT privilege for the authenticated role - entire query returned null, hitting 
`!student` redirect to `/student/login`
Fix: Ran `GRANT SELECT (must_change_password, profile_completed, teacher_notes, 
follow_up_date, follow_up_reason) ON students TO authenticated` in Supabase SQL 
Editor; switched layout student query to `createAdminClient()`
Lesson: Any new column added to a table with column-level REVOKEs must be explicitly 
granted before it can be selected - even by the admin client if the layout previously 
used the regular client

Issue 3: middleware.ts creation attempted during build
Symptom: Claude Code prompted to create middleware.ts during Step 5
Cause: Instruction asked for route protection without specifying the proxy.ts pattern
Fix: Pressed No, redirected Claude Code to add the check directly inside the student 
layout server component instead
Lesson: Always explicitly state "do not create middleware.ts" in any instruction 
involving route protection

### Session result
Resolved the persistent student My Account loading failure and the student login 
redirect loop. Established the must_change_password first-login flow, profile 
completion banner, and admin-routed photo upload. Updated all platform emails to 
include the Lingualink logo. Confirmed local and production share the same Supabase 
project - SQL grants apply universally. All changes deployed to production and 
verified on the live Vercel URL.

---


## Session 44 - 13 April 2026 - Claude Code Setup & Account Page Fixes

### What was built
- Installed and configured Claude Code (CLI) as the primary development tool going forward
- Created CLAUDE.md with full project rules, architecture notes, and critical never-break constraints
- Added password visibility toggle (eye icon) to both teacher and student login pages
- Fixed next/image hostname error by adding Supabase storage domain to next.config.ts
- Fixed false `if (!profile) redirect('/login')` pattern in billing, messages, reports, and schedule pages
- Fixed My Account page data not saving - root cause was missing RLS UPDATE policy silently blocking writes; resolved by routing saves through a new server-side API route `/api/profile` using the admin client
- Fixed My Account page not loading saved data - root cause was column-level REVOKEs blocking `select('*')` reads; resolved by switching to `createAdminClient()` with an explicit column list
- Moved success toast on My Account from bottom right to bottom center

### Break/Fix Log
Issue 1: Password field had no visibility toggle / Usability gap / Added Eye/EyeOff icons from lucide-react to both login pages / Always use type="button" on toggle to prevent accidental form submission

Issue 2: next/image blocking page render / Supabase storage hostname not whitelisted in next.config.ts / Added remotePatterns entry for varrxikjrbycpobydlev.supabase.co / Always add image hostnames to next.config.ts when using Supabase Storage

Issue 3: My Account saves silently failing / No RLS UPDATE policy on profiles table - PostgREST returns no error but writes 0 rows / Created /api/profile PATCH route using admin client with field whitelist / Never use browser Supabase client for writes on tables with restrictive RLS - route through admin API instead

Issue 4: My Account fields empty on load / Column-level REVOKEs blocking select('*') and returning null profile / Switched page.tsx to createAdminClient() with explicit safe column list / Never use select('*') on tables with column-level privilege restrictions

### Session result
Claude Code is now the primary development tool for this project, replacing the Cursor Agent workflow. CLAUDE.md locks in all critical project rules so every session starts with full context. Four real bugs fixed and confirmed working on localhost. A new working principle was established: one fix must never cause another problem - no ripple effect of bugs.

---

## Session 43 - 11 April 2026 - Live Portal Auth Loop Fix

### What was built
- Diagnosed and fixed the authentication redirect loop on the live Vercel deployment that prevented login on both the Teacher and Student portals
- Added `await supabase.auth.getUser()` to `src/proxy.ts` to refresh auth tokens server-side on every request - the root cause of the Vercel-specific auth failure
- Added `prefetch={false}` to all `<Link>` components across `LeftNav.tsx`, `StudentLeftNav.tsx`, `TopHeader.tsx`, and `StudentTopHeader.tsx` to prevent Next.js from firing parallel prefetch requests that consumed Supabase's single-use refresh tokens
- Removed false `if (!profile) redirect('/login')` checks from `src/app/(dashboard)/upcoming-classes/page.tsx` and `src/app/(dashboard)/account/page.tsx` - these treated a null database query result as an authentication failure, redirecting authenticated users back to login
- Applied the same fix to `src/app/(student)/student/account/page.tsx` with a user-friendly "Account not found" fallback instead of a redirect
- Restored the teacher login flow to use `router.push('/upcoming-classes')` after server action returns success - confirmed working with all prefetching disabled

### Break/Fix Log

**Issue 1 - Auth redirect loop on Vercel (Teacher and Student portals)**
- Symptom: Login succeeds, page loads briefly, then user is redirected back to the login page within 1–3 seconds. Only occurs on Vercel - not reproducible on localhost.
- Cause: `proxy.ts` (Next.js 16 middleware) created a Supabase client but never called `getUser()`, so auth tokens were never refreshed server-side. On Vercel's serverless architecture, each request hits a fresh function - without token refresh in the proxy, stale tokens caused server components to see unauthenticated sessions.
- Fix: Added `await supabase.auth.getUser()` before the return statement in `proxy.ts`.
- Lesson: Supabase SSR with Next.js requires the middleware/proxy to call `getUser()` on every request to keep the session alive. This is documented in Supabase's Next.js guide but was missing from the original implementation.

**Issue 2 - Next.js Link prefetching causing token race condition**
- Symptom: Even after the proxy fix, the teacher portal loaded the landing page successfully but was redirected to login 3 seconds later. Vercel logs showed 9+ simultaneous GET requests for navigation routes immediately after page load.
- Cause: Next.js `<Link>` components prefetch their target pages by default. The LeftNav and TopHeader had Links to 9+ pages, all prefetched in parallel. Each prefetch went through the proxy calling `getUser()`. Supabase's refresh token is single-use - the first request consumed it, and the remaining parallel requests failed authentication, returning redirect instructions in their RSC payloads.
- Fix: Added `prefetch={false}` to every `<Link>` in `LeftNav.tsx`, `StudentLeftNav.tsx`, `TopHeader.tsx`, and `StudentTopHeader.tsx`.
- Lesson: In Supabase + Next.js deployments, Link prefetching can trigger a token rotation race condition. Disable prefetch on navigation links when using Supabase SSR auth.

**Issue 3 - False auth redirect on null profile query**
- Symptom: Pages redirected to `/login` even when the user was authenticated, because the profile database query returned null.
- Cause: Multiple `page.tsx` files checked `if (!profile) redirect('/login')` after the layout had already verified authentication. A null profile is a data issue (e.g. missing database row), not an authentication failure. This created a redirect loop: layout says "user is logged in," page says "no profile, go to login," login says "already authenticated, go to dashboard."
- Fix: Removed `if (!profile) redirect('/login')` from `upcoming-classes/page.tsx` and `account/page.tsx`. Added sensible defaults for null profiles instead of redirecting.
- Lesson: Never use a missing database record as a proxy for "not authenticated." Separate auth checks (is the user logged in?) from data checks (does the user have a profile?). The layout handles auth - pages should handle missing data gracefully.

**Issue 4 - React `cache()` import crashed all server components**
- Symptom: All pages returned `---` status (no response) on Vercel after wrapping `createClient` in React's `cache()` function.
- Cause: The `cache()` wrapper from React conflicted with the Supabase SSR client's cookie handling in Next.js 16's server component lifecycle. The function crashed before returning any response.
- Fix: Reverted `server.ts` to the original implementation without `cache()`.
- Lesson: Not all React server APIs are compatible with every library's internal state management. Test changes to shared infrastructure files carefully - they affect every page.

### Session result
The live portal authentication is now fully functional. The teacher portal login works and all 8 navigation tabs load correctly (upcoming classes, schedule, reports, students, messages, study sheets, billing, and account). The student portal login works and all tabs load correctly except My Account, which shows "Account not found" due to a test data mismatch in the students table (`auth_user_id` does not match the Supabase Auth user ID for the test student - a data issue, not a code issue). The admin portal loads but several pages crash with `---` status due to Vercel Hobby plan's 10-second function timeout - upgrading to Vercel Pro is required before go-live. The same `if (!profile) redirect('/login')` bug exists in other page files (billing, messages, reports, schedule) and should be fixed in a follow-up session. Cursor Pro is recommended for future sessions to enable agent mode for faster iterative debugging.

---


## Session 42 - 10 April 2026 - Vercel 404 Fix

### What was built
- Diagnosed and resolved Vercel production 404 error affecting all routes (root, /login, /student/login)
- Merged dev branch into main to sync latest commits (ClassReminderModal, root redirect)

### Break/Fix Log

**Issue 1**
- **Symptom:** All routes on lingualink-lms.vercel.app returned 404 NOT_FOUND. Vercel logs showed "Middleware: 404 Not Found" even though no middleware file existed. Build logs showed all routes compiled successfully.
- **Cause:** Vercel Framework Preset was set to "Other" instead of "Next.js". Without the correct preset, Vercel did not know how to serve the Next.js build output, so every route returned 404 despite a successful build.
- **Fix:** Changed Framework Preset from "Other" to "Next.js" in Vercel → Settings → Build and Deployment, then redeployed without build cache.
- **Lesson:** Always verify the Vercel Framework Preset matches the actual framework. A successful build does not guarantee correct serving - Vercel needs the preset to know how to route requests to the build output.

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
- **Item 2 - Server-side input validation:** Created `src/lib/validation/schemas.ts` using Zod 4 with schemas for `CreateTeacherSchema`, `CreateStudentSchema`, `HoursAdjustmentSchema`, and `BookClassSchema`. Applied to four high-priority API routes: `admin/teachers`, `admin/students`, `admin/students/[id]/hours`, and `student/book`. Raw `body` is no longer passed directly to Supabase in any of these routes - all input flows through `parsed.data`.
- **Item 3 - File upload restrictions:** Audited all upload handlers across the codebase. Teacher and student photo uploads already had type and size checks. Added missing 10MB size check to `handleTemplateUpload` in both `BillingClient.tsx` and `BillingAdminClient.tsx`.
- **Item 4 - Rate limiting on login:** Created `src/lib/rate-limit.ts` - an in-memory rate limiter tracking failed attempts per IP. Applied to both teacher (`/login/actions.ts`) and student (`/student/login/actions.ts`) login actions. 5 failed attempts within 15 minutes triggers a 15-minute lockout. Also fixed the teacher login action which was previously returning raw Supabase error messages to the browser, leaking whether an email address exists.
- **Item 5 - Security headers:** Updated `next.config.ts` with a full security header set: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, and a Content Security Policy covering `script-src`, `style-src`, `font-src`, `img-src`, `connect-src`, `form-action`, and `frame-ancestors`. Supabase hostname derived dynamically from `NEXT_PUBLIC_SUPABASE_URL`.
- **Item 6 - RLS policy audit:** Full audit of all 26 tables. Fixed 4 critical issues (profiles exposed to all users, students exposed to all authenticated users, all lessons visible to all users, students could insert lessons with any field values), 5 high issues (student_reviews ownership gaps, training_teachers fully exposed, students had no UPDATE policy, availability_overrides and availability_templates had zero policies), and multiple medium issues (duplicate policies, public-role policies). Strengthened `is_admin()` function to also check `account_types` array for `school_admin`.
- **Item 7 - Security gap review:** Identified that column-level REVOKE was being silently ignored due to table-level grants. Created `src/lib/supabase/admin.ts` - a service role client factory for server-only admin operations. Migrated 7 admin server component pages from anon key to service role key. Created `/api/admin/billing/entities/route.ts` - a new API route that serves `hourly_rate` (teachers) and `cancellation_policy` (students) server-side only, replacing direct browser client queries in `BillingAdminClient.tsx`. Applied column-level REVOKE on `students` (blocking SELECT on `admin_notes`, `cancellation_policy`, `follow_up_date`, `follow_up_reason`) and `profiles` (blocking SELECT on `admin_notes`, `hourly_rate`, `follow_up_date`, `follow_up_reason`, `date_of_birth`, `contract_start`, `orientation_date`, `observed_lesson_date`, `vat_required`) for the authenticated role. Verified with SQL that sensitive columns no longer appear in authenticated SELECT grants.
- **Item 8 - NEXT_PUBLIC_SITE_URL:** Added `NEXT_PUBLIC_SITE_URL=https://lingualink-lms.vercel.app` to Vercel environment variables across all environments.
- **Production deployment fix:** Merged `dev` into `main` and pushed to GitHub, triggering a Vercel production build. Previously the production URL was returning 404 on all routes.

### Break/Fix Log

**Issue 1**
- Symptom: `npx tsc --noEmit` returned 2 errors after placing `schemas.ts` - `errorMap` property not recognised on `z.enum()` and `z.union()`
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
- Fix: Used `[System.IO.File]::WriteAllText()` with explicit UTF8 encoding - bypasses PowerShell string handling entirely
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
- Lesson: Always verify nav hrefs match actual Next.js route paths - mismatches cause active state failures silently

### Session result
All three portals now have a cohesive, professional look. The gradient top band unifies the sidebar and header into one visual element. The login pages are a significant upgrade - split panel with dark brand panel makes a strong first impression. Active nav states are reliable. The build is in a clean.


---



## Session 39 - 09 April 2026 - Logo and header styling across all three portals

### What was built
- Added the official LinguaLink Online logo SVG to all three portals (teacher, student, admin)
- Created `/public/lingualink-logo.svg` - one-colour white version, viewBox tightly cropped to content, no background rect, renders cleanly on the orange header
- Created `/public/lingualink-chat-icon.svg` and `/public/lingualink-logo-white.svg` as supporting assets
- Updated `TopHeader.tsx` (teacher portal) - header height increased to 72px, logo at 52px height, greeting text corrected to white, avatar placeholder updated to white semi-transparent style
- Updated `StudentTopHeader.tsx` (student portal) - same header treatment applied
- Updated `AdminLayoutClient.tsx` - replaced plain text "Lingualink Online - Admin" with the logo SVG, header height aligned to 72px
- Fixed `ChatWidget.tsx` type error - `sendMessageAction` receiver type extended to include `'student'` in student messages `actions.ts`
- Fixed student portal Join Class button colour from black (`#111827`) to orange (`#FF8303`)

### Break/Fix Log

**Issue 1**
- Symptom: Logo appeared tiny and faded on the orange header
- Cause: Original SVG had a white background rect baked in covering the full 394×225 canvas, leaving the actual logo content occupying a small fraction of the rendered area
- Fix: Stripped the white background rect and rewrote the SVG with a cropped viewBox (`28 26 348 172`) tightly around the actual content, all fills set to white
- Lesson: Always check SVG viewBox and background rects before placing a logo on a coloured background - dead space in the viewBox causes the logo to render smaller than expected

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
- Cause: The admin header lives in `AdminLayoutClient.tsx` not a separate `TopHeader` component - regex replacement targeted the wrong file initially
- Fix: Located the correct file path `src/app/(admin)/AdminLayoutClient.tsx`, added `Image` import, replaced the text span with an `Image` tag
- Lesson: Always confirm which component owns the header for each portal before writing replacement commands

### Session result
All three portals now display the official LinguaLink Online logo in the top header bar. The teacher and student portals use a white one-colour SVG on the orange header at 52px height in a 72px bar. The admin portal header matches. The student portal Join Class button is now correctly orange.

---


## Session 38 - 09 April 2026 - Admin Controls Phase & Messaging Polish

### What was built

- **ChatWidget** - built a floating Intercom-style chat bubble (fixed bottom-right) that appears on every page of both the teacher and student portals. The widget has two tabs: Messages (pre-connected to the client's admin account) and FAQ (portal-specific content). Teacher and student portals pass their own server actions as props, keeping the component fully portal-agnostic. FAQ content is stored in named arrays (`TEACHER_FAQS`, `STUDENT_FAQS`) at the top of the file - The client can update the wording without touching component code.
- **What's New** - wired the RightPanel What's New section to real announcement data fetched and filtered in the layout. An orange badge shows the count when active announcements exist.
- **Teacher RightPanel next class** - replaced the placeholder countdown with real data fetched from the `lessons` table. Now displays "Next class from Xh Xm Xs", the date and time range, and the student name - matching the LearnCube reference style. Join Class button appears 15 minutes before the class start time.
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
- Lesson: Any RLS policy on a shared table must account for both auth patterns - teacher (profiles) and student (students with auth_user_id)

**Issue 2**
- Symptom: Read ticks were not updating in real time on either portal despite the UPDATE subscription being in place
- Cause: Supabase Realtime UPDATE events only broadcast changed columns by default - without REPLICA IDENTITY FULL, the full row is not sent and the subscription receives no usable payload
- Fix: `ALTER TABLE messages REPLICA IDENTITY FULL` - run once, applies to all users and all portals permanently
- Lesson: Any table using real-time UPDATE subscriptions requires REPLICA IDENTITY FULL or the subscription will silently receive incomplete payloads

**Issue 3**
- Symptom: Read ticks updated for students but not for teachers even after REPLICA IDENTITY FULL was set
- Cause: The SELECT policy "Users see their own messages" only matched `auth.uid() = sender_id`, which works for teachers but not students. When Supabase tried to return the updated row to the student's real-time subscription, the SELECT policy blocked it
- Fix: Dropped and rewrote both the SELECT and UPDATE policies to include the student auth lookup pattern on sender_id, receiver_id, and the admin role check
- Lesson: REPLICA IDENTITY FULL is necessary but not sufficient - the SELECT policy must also permit the subscribing user to read the updated row or the event is silently dropped

### Session result

The Admin Controls phase is complete. Both portals now have a fully working floating chat widget connected to the client's admin account, with an FAQ tab that can be updated without code changes. The messaging system is polished across all three portals - consistent bubble colours, real-time read receipts, and a clean composer. RLS policies on the messages table now correctly cover every user type. The project is ready to move into the Step 14 hardening pass.


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

- **Step 12: Tasks** - Full internal task management system for the client and staff
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

Admin Portal Steps 12 and 13 are complete and tested. The Tasks system is fully functional - the client can create, assign, prioritise, complete, and delete internal follow-up tasks, with the TasksMini component ready to embed into teacher and student detail pages when those are revisited. All six Data Exports produce correct CSVs and download cleanly in the browser. The Admin Portal now has one step remaining: Step 14 Settings, followed by the Admin Controls phase and the final hardening pass before go-live.

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
- Lesson: Always include required non-null database columns in insert payloads. Client components cannot access the server session directly - must use `supabase.auth.getUser()` on the browser client.

**Issue 3**
- Symptom: Announcement banner blending into the orange top header - visually indistinct
- Cause: Banner used the same `#FF8303` background as the header
- Fix: Changed banner style to dark charcoal background (`#1f2937`) with orange left border (`4px solid #FF8303`) - clearly distinct from header while remaining on-brand
- Lesson: Notification banners directly below a coloured header must use a contrasting background to be readable and visually intentional.

### Session result

The MS Graph API integration is fully operational after resolving a Microsoft 365 licence constraint - the Calendar Events endpoint is now used instead of the dedicated onlineMeetings endpoint, producing identical Teams join URLs with no impact on the rest of the codebase. The organiser account (`Admin@LingualinkOnline.onmicrosoft.com`) can be swapped to a dedicated shared mailbox at any time by changing a single constant in `graph.ts`. Admin Portal Step 11 (Announcements) is complete and fully tested - admins can create, edit, toggle, and delete announcements, banners appear correctly on both the Teacher and Student portals, and dismissals are persisted per user. Remaining Admin Portal steps are 12 (Tasks), 13 (Exports), 14 (Settings), and 15 (Testing & Hardening).

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
- Cause: Three-level nested Supabase join (`reports → lessons → students`) causes silent empty results - Supabase returns no rows without any error when a join is nested this deeply
- Fix: Split into two queries - Query 1 fetches reports + lessons + teacher profile (two levels), Query 2 fetches students by their IDs collected from Query 1 results using `.in('id', studentIds)`
- Lesson: Never nest Supabase joins more than two levels deep. Always use the two-query pattern when a student or third entity needs to be resolved

**Issue 2**
- Symptom: API route returned 500 with `column lessons_1.start_time does not exist`
- Cause: The `lessons` table uses `scheduled_at`, not `start_time` - assumed the wrong column name without verifying schema first
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
Issue 2: Cancel modal confirmed but class status did not update / RLS had no UPDATE policy covering admin users - Supabase silently updated 0 rows and returned 200 / Added "Admins can update lessons" RLS policy / Always audit UPDATE policies separately from SELECT - missing UPDATE policies fail silently with no error

### Session result
Admin Portal Step 7 complete. The Classes section gives the client full visibility and control over all lessons across all teachers - list view with filters, manual booking flow, class detail with cancellation, and edit capabilities with no time restrictions.

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
Student Management for the Admin Portal is now partially complete. The student list, create student flow, and student detail page are all working end to end. A new student can be created with full personal, learning, training, and notes data - the auth user, student row, training record, and teacher assignments all save correctly in one API call. The student detail page shows all data across six tabs, and the Hours Log tab supports adding and removing hours with full transaction history. The next session will continue with Edit Student and then move on to the remaining Admin Portal steps.

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

Issue 3: Edit form save failed with PGRST204 - columns not found / `date_of_birth`, `title`, `gender`, `nationality`, `phone`, `qualifications` did not exist on the profiles table / Added all missing columns via `ALTER TABLE` in Supabase SQL Editor / Always verify column existence in Supabase before writing any update payload - schema additions from the brief are not automatically applied.

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
- `src/app/api/student/book/route.ts` - stub replaced with real Graph API call. Teams join URL now included in confirmation emails to both student and teacher. Booking proceeds safely if Graph API fails - lesson is saved with `TEAMS_LINK_PENDING` and Sentry captures the error.
- `src/proxy.ts` - admin route protection added. Checks `profiles.role === 'admin'`; redirects unauthenticated users to `/login` and non-admin users to `/upcoming-classes`.
- `src/app/(admin)/layout.tsx` - admin layout server component with auth and role gate.
- `src/app/(admin)/AdminLayoutClient.tsx` - full admin shell: dark sidebar, orange header, right panel with placeholder widgets, mobile hamburger menu, Back to Teacher Portal and Log Out links.
- `src/app/(admin)/admin/page.tsx` - placeholder dashboard confirming `/admin` route is live.
- Installed `@microsoft/microsoft-graph-client` and `@azure/identity` packages.

### Break/Fix Log
Issue 1: middleware.ts conflict / Cause: Project uses `proxy.ts` instead of standard `middleware.ts` - both cannot coexist. / Fix: Deleted `middleware.ts` and merged admin route protection into existing `proxy.ts`. / Lesson: Always check for `proxy.ts` before creating `middleware.ts` in this project.

Issue 2: Graph API - wrong tenant ID / Cause: `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` were swapped in `.env.local`. / Fix: Corrected both values in `.env.local` using the app registration Overview page. / Lesson: Both values are UUIDs and look identical - always verify against the Azure portal labels, not position on the page.

Issue 3: Graph API - 404 UnknownError on onlineMeetings endpoint / Cause: The client's Microsoft 365 Business Basic subscription was purchased today and the license has not yet propagated to the organiser account. Microsoft can take up to 24 hours to activate. / Fix: Deferred - code is correct. Retest tomorrow once license is active. / Lesson: New M365 subscriptions are not instant - build the stub fallback pattern so the app never breaks while waiting.

### Session result
Admin Portal Step 1 is complete and the MS Graph API is wired in across the student booking flow. Authentication is confirmed working - the 404 error on meeting creation is a license propagation delay, not a code issue. The admin portal shell loads correctly for the client's admin account and redirects all other users appropriately. Both the admin portal and Graph API work are committed to the dev branch. Next session starts with Admin Portal Step 2 - database schema updates.

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
Issue 1: Book a Class button redirecting back to My Classes / Cause: training_teachers table had no RLS SELECT policy - Supabase join returned empty array, page redirected as safety measure / Fix: Added SELECT policy with `true` on training_teachers / Lesson: Always audit RLS policies on junction tables, not just main tables

Issue 2: profiles table blocked student from reading teacher data / Cause: Only "Users can view own profile" SELECT policy existed - students couldn't read teacher profile rows / Fix: Added "Students can view teacher profiles" SELECT policy with `true` / Lesson: Teacher profiles are not sensitive - any authenticated user should be able to read them

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
- `src/app/(student-auth)/student/reset-password/page.tsx` - reset password page; client component that listens for Supabase `PASSWORD_RECOVERY` event before showing form; handles first-time password setup for new students the client invites
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
Student Portal Step 2 is complete. The authentication system is fully functional - students can log in, reset their password, and set a new password via email link. The role check correctly blocks teachers from accessing the student portal. A test student account was created in Supabase to verify all flows. The student portal shell now matches the teacher portal colour scheme exactly. A hard colour consistency rule has been saved to memory and applies to all future portal components including the Admin portal.

---

## Session 14 - 04 April 2026 - Student Portal Step 1: Shell & Navigation

### What was built
- Updated `src/proxy.ts` to protect all `/student/*` routes - unauthenticated users are redirected to `/student/login`
- Created route group `src/app/(student)/student/` with `layout.tsx` - validates session, fetches student record by `auth_user_id`, and renders the three-panel shell
- Created route group `src/app/(student-auth)/student/login/` with stub `page.tsx` - placeholder replaced in Step 2
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
- `avatars` Supabase Storage bucket - public bucket for profile photos with per-user upload policies
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
- Symptom: Tiptap warning - duplicate extension names for 'underline'
- Cause: StarterKit includes its own underline extension by default
- Fix: Added StarterKit.configure({ underline: false }) to disable the built-in one
- Lesson: When adding individual Tiptap extensions, always check if StarterKit already includes them and disable the duplicate

**Issue 4**
- Symptom: React hydration mismatch on message timestamps
- Cause: Server rendered time in 24hr format, client rendered in 12hr format due to locale differences
- Fix: Replaced toLocaleTimeString() with manual HH:MM string construction using padStart
- Lesson: Never use toLocaleTimeString() in components that render on both server and client - locale differences cause hydration failures

### Session result
Built the full in-portal messaging system and wired up the Resend email layer in a single session. Teachers can start conversations with students, send rich text messages with bold, italic, and underline formatting, and see their full message history with real-time updates. The unread badge in the left nav reflects live data from Supabase. On every new message, the recipient receives a branded Lingualink Online email with a direct link to the Messages page - confirmed working via the Resend dashboard. The same email template infrastructure will be reused for class reminders, report overdue alerts, and invoice reminders in later steps.

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
Built the complete Class Reports feature including the reports list page, full report form with CEFR level assessment, automatic 12-hour deadline flagging via pg_cron, and admin reopen functionality. All flows tested end to end - pending reports appear correctly, the form submits and redirects, flagging works on demand and will run automatically every 15 minutes in production, and admin reopen moves a flagged report back to pending instantly. Also switched the portal font from Poppins to Inter at 15px base size, significantly improving readability and the overall professional feel of the UI.


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
- Brand colours registered in `src/app/globals.css` under the `@theme inline` block using Tailwind v4 syntax - `brand-orange`, `brand-orange-light`, `brand-red`, `brand-yellow`, `brand-yellow-light`, `brand-grey`
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
- Middleware created at `src/middleware.ts` - refreshes user sessions on every request and handles route protection
- Full database schema written and executed in Supabase SQL Editor - 13 tables created: `profiles`, `students`, `trainings`, `training_teachers`, `lessons`, `reports`, `study_sheets`, `exercises`, `assignments`, `availability_templates`, `availability_overrides`, `invoices`, `messages`
- Row Level Security (RLS) enabled on all 13 tables with policies ensuring teachers can only access their own data
- Automatic profile creation trigger set up - a profile row is created in the `profiles` table whenever a new auth user is added
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
- Created the GitHub repository with README, .gitignore, and MIT license
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
