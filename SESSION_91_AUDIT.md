# Session 91 — Booking / Classes / Scheduling / Video Call Architectural Audit

Read-only audit. Branch `dev`, working tree clean, HEAD `6fd3890`.

All anchors are absolute paths in the live `src/` tree. References to `codebase.txt` are not source — that file is a stale flattened snapshot at the repo root and was disregarded after confirmation.

---

## Working tree state

- Branch: `dev`, in sync with `origin/dev`, clean.
- Last commit: `6fd3890 docs(journal): update pinned items, add closed-since-S82 and verified-open sections`.
- No `.sql` migrations for `classes` or `lessons` exist in the repo (`supabase/migrations/` only has 3 unrelated files). Both tables were created via the Supabase dashboard. **All schema claims below are inferred from how the code reads/writes; nothing is verifiable from migration history in-repo.**
- No generated TypeScript DB types file exists (`src/types/` does not exist). The code uses `any` and inline shapes when reading lesson rows.

---

## `classes` vs `lessons` — full surface-area inventory

**Result: there is no split surface in current source.** The `classes` table is dead weight in the schema; every read and every write in `src/` targets `lessons`. The `from('classes')` matches only appear in `codebase.txt` (a stale repo-root snapshot of a prior iteration of the codebase) — never in any file under `src/`.

Confirmed via:

```
rg "from\(['\"]classes['\"]\)" src/    →  0 matches
rg "from\(['\"]lessons['\"]\)" src/    →  ~70 matches across ~35 files
```

The remaining `'classes'` literals in `src/` are UI/tab labels (`'classes' | 'invoices' | ...`) and pluralisation strings — not table names.

### Lessons surfaces (read = R, write = W)

| File | Line | Op | Surface |
|---|---|---|---|
| `src/app/(dashboard)/layout.tsx` | 35 | R | Teacher right-panel "Next Class" — `gt(scheduled_at, now-2h)`, `eq(status, 'scheduled')`, limit 1 |
| `src/app/(dashboard)/layout.tsx` | 65 | R | Teacher idle-timeout protection — `gt(scheduled_at, now-90m)` |
| `src/app/(dashboard)/layout.tsx` | 80 | R | Teacher month billing summary |
| `src/app/(student)/student/layout.tsx` | 39 | R | Student right-panel "Next Class" — `gt(scheduled_at, now-2h)`, `eq(status, 'scheduled')` |
| `src/app/(student)/student/layout.tsx` | 50 | R | Student idle-timeout protection |
| `src/app/(dashboard)/upcoming-classes/page.tsx` | 21 | R | Teacher Upcoming Classes — `eq(status, 'scheduled')`, **`gte(scheduled_at, now)`**, admin client |
| `src/app/(dashboard)/upcoming-classes/actions.ts` | 22 | R | Verify lesson before "reschedule" (cancel) |
| `src/app/(dashboard)/upcoming-classes/actions.ts` | 58 | W | Set `status='cancelled'`, `cancelled_at`, `cancellation_reason` |
| `src/app/(dashboard)/schedule/tabs/DayToDay.tsx` | 263 | R | Teacher schedule calendar (week range, `neq(status, 'cancelled')`) |
| `src/app/(dashboard)/billing/BillingClient.tsx` | 179 | R | Teacher billing detail |
| `src/app/(dashboard)/students/[id]/page.tsx` | 67 | R | Teacher's view of student's lessons |
| `src/app/(student)/student/my-classes/page.tsx` | 22 | R | Student My Classes — `gte(scheduled_at, now)`, `in(status, ['scheduled','cancelled'])` |
| `src/app/(student)/student/my-classes/page.tsx` | 56 | R | Student "last completed lesson" — `eq(status, 'completed')` |
| `src/app/(student)/student/my-classes/actions.ts` | 30 | R | Student-cancel pre-check |
| `src/app/(student)/student/my-classes/actions.ts` | 56 | W | Student cancel — `status='cancelled'` |
| `src/app/(student)/student/past-classes/page.tsx` | 21 | R | Student Past Classes — `in(status, ['completed','student_no_show','teacher_no_show'])` |
| `src/app/(student)/student/past-classes/[id]/page.tsx` | 27 | R | Past class detail |
| `src/app/(student)/student/progress/page.tsx` | 32 | R | Student progress page |
| `src/app/(student)/student/book/page.tsx` | 81 | R | Look up the lesson row when reschedule URL `?reschedule=...` is used |
| `src/api/student/availability/route.ts` | 80 | R | Slot conflict check from student booking calendar |
| `src/app/api/student/book/route.ts` | 220 | R | Booking clash check |
| `src/app/api/student/book/route.ts` | 275 | W | Reschedule: cancel old lesson row |
| `src/app/api/student/book/route.ts` | 317 | W | **Insert new lesson** (booking finalisation) |
| `src/components/student/ClassReminderModal.tsx` | 70 | R | Student in-portal modal poller (next 60 min) |
| `src/app/api/admin/classes/route.ts` | 47 | R | Admin classes list |
| `src/app/api/admin/classes/route.ts` | 206 | R | Admin booking clash check |
| `src/app/api/admin/classes/route.ts` | 268 | W | **Admin insert lesson (manual booking)** |
| `src/app/api/admin/classes/[id]/route.ts` | 33 | R | Admin lesson detail |
| `src/app/api/admin/classes/[id]/route.ts` | 127 | R | Admin pre-cancel fetch |
| `src/app/api/admin/classes/[id]/route.ts` | 141 | W | Admin cancel — `status='cancelled'` + non-atomic hours refund |
| `src/app/api/admin/classes/[id]/route.ts` | 246 | W | Admin **reschedule (in-place update)** of `scheduled_at` / `teacher_id` / `duration_minutes` |
| `src/app/api/admin/classes/[id]/route.ts` | 343 | W | Admin DELETE (only when status already cancelled) |
| `src/app/api/admin/classes/route.ts` (POST) | 268 | W | Admin manual create lesson |
| `src/app/(admin)/admin/classes/[id]/page.tsx` | 30 | R | Admin lesson detail page |
| `src/app/(admin)/admin/classes/[id]/edit/page.tsx` | 30 | R | Admin edit lesson page |
| `src/app/(admin)/admin/teachers/[id]/page.tsx` | 25, 64 | R | Admin teacher-detail aggregations |
| `src/app/(admin)/admin/students/[id]/page.tsx` | 76, 213 | R | Admin student-detail aggregations |
| `src/app/(admin)/admin/page.tsx` | 105, 169, 197 | R | Admin dashboard counts |
| `src/app/(admin)/admin/billing/BillingAdminClient.tsx` | 289, 373, 412 | R | Admin billing |
| `src/app/api/admin/billing/export/route.ts` | 117, 251, 348 | R | CSV exports |
| `src/app/api/admin/exports/[type]/route.ts` | 109, 183, 355, 428, 500 | R | CSV exports |
| `src/app/api/admin/teachers/[id]/route.ts` | 221, 258, 290 | R/W | Admin teacher delete cascade — **hard-deletes lessons** by teacher |
| `src/app/api/admin/students/[id]/route.ts` | 233, 276, 287 | R/W | Admin student delete cascade — **hard-deletes lessons** by student |
| `src/app/api/admin/reports/live-trace/route.ts` | 26 | R | Admin live trace |
| `src/app/api/cron/class-reminders/route.ts` | 35, 106, 123, 194 | R/W | 24h + 1h reminder cron |
| `src/app/api/cron/report-overdue/route.ts` | 25, 64 | R/W | Report-overdue cron |
| `src/app/(admin)/layout.tsx` | 74, 147 | R | Admin layout summaries |
| `src/app/api/student/reviews/route.ts` | 39 | R | Student reviews |

### Migration history of `classes` and `lessons`

There is **no migration history in-repo**. The `supabase/migrations/` folder contains only:
- `add_availability_rls_policies.sql`
- `add_study_sheet_attachments.sql`
- `add_teacher_first_login_flags.sql`

None reference `classes` or `lessons`. Any history of when `classes` was created, when `lessons` was added, or whether one was meant to replace the other lives only in the Supabase dashboard. **This is itself a finding** — see Open Questions.

JOURNAL.md line 2077 references "creates lesson record with TEAMS_LINK_PENDING placeholder" in an early build of the student-book route, and line 529 references the fix that replaced the sentinel with `null`. So the `lessons` table was the live one even at first booking go-live; `classes` was already obsolete by then. The 3 stale rows in `classes` are presumably pre-`lessons` seeds.

---

## Right panel vs Upcoming Classes vs Past Classes — source-of-truth diff

| Surface | File:line | Table | Filter on `scheduled_at` | Filter on `status` | Limit | Client |
|---|---|---|---|---|---|---|
| Teacher right panel ("Next Class") | `(dashboard)/layout.tsx:35` | `lessons` | `gt(now − 2h)` | `eq('scheduled')` | 1 | SSR anon (RLS) |
| Student right panel ("Next Class") | `(student)/student/layout.tsx:39` | `lessons` | `gt(now − 2h)` | `eq('scheduled')` | 1 | SSR anon (RLS) |
| Teacher Upcoming Classes | `(dashboard)/upcoming-classes/page.tsx:35-37` | `lessons` | **`gte(now)`** | `eq('scheduled')` | none | adminClient (RLS bypassed) |
| Student My Classes | `(student)/student/my-classes/page.tsx:40-43` | `lessons` | **`gte(now)`** | `in(['scheduled','cancelled'])` | none | SSR anon (RLS) |
| Student Past Classes | `(student)/student/past-classes/page.tsx:40-42` | `lessons` | none | `in(['completed','student_no_show','teacher_no_show'])` | none | SSR anon (RLS) |
| Teacher Past Classes | — | — | — | — | — | **Does not exist** — teacher uses `/reports` instead |
| Student in-portal reminder modal | `components/student/ClassReminderModal.tsx:69-83` | `lessons` | `gte(now), lte(now + ~60min)` | `eq('scheduled')` | 1 | browser anon (RLS) |
| Class-reminder cron 24h | `api/cron/class-reminders/route.ts:34-49` | `lessons` | `gte(now+23h), lte(now+25h)` | `eq('scheduled')` + `eq(reminder_24_sent, false)` | none | service-role |
| Class-reminder cron 1h | `api/cron/class-reminders/route.ts:122-137` | `lessons` | `gte(now+45m), lte(now+75m)` | `eq('scheduled')` + `eq(reminder_1h_sent, false)` | none | service-role |
| Report-overdue cron | `api/cron/report-overdue/route.ts:24-35` | `lessons` | `lte(now − 12h)` | **`in(['completed','no_show'])`** | none | service-role |

### Where the divergence is

**For Symptom B**, the only meaningful difference between right-panel and Upcoming Classes is the `scheduled_at` filter:

- Right panel uses `gt(now − 2h)`. A lesson at 11:30 UTC stays selectable until 13:30 UTC.
- Upcoming Classes uses `gte(now)`. A lesson at 11:30 UTC drops out of the list at 11:30 UTC sharp — even if it's a 60-minute class still in progress.

This is *exactly* the symptom: at 11:38 UTC the right panel still resolves the row (because 11:30 > 09:38) while the Upcoming Classes list silently empties. Same RLS context (admin client on Upcoming Classes; the student My Classes uses anon-RLS but the same `gte(now)` window, so the student page exhibits the same gap).

The student My Classes additionally filters on `in(['scheduled','cancelled'])`, which would let a `cancelled` row continue to render if the same time-window allowed it — but the time filter dominates.

The teacher right panel uses `supabase` (anon, RLS) while Upcoming Classes uses `adminClient` (RLS bypassed). RLS could in principle hide the row from the right panel — but evidence shows the row appears in the right panel and the right panel uses the anon client, so RLS for the teacher's own lesson clearly works. RLS is not the cause of the divergence.

### Past Classes for the student today

The evidence row is `status='scheduled'`. Past Classes filters `in(['completed','student_no_show','teacher_no_show'])` — even after the lesson ends, **nothing transitions a lesson out of `scheduled`** (see Phase 6). The lesson will remain invisible to Past Classes forever unless an admin manually mutates the status.

---

## Join Now lifecycle

There are **four** independent Join-Now implementations. They disagree.

### 1. Teacher right panel — `src/components/layout/RightPanel.tsx:115-178`

```ts
const classEndTime = nextLesson
  ? new Date(nextLesson.scheduled_at).getTime() + nextLesson.duration_minutes * 60 * 1000
  : null
const classEnded = classEndTime ? Date.now() > classEndTime : false
const isJoinable = mounted
  && secondsUntil !== null
  && secondsUntil <= 10 * 60
  && !classEnded
  && nextLesson != null
  && !BLOCKED_STATUSES.includes(nextLesson.status)
```

Correctly gates by `scheduled_at + duration_minutes`. **However**, the surrounding text at line 137-143 says "Class is starting now" whenever `secondsUntil <= 0` — including past end-time, for up to 2h after start (because the SSR layout query keeps the lesson selectable for that long). The Join button hides correctly; the heading is wrong.

### 2. Student right panel — `src/components/student/layout/StudentRightPanel.tsx:54-58`

```ts
function isJoinable(isoString: string, status: string, now: number): boolean {
  if (BLOCKED_STATUSES.includes(status)) return false
  const secondsUntil = Math.max(0, Math.floor((new Date(isoString).getTime() - now) / 1000))
  return secondsUntil <= 600 // 10 minutes
}
```

**Does not check class end time.** Once `scheduled_at` is reached, `secondsUntil` is clamped to 0 and stays ≤ 600 forever; combined with the layout query keeping the row for `now − 2h`, the student's Join Class link stays joinable for the full 2 hours past start, regardless of duration. **This is the precise mechanism for Symptom A on the student portal.**

### 3. Teacher Upcoming Classes card — `src/app/(dashboard)/upcoming-classes/UpcomingClassesClient.tsx:153-159`

```ts
const now = Date.now()                                             // ← computed once at render
const minutesUntilStart = (new Date(cls.starts_at).getTime() - now) / 1000 / 60
const classEnded = now > new Date(cls.ends_at).getTime()
const showJoinButton = minutesUntilStart <= 10 && !classEnded
```

`now` is a free `Date.now()` snapshot, not state. The visible state never updates with the wall clock — only `Countdown` (line 81) is on a tick. So the Join button is whatever the snapshot was at last render. In practice this is masked by the page's server-side filter (`gte(now)`), which removes the row from the SSR data the moment scheduled_at passes — the user never sees this card during/after a class. Independent stale-clock bug, just hidden today.

### 4. Student My Classes card — `src/app/(student)/student/my-classes/MyClassesClient.tsx:93-97`

```ts
function isJoinable(isoString: string, durationMinutes: number, now: number): boolean {
  const endTime = new Date(isoString).getTime() + durationMinutes * 60 * 1000
  if (endTime <= now) return false
  return getSecondsUntil(isoString, now) <= 600
}
```

Correct end-time gating. `now` here is in state and ticks (line 113-114). Also masked by SSR `gte(now)` filter on the page.

### Summary

| Surface | `<= scheduled+10min` | `> scheduled` | `> scheduled+duration` |
|---|---|---|---|
| Teacher right panel | shown | shown | hidden |
| **Student right panel** | shown | **shown** | **shown for 2h** |
| Teacher Upcoming Classes | (row absent) | (row absent) | (row absent) |
| Student My Classes | (row absent) | (row absent) | (row absent) |

The mismatch between row 2 and row 1 is the asymmetric Symptom A on the student side; the rows-absent column is Symptom B.

### Status transitions a Join button cares about

`BLOCKED_STATUSES = ['cancelled', 'completed', 'student_no_show', 'teacher_no_show']` is the same in both right-panel components. But in production, **no code path ever sets a lesson to `'completed'` or `'student_no_show'` / `'teacher_no_show'`** (see Phase 6) — so the only state that ever blocks a Join is `cancelled`. The `BLOCKED_STATUSES` set is mostly aspirational.

---

## Booking write paths

### A. Student booking finalisation — `src/app/api/student/book/route.ts`

Sequence (both fresh booking and reschedule):

1. **Auth + validation** (lines 117-156). Zod via `BookClassSchema`, plus per-student rate limiter.
2. **Hours-balance precheck** (158-182). Reads `trainings`, returns 400 if insufficient.
3. **24-hour rule** (184-191). Hard-coded against `Date.now()`; uses UTC arithmetic.
4. **Server-side availability re-check** via `isSlotAvailable` (193-202).
5. **Teacher clash check** (215-238). Window: `[scheduled_at − 90min, scheduled_at + duration)`.
6. **Atomic deduction RPC** `book_class_atomic(p_training_id, p_hours_needed)` (line 246).
7. **Reschedule branch** (273-289): if `rescheduleId`, mark old row `cancelled` with reason `'Rescheduled by student'`. **No hours refund.**
8. **MS Graph call** (298-311). Try/catch, swallowed. On failure `teamsJoinUrl` and `teamsMeetingId` remain `null`.
9. **Lesson INSERT** (316-329). On error, `refund_hours_atomic` is invoked (333-339).
10. **Email send** (367-392).

Fields written on insert: `training_id`, `teacher_id`, `student_id`, `scheduled_at`, `duration_minutes`, `teams_join_url`, `teams_meeting_id`, `status='scheduled'`. `cancelled_at`, `cancellation_reason`, `updated_at`, `reminder_24_sent`, `reminder_1h_sent`, `report_overdue_sent` rely on DB defaults.

### B. Admin manual booking — `src/app/api/admin/classes/route.ts` POST

Same shape (lines 124-358), but no 24-hour rule, no rate limit, no `isSlotAvailable` re-check. Has the same atomic RPC, the same Graph-failure-tolerant pattern, the same lesson-insert refund branch. `localToUtc` (line 160-171) converts a naive `YYYY-MM-DDTHH:MM` from the *teacher's* timezone to UTC by probing `Intl.DateTimeFormat` — DST-safe per the comment.

### Failure-mode analysis

| Failure | Hours state | Lesson state | Teams meeting state |
|---|---|---|---|
| Graph API fails | deducted | inserted with `teams_join_url=null`, `teams_meeting_id=null` | not created |
| Lesson insert fails after Graph success | refunded via RPC | not inserted | **orphaned in organiser calendar** |
| Lesson insert fails on reschedule (after cancelling old row) | refunded for the new attempt | new row absent, old row already cancelled | new orphaned, old still active |
| Cancel-old-lesson fails on reschedule | already deducted, no refund | old row still scheduled | n/a yet |

Specifically:

- **Reschedule + Graph success + new-insert failure** silently strands the user: hours are refunded, but their old slot has been cancelled with `'Rescheduled by student'` and no replacement was created. The route returns a 500 and the front-end shows an error, but the underlying state is broken until a human sorts it out.
- **Reschedule double-deduction on success path.** On reschedule, `book_class_atomic` deducts hours for the *new* lesson (line 246), then the *old* lesson is cancelled (line 273-289) **without any matching refund**. A reschedule of a 60-minute class therefore consumes 2 hours from the training. Confirmed by inspection: there is no `refund_hours_atomic` call in the reschedule branch and no other code path that compensates the cancelled old row.
- **`teams_join_url=null` is written on Graph failure.** The journal note at line 529 confirms this is by design (replaces an earlier `'TEAMS_LINK_PENDING'` sentinel that was bypassing null checks). The two existing `'TEAMS_LINK_PENDING'` rows in production are pre-fix artifacts. No source path now writes that sentinel.

### Cascading deletes worth noting

`src/app/api/admin/teachers/[id]/route.ts:290` and `src/app/api/admin/students/[id]/route.ts:287` hard-delete every `lessons` row tied to the teacher or student before deleting the parent record. Reports referencing those lessons are also cleaned up at line 283 of each. No Graph-side cleanup; meetings linger in the organiser calendar.

---

## Cancellation / reschedule / swap

### Student-initiated cancel — `src/app/(student)/student/my-classes/actions.ts:13-138`

- Sets `status='cancelled'`, `cancelled_at=now`, `cancellation_reason='Cancelled by student'`. **Does not stamp `updated_at`.**
- 24-hour rule (line 47-51): refund only if `> 24h` until class.
- Hours refund is a non-atomic `update trainings set hours_consumed = max(0, current - X)` — read-then-write, no locking. Concurrent booking could reset hours_consumed under the read.
- Cancellation policy enum is hardcoded `'24hr'` only — never reads `students.cancellation_policy` to honour the `48hr` B2B variant.
- **No teacher-pay-protection logic anywhere.** Cancellations under 24h consume the student's hour but produce no audit trail; the billing layer reads lessons regardless and may already be billing the teacher (see `BillingClient.tsx:182` filter). Confirmation needed via DB inspection.
- Teams meeting is never cancelled (`cancelTeamsMeeting` is exported from `src/lib/microsoft/graph.ts:115` but **has zero call sites in `src/`** — confirmed by ripgrep).

### Teacher-initiated "reschedule" — `src/app/(dashboard)/upcoming-classes/actions.ts:9-138`

The function is called `teacherRescheduleLesson` but it only **cancels**. There is no rebook step.

- Enforces 24-hour rule.
- Sets `status='cancelled'`, `cancelled_at=now`, `cancellation_reason=<message>`. **Does not stamp `updated_at`.**
- Always refunds hours (no policy check). Same non-atomic read-modify-write.
- Sends an email to the student titled "*Your class has been rescheduled by your teacher*" — but functionally there's no rescheduling; the student must rebook.
- No Teams meeting cancellation.

### Admin cancel — `src/app/api/admin/classes/[id]/route.ts:137-214`

- Sets `status='cancelled'`, `cancelled_at=now`, `cancellation_reason`. Does stamp `updated_at`.
- Always refunds hours, non-atomic (line 161-167). Concurrent admin-cancel + student-book on the same training can race.
- No `cancelTeamsMeeting` call.

### Admin reschedule (in-place) — `src/app/api/admin/classes/[id]/route.ts:216-298`

- **In-place update** of `scheduled_at`, `teacher_id`, `duration_minutes`. Lesson keeps its row.
- **Teams meeting is NOT updated.** `updateTeamsMeeting` is defined at `src/lib/microsoft/graph.ts:84` but, as with `cancelTeamsMeeting`, has **zero call sites**. The join URL stays the same (good — link is preserved), but the *time* of the underlying calendar event in the organiser's mailbox is now wrong.
- Duration change adjusts hours_consumed via a non-atomic update (line 225-243).

### Teacher swap

`teacher_id` can be PATCHed (line 221) on the lesson row. The Teams meeting is created under a fixed organiser account (`Admin@LingualinkOnline.onmicrosoft.com`, `src/lib/microsoft/graph.ts:9`), so the join URL is intrinsically unaffected by which teacher is on the row. The brief's "links must be tied to lesson slots, not teachers" property holds for admin reschedule and admin teacher swap — but **breaks on student-initiated reschedule** because that path is implemented as cancel+create with a fresh `createTeamsMeeting` call (`api/student/book/route.ts:299`). The new lesson gets a new `teams_join_url`. The student's link from the original confirmation email is still valid (the old meeting is not cancelled), so they may join the wrong meeting.

### Reschedule status enum drift

`api/admin/classes/route.ts:84` filters cancelled lessons via `in(['cancelled','cancelled_by_student','cancelled_by_teacher'])`, but only one cancel write path uses any of the suffixed values: nowhere. All four cancel write paths in `src/` write the bare string `'cancelled'`. The `cancelled_by_student` / `cancelled_by_teacher` enum values exist as filter targets but are never produced. `(dashboard)/layout.tsx:86` similarly enumerates `'cancelled_by_student'` in its billing filter for naught.

---

## Cron and reminders

### Schedule (`vercel.json`)

```
class-reminders:    0 8 * * *
report-overdue:     0 8 * * *
training-ending:    0 8 * * *
low-hours-warning:  0 8 * * *
invoice-reminder:   0 8 1 * *
keep-alive:         0 0 * * *
```

All daily at 08:00 UTC; class-reminders is **not** the `*/15 * * * *` schedule its window logic was designed for.

### Class-reminders — `src/app/api/cron/class-reminders/route.ts`

- Reads `lessons`, filters `eq(status, 'scheduled')` plus `eq(reminder_*_sent, false)`.
- 24h window: `[now+23h, now+25h]` (line 31-32, 48-49).
- 1h window: `[now+45m, now+75m]` (line 119-120, 136-137).
- After successful send, marks `reminder_*_sent = true` on the lesson row (line 105-108, 193-196). Dedupe is correct.

With cron firing once at 08:00 UTC daily:

- **24h reminder** can only catch lessons scheduled **between 07:00 and 09:00 UTC the next day** (a 2-hour band). Anything outside that band gets no 24h email.
- **1h reminder** can only catch lessons scheduled **between 08:45 and 09:15 UTC the same day** (a 30-minute band).

Today's evidence row (11:30 UTC) sits in neither band, which explains its `reminder_24_sent=false` and `reminder_1h_sent=false`. This is consistent with the journal note pinning the cause on cron cadence, not on cron logic.

### Report-overdue — `src/app/api/cron/report-overdue/route.ts`

- Filters `in(status, ['completed','no_show'])` (line 33). **No lesson is ever in either of these statuses** in production today, so this cron operates on zero rows.
- Even if status transitions existed, the filter would also miss the actual values used in the rest of the codebase (`student_no_show`, `teacher_no_show`) — it expects a generic `'no_show'` value that nothing writes.
- Action on a matching row is `update lessons set report_overdue_sent = true`. No report row is created here, no email sent, no flagging done. **The cron is a no-op even on its happy path.**
- A separate trigger or edge function must be responsible for creating `reports` rows when a lesson is inserted, since `reports` is read in many places (`src/app/(dashboard)/reports/page.tsx:20`, etc.) but **no `src/` code inserts into `reports`** — confirmed by `rg "from\('reports'\)\s*\.insert"` (zero matches).

### Status transition cron

There is none. **Nothing in `src/` ever writes `'completed'`, `'student_no_show'`, or `'teacher_no_show'` to `lessons.status`.** Confirmed by ripgrepping every `from('lessons').update` call: every one writes either `status='cancelled'` or a reminder/report flag. Symptom A's secondary aspect (lesson still appears as next-up after end) and Symptom B's "Past Classes shows 0 completed" are both downstream of this single missing write path.

---

## Timezone integrity

- **Storage**: `lessons.scheduled_at` stored as UTC ISO. Confirmed by all read/write call sites doing `new Date(...).toISOString()` and the evidence row format `2026-05-08 11:30:00+00`.
- **Server-rendered emails**: `formatDateTime` at `api/student/book/route.ts:100-111` and the email helpers at `src/lib/email/templates.ts` use `Intl.DateTimeFormat` with explicit `timeZone`. Each recipient is rendered in their own timezone. Good.
- **Student client-side rendering**: `MyClassesClient.tsx:45-72` and similar use `Intl.DateTimeFormat` with the student's timezone passed from the server. Good.
- **Teacher right panel**: `RightPanel.tsx:50-65` formats via `date.getHours()` / `getMinutes()` (local browser timezone) — manual construction, not `toLocaleTimeString`. This is consistent with the project rule against `toLocaleTimeString` and avoids hydration mismatches, but renders in the **browser's** timezone, not the teacher's stored `profiles.timezone`. Visually aligned for teachers in their home timezone but wrong if a teacher logs in while travelling.
- **`toISOString` audit**: every call site I read constructs a `Date` from another `Date.getTime()` arithmetic and then serialises — none builds an ISO from naive local components, which would be the forbidden pattern. The one place that builds from naive parts (`api/admin/classes/route.ts:160-171`) uses an explicit `Intl`-based offset probe before serialising. OK.
- **Day-of-week edge case in availability** — `src/lib/availability.ts:65-66` computes `dayOfWeek = date.getUTCDay()` from `scheduledAtUtc.slice(0,10)` (UTC date portion). For a teacher in a UTC+2 timezone booking a 23:30 SAST class on a Friday (= 21:30 UTC Friday), `dayOfWeek=5` (Friday) — fine. But for a 01:30 SAST Saturday class (= 23:30 UTC Friday), the UTC date is Friday — so the Saturday general-availability template is not consulted. **Bug for late-night/early-morning slots that cross the UTC boundary in either direction.** Pinned in journal (S81 "availability blocks 22:00+ rolling onto next day") — root cause here.
- **DST**: SAST has no DST. European students do; the layout queries call `new Date(Date.now() − 2h).toISOString()` which is timezone-agnostic, so right-panel windows are unaffected. The one DST-sensitive routine is `localToUtc` in `api/admin/classes/route.ts:160-171` and it's been written to handle DST via `Intl` probe. OK.

---

## Schema truth (from code inspection only)

| Concern | Observation |
|---|---|
| Status values **written** to `lessons.status` | `'scheduled'` (insert), `'cancelled'` (every cancel path) |
| Status values **read** | `'scheduled'`, `'cancelled'`, `'cancelled_by_student'`, `'cancelled_by_teacher'`, `'completed'`, `'student_no_show'`, `'teacher_no_show'`, `'flagged'`, `'no_show'` |
| Statuses written but never read | none |
| Statuses read but never written | `'completed'`, `'cancelled_by_student'`, `'cancelled_by_teacher'`, `'student_no_show'`, `'teacher_no_show'`, `'flagged'`, `'no_show'` |
| Restricted/sensitive columns | `hourly_rate`, `admin_notes`, `cancellation_policy` per CLAUDE.md (column-level REVOKE). Inspected paths use `createAdminClient()` for these, consistent with that policy. |
| RLS context | Right-panel and student My Classes use `createClient()` (anon, RLS); admin and cron use service role. RLS itself is not verifiable from this audit — see Open Questions. |

The huge gap between status values written and statuses read is the most consequential finding of this section.

---

## hours_log integrity

`hours_log` is **only written** at `src/app/api/admin/students/[id]/hours/route.ts:138` — admin manual hours adjustments. **Never** written by booking, cancel, or reschedule.

- Booking deducts via `book_class_atomic` RPC → updates `trainings.hours_consumed` only.
- Cancel refunds via direct `update trainings ... hours_consumed = ...` → updates `trainings` only.
- Lesson-insert failure refund via `refund_hours_atomic` RPC → updates `trainings` only (presumed; the RPC body is in DB).
- Reschedule double-charge (Phase 4) — also invisible to `hours_log`.

So `hours_log` is **not an audit trail of lesson activity**; it only records what an admin punched in. Reconstructing actual hours flow from the log alone is impossible.

The student's evidence training shows `hours_consumed = 1.00`. The `lessons` table has 9 rows for that training, of which several are real bookings — without DB access I cannot reconcile the value to the row history. See Open Questions.

---

## Cross-reference against past sessions

| Journal note | Status in current code |
|---|---|
| S81 — calendar gutter 24h vs event labels 12h | `DayToDay.tsx:263-285` reads UTC ISO, formatting handled by FullCalendar; not reproducible from this audit alone. **Open** for browser verification. |
| S81 — slot offset (10:00 event renders at 09:30) | Likely the `localTimeToUtcMs` rounding behaviour in `src/lib/availability.ts:16-31`. **Still present** as written. |
| S81 — availability 22:00+ rolling to next day | Confirmed root cause in `src/lib/availability.ts:65-66` UTC `getUTCDay()` mismatch. **Still present.** |
| S81 — teacher availability changes not reflecting on student calendar after refresh | Out of scope for this trace; would need to inspect the student book page + availability route caching. **Open.** |
| Pre-S70 unavailability rows with wrong UTC offsets | DB-state question. **Open.** |
| 24-hour booking rule patched S56 | Present and consistent in both display (`UpcomingClassesClient.tsx:159` `showReschedule`) and write (`api/student/book/route.ts:184-191`). |
| Reschedule preserves Teams link | **False on student path** (cancel+create makes a new URL). **True on admin path** (in-place update keeps URL but doesn't sync the Graph event time). |
| Teacher swap link stability | True — Teams meeting is on a shared organiser, never re-created on `teacher_id` change. |
| Right-panel parity teacher vs student | **Differs** — student's `isJoinable` lacks the end-time check (Phase 3). |

---

## Findings

Each item cites file and line, maps to symptom, and notes ripple risk if touched.

### Critical

**C1. Student right panel keeps Join Class active for 2 hours past start.**
*Anchors:* `src/components/student/layout/StudentRightPanel.tsx:54-58` (`isJoinable` lacks end-time check) + `src/app/(student)/student/layout.tsx:39-47` (`gt(now − 2h)` data window).
*Symptom:* A (primary cause on student side).
*Ripple:* Adding an end-time check is a 3-line change in `isJoinable`. Tightening the layout's `gt` to `gt(now − duration_minutes_max)` would also need a stale-row sweep, since `lessons` accumulate `scheduled` rows that never transition.

**C2. Lesson status never transitions out of `scheduled`.**
*Anchors:* `src/app/api/cron/report-overdue/route.ts:24-72` (only cron with any lesson-write authority — only flips `report_overdue_sent`); no `from('lessons').update({ status: 'completed' | 'student_no_show' | 'teacher_no_show' })` exists in `src/`.
*Symptom:* B (Past Classes empty) and indirectly A (right-panel `BLOCKED_STATUSES` check is dead code).
*Ripple:* Closing this requires either a server-side cron that promotes ended `scheduled` rows to `completed`, or coupling the report-submit step to also write the lesson status. Whichever path, it is also where teacher-pay billability gets locked in — touching it changes invoice numbers retroactively for any backdated reports.

**C3. Upcoming Classes filter drops a lesson the moment it starts.**
*Anchors:* `src/app/(dashboard)/upcoming-classes/page.tsx:37` and `src/app/(student)/student/my-classes/page.tsx:41` both use `.gte('scheduled_at', new Date().toISOString())`.
*Symptom:* B (primary cause).
*Ripple:* The fix is a wider window (e.g. `gte(now − duration_minutes_max)` or based on `scheduled_at + duration_minutes < now` evaluated row-side), but Postgres can't filter on `scheduled_at + duration_minutes` server-side without a generated column or RPC. Cheapest fix: pull a small surplus and filter client-side. Watch for pagination breakage — neither page paginates today, but the filter change interacts with the cron's status-transition fix above.

**C4. Student reschedule double-deducts hours.**
*Anchors:* `src/app/api/student/book/route.ts:246-249` deducts new hours, then 273-289 cancels old lesson **without refund**.
*Symptom:* Independent (financial).
*Ripple:* Adding a refund needs the atomic RPC pair to commit-or-rollback together to avoid the inverse failure (refund without cancel succeeding). Lower risk: refund the old hours first, fail-fast if cancel fails, then deduct new. Either way, this changes how `trainings.hours_consumed` evolves and any unit test built on the current behaviour will need updating.

**C5. Reschedule + Graph success + lesson-insert failure leaves the student with a cancelled old lesson and no replacement.**
*Anchors:* `src/app/api/student/book/route.ts:273-289` (cancel old) → 298-311 (Graph success) → 316-340 (insert failure refunds hours but never re-creates or re-instates the cancelled lesson).
*Symptom:* Independent (data integrity / customer trust).
*Ripple:* Either wrap the whole reschedule in a transaction (the Supabase JS client cannot — would need a single RPC), or restore `status='scheduled'` on the cancelled row when the new insert fails. Restoring is the cheaper change.

### High

**H1. Teams meetings are never cancelled or updated.**
*Anchors:* `src/lib/microsoft/graph.ts:84` (`updateTeamsMeeting`) and `:115` (`cancelTeamsMeeting`) — both exported, **zero call sites.**
*Symptom:* Independent (Teams hygiene + customer confusion).
*Ripple:* Wiring them into the cancel/reschedule paths is straightforward but failure-prone (Graph 5xx). Every site that writes `status='cancelled'` (4 places) needs to call `cancelTeamsMeeting`. Admin reschedule needs `updateTeamsMeeting`. Failure tolerance must mirror the create path (log + Sentry, don't block the DB write).

**H2. Hours-balance updates outside `book_class_atomic` are non-atomic.**
*Anchors:* `src/app/api/admin/classes/[id]/route.ts:161-167` (cancel refund), `225-243` (duration change), `(dashboard)/upcoming-classes/actions.ts:78-82` (teacher cancel refund), `(student)/student/my-classes/actions.ts:74-80` (student cancel refund).
*Symptom:* Independent (race conditions).
*Ripple:* All four paths should call a `refund_hours_atomic` RPC (the function exists per `api/student/book/route.ts:333`). Should be a uniform refactor.

**H3. Class-reminder cron schedule cannot satisfy the cron's window logic.**
*Anchors:* `vercel.json:5` schedule `0 8 * * *` vs `src/app/api/cron/class-reminders/route.ts:31-32, 119-120`.
*Symptom:* Independent (most lessons get no automated reminder).
*Ripple:* Switching to `*/15 * * * *` requires a Vercel Pro plan (per the journal note about Hobby limits) or a self-hosted cron. If the schedule is changed without widening `reminder_*_sent` indexing, every fire scans the same rows.

**H4. Status enum drift — written values are a strict subset of read values.**
*Anchors:* every `from('lessons').update({ status: 'cancelled' ... })` and every `.in('status', [...])` filter (see Schema truth section).
*Symptom:* B (Past Classes filter mismatch); A indirectly.
*Ripple:* Moderate. Decide on a canonical set, deprecate the unused values from filters, and add status transitions for the values that need to exist (`completed`, `student_no_show`, `teacher_no_show`). Coupled to C2.

**H5. Report-overdue cron is a no-op.**
*Anchors:* `src/app/api/cron/report-overdue/route.ts:33` filters `in(['completed','no_show'])`.
*Symptom:* Independent (overdue reports never flagged automatically).
*Ripple:* Filter must be aligned with whatever statuses are produced after C2 is fixed; until then this cron does nothing useful.

### Medium

**M1. Stale `Date.now()` on Teacher Upcoming Classes Join button.**
*Anchor:* `src/app/(dashboard)/upcoming-classes/UpcomingClassesClient.tsx:155-158` — `now` is read once per render.
*Symptom:* Latent — masked by SSR `gte(now)` filter today. Surfaces if C3 is fixed.
*Ripple:* Move to interval-driven state, like `MyClassesClient`.

**M2. Teacher right panel "Class is starting now" persists past end.**
*Anchor:* `src/components/layout/RightPanel.tsx:137-143`.
*Symptom:* A (cosmetic on teacher side; bot user-facing claim is wrong).
*Ripple:* One-line fix — also gate the heading on `!classEnded`.

**M3. Teacher right panel formats time in browser timezone, not teacher timezone.**
*Anchor:* `src/components/layout/RightPanel.tsx:50-65`.
*Symptom:* Independent — wrong only when teacher logs in away from home timezone.
*Ripple:* Pass `teacherTimezone` from the server layout (already loaded for billing) and switch to `Intl.DateTimeFormat`.

**M4. Cancellation policy enum value `'48hr'` is never honoured in cancel logic.**
*Anchor:* `src/app/(student)/student/my-classes/actions.ts:51` hard-codes 24h.
*Symptom:* Independent (B2B contract violations).
*Ripple:* Read `students.cancellation_policy` and parse — a few lines, but billing implications.

**M5. UTC day-of-week mismatch in `isSlotAvailable`.**
*Anchor:* `src/lib/availability.ts:65-66`.
*Symptom:* Independent — known journal item (S81).
*Ripple:* Compute day-of-week in the *teacher's* timezone, not UTC.

**M6. `hours_log` is not a real audit trail.**
*Anchor:* `src/app/api/admin/students/[id]/hours/route.ts:138` is the only writer.
*Symptom:* Independent — affects auditability, not user behaviour.
*Ripple:* Writing log rows from booking and cancel flows is straightforward but must not become a TOCTOU window itself; ideally inside the same RPC as the `trainings` update.

### Low

**L1. Stale snapshot file `codebase.txt` at repo root references the dead `classes` table.**
*Anchor:* `C:\Projects\lingualink-lms\codebase.txt:17811, 20279`.
*Symptom:* Audit-only — leads anyone running `rg from\('classes'\)` to wrongly conclude the application still uses `classes`.
*Ripple:* Delete or move out of the repo.

**L2. Three orphan rows in `classes` table (per evidence).**
*Anchor:* DB only.
*Symptom:* Independent — no code path reads or writes `classes`, so the rows are inert. Worth dropping the table.
*Ripple:* Verify no FKs from other tables before drop.

**L3. Teacher rescheduleLesson is misnamed — it cancels.**
*Anchor:* `src/app/(dashboard)/upcoming-classes/actions.ts:9`.
*Symptom:* Independent — naming-only confusion.
*Ripple:* Renaming + email subject string only.

**L4. `cancellation_reason` writers are inconsistent — student cancel does not stamp `updated_at`; admin cancel does.**
*Anchors:* `(student)/student/my-classes/actions.ts:57-61` vs `api/admin/classes/[id]/route.ts:142-146`.
*Symptom:* Independent — sort-by-recently-updated breaks.
*Ripple:* Trivial.

**L5. `cancelled_by_student` / `cancelled_by_teacher` enum values are filter-only, never written.**
*Anchor:* see H4.
*Symptom:* Independent — filters are aspirational.
*Ripple:* Either start writing them or drop them from filters.

---

## Open questions for the developer

1. **Is there a DB trigger that creates `reports` rows when a lesson is inserted?** No `src/` code does. If yes, where is it defined and what status does it write? Verifying its filter (`status` values it accepts) is a prerequisite to fixing H5 / C2.
2. **Are the `book_class_atomic` and `refund_hours_atomic` RPC bodies in DB-only?** They are referenced in `src/` but defined nowhere in the repo. The atomicity claims (TOCTOU closure) depend on `SELECT … FOR UPDATE` in the function body — confirmed from comments only.
3. **Migration history for `classes` and `lessons` — does the Supabase dashboard show that `classes` was created first, then superseded?** This affects whether `classes` can be safely dropped or whether some external system still ingests it.
4. **What FKs reference `classes`?** Per JOURNAL.md, `student_reviews.class_id` is one (it's queried on the student past-classes page). That FK presumably points at `lessons.id` despite the column name — confirm.
5. **What are the actual RLS policies on `lessons`?** The right panel uses anon-RLS; Upcoming Classes uses admin client. The audit assumes RLS allows a teacher to read their own scheduled lessons (otherwise the right panel would also fail). Worth verifying explicitly given the column-level REVOKEs noted in CLAUDE.md.
6. **Reconcile the evidence student's `trainings.hours_consumed = 1.00` against the 9 `lessons` rows.** With C4 (reschedule double-deduct) and the "two `'TEAMS_LINK_PENDING'` rows" history, the value cannot be derived from the rows alone — it depends on which `book_class_atomic` and `refund_hours_atomic` calls succeeded.
7. **Is the cron currently running on the Hobby plan via `0 8 * * *` understood to be the temporary state, or is the team accepting that most reminders will not fire?** The window logic is designed for `*/15` and the journal says the schedule was throttled — confirm the intent before any fix touches the windows.
8. **The two existing `'TEAMS_LINK_PENDING'` rows in production** — should they be rewritten to `null` (so the admin alert filter sees them) or backfilled with real Graph URLs?

---

End of audit.
