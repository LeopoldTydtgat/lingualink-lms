# CLAUDE.md — Teacher Portal

Inherits all root rules. Teacher-portal specifics:

- Host: `teachers.lingualinkonline.com`. Shared cookie domain `.lingualinkonline.com` with `isProductionHost` gate (localhost compatibility) — see `src/lib/host.ts`.
- A teacher sees ONLY their own data: own classes, reports, students, schedule, billing. Any query here must scope to the logged-in teacher. The admin (dual-role) override lives in the admin portal, not here.
- Class reports: report required after EVERY class incl. student no-shows. 12hr completion window; after 12hr auto-flagged. Only admin reopens a flagged report.
- Payment logic teachers must never see altered: paid for all classes incl. student no-show; NOT paid when they are the no-show. The 48hr B2B `cancellation_policy` is admin-only and must never surface in teacher queries or UI.
- Join window and Teams link: link is tied to the lesson slot, not the teacher. A teacher swap must NOT change the student's join URL.
- Billing currency shown is EUR (display only); never expose ZAR conversion or any private client/payment detail.

Before editing teacher data-access code, confirm the query is teacher-scoped and run the `code-reviewer` subagent.
