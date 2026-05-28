# CLAUDE.md — Student Portal

Inherits all root rules. Student-portal specifics:

- Host: `students.lingualinkonline.com`. Shared cookie domain as per root.
- A student sees ONLY their own data. Students can book only with teachers assigned to them — never browse all teachers.
- **No payments here.** Hours are added manually by admin after a WordPress purchase. The portal never processes payment. Never wire Payfast/payment logic into the student booking flow.
- Booking: 30/60/90 min only. Multi-slot bookings need consecutive free slots. Hours deducted immediately on confirm; the deduction goes through the atomic hours RPC, never a raw UPDATE.
- Cancellation: >24hr refunds hours; <24hr loses them (show the red warning BEFORE cancelling). Teacher cancel always refunds. The per-student 48hr policy is admin-only and invisible here — students always see the standard 24hr rule.
- Teams link is tied to the lesson slot; reschedule updates the link, teacher swap does not change it.
- `students.cancellation_policy` and `admin_notes` must never be selected by any student-portal query.

Before editing booking or hours code, run the `code-reviewer` subagent and confirm hours mutations use the RPC.
