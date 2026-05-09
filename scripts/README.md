# One-off scripts

Scripts in this directory are infrequent operational tools. They are not part of the application build or any CI pipeline. Each script is safe to re-run (idempotent).

Run `npm install` once before running any script so that `tsx` and `dotenv` are available.

---

## cleanup-orphan-teams-meetings.ts

### Purpose

Pre-H1a code did not call the Graph DELETE endpoint when a lesson was cancelled. Some cancelled lessons in the database therefore still have a non-null `teams_meeting_id` pointing to a live Teams calendar event in the organiser mailbox. This script finds all such rows, deletes the corresponding Graph events via the organiser account, and then nulls out `teams_meeting_id` and `teams_join_url` on each affected lesson row. The script covers all cancellation status variants: `cancelled`, `cancelled_by_student`, `cancelled_by_teacher`, `teacher_cancelled`.

### Prerequisites

A `.env.local` file at the project root containing:

```
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

The script loads `.env.local` automatically. No extra setup is needed.

### Dry run (no changes made)

```bash
npm run script:cleanup-teams
```

Prints one object per affected lesson row showing the lesson id, status, scheduled_at, a truncated meeting id, and whether a join URL is present. Makes no Graph calls and does not modify the database.

### Execute

```bash
npm run script:cleanup-teams -- --execute
```

For each affected row:

1. GET-probes the Graph event to confirm it exists and is reachable under the organiser UPN.
2. If the event exists (200): calls `cancelTeamsMeeting` to DELETE it, logs `DELETED`.
3. If the event is already gone (404): logs `ALREADY-GONE`, skips the DELETE.
4. On any other error from the probe or DELETE: logs `CRITICAL` with `{ phase, teams_meeting_id, lesson_id, error }`, increments the error counter, and moves on to the next row without stopping the batch.
5. After a successful DELETE or ALREADY-GONE: nulls `teams_meeting_id` and `teams_join_url` on the lesson row using the service-role client.

### What "done" looks like

Exit code 0 in both modes. In execute mode, the final summary block should show `Errors: 0` and `DB cleaned` equal to `Deleted + Already gone`. Re-running after a clean execute returns "No orphan meetings found." and exits immediately.

### Idempotency

Safe to re-run at any time. If a Graph event was already deleted, the GET probe returns 404 and the script skips the Graph DELETE, proceeding directly to DB cleanup. If the DB row was already cleaned (both fields null), the initial query filters it out and the row never appears in the result set.
