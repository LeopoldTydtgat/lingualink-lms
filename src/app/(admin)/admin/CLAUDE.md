# CLAUDE.md — Admin Portal

Inherits all root rules. Admin-portal specifics (HIGHEST security sensitivity):

- Host: `admin.lingualinkonline.com`. The /admin route checks the user's `account_types` array server-side on EVERY request — never rely on client-side role checks alone.
- This is the ONLY place `admin_notes`, `cancellation_policy`, follow-up fields, and hourly_rate may be read/written. Exposing the 48hr B2B `cancellation_policy` to a teacher or student is a commercial breach.
- Role model is additive (`account_types text[]`). Render only nav/sections the role allows; restricted sections hidden entirely, not just disabled.
- Admin booking/edit bypasses the 24hr and availability rules that bind students/teachers — but still: Teams link via Graph API, hours via the atomic RPC, emails on confirm.
- **Teacher pay vs company billing distinction is absolute:** the 48hr policy affects what Lingualink bills the company — it NEVER changes teacher pay. Teachers are always paid only for cancellations under 24hr. Maintain this everywhere.
- Hours changes write to `hours_log` (full transaction history) AND update the training balance via the RPC. Deductions require a mandatory note.
- Every teacher-profile field change logs to `teacher_history_log`.

ALWAYS run `supabase-rls-auditor` after any admin data-access or role-gating change. This portal is where a leak does the most damage.
