# LinguaLink Online - Build Journal


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
