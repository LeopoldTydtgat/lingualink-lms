import { createAdminClient } from '@/lib/supabase/admin'
import { getBillability } from '@/lib/billing/billability'
import { getMonthKeyInTz } from '@/lib/billing/monthRange'

// Lesson statuses that can contribute to invoices.amount_eur. Mirrors the
// .in() filter in BillingClient.tsx so the bucket sums match what the teacher
// /billing page would compute. teacher_no_show is intentionally excluded —
// billability.ts treats it as not billable, so it would only ever add zero.
const BILLABLE_LESSON_STATUSES: string[] = [
  'completed',
  'student_no_show',
  'cancelled',
  'cancelled_by_student',
  'cancelled_by_teacher',
]

// Recomputes invoices.amount_eur for one teacher.
//
// - Skips invoices with status='paid' (paid amounts freeze as a historical figure).
// - Skips rows whose computed value already matches the stored value (no-op write).
// - hourly_rate ≤ 0 or missing → no-op.
//
// Month-boundary reschedules: lessons are re-bucketed by their current
// scheduled_at in the teacher's timezone, so a class moved from April → May
// drains the April bucket and lands in May. Both invoice rows are then
// reconciled in the same pass — provided both rows exist (ensureCurrentInvoice
// only creates the current month; future-month buckets land on the next
// recompute after that row is created).
export async function recomputeInvoiceAmountsForTeacher(teacherId: string): Promise<void> {
  const admin = createAdminClient()

  const { data: teacher } = await admin
    .from('profiles')
    .select('id, hourly_rate, timezone')
    .eq('id', teacherId)
    .single()

  const hourlyRate = Number(teacher?.hourly_rate ?? 0)
  if (!teacher || hourlyRate <= 0) return

  const tz = teacher.timezone || 'UTC'

  const { data: invoices } = await admin
    .from('invoices')
    .select('id, billing_month, amount_eur, status')
    .eq('teacher_id', teacherId)

  if (!invoices || invoices.length === 0) return

  const { data: lessons } = await admin
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, status, cancelled_at')
    .eq('teacher_id', teacherId)
    .in('status', BILLABLE_LESSON_STATUSES)

  const sumByMonth: Record<string, number> = {}
  for (const lesson of lessons || []) {
    const key = getMonthKeyInTz(new Date(lesson.scheduled_at), tz)
    const bill = getBillability({
      status: lesson.status,
      scheduledAt: lesson.scheduled_at,
      cancelledAt: lesson.cancelled_at,
      // The 48hr policy branch never pays the teacher (billableToTeacher=false),
      // so cancellation_policy is irrelevant to amount_eur. Avoid the students join.
      cancellationPolicy: null,
      hourlyRate,
      durationMinutes: lesson.duration_minutes,
    })
    if (bill.billableToTeacher) {
      sumByMonth[key] = (sumByMonth[key] ?? 0) + bill.amount
    }
  }

  const updates = invoices
    .filter(inv => inv.status !== 'paid')
    .map(inv => {
      const raw = sumByMonth[inv.billing_month] ?? 0
      const rounded = Math.round(raw * 100) / 100
      const current = inv.amount_eur != null ? Number(inv.amount_eur) : null
      if (current === rounded) return null
      return admin.from('invoices').update({ amount_eur: rounded }).eq('id', inv.id)
    })
    .filter(<T,>(u: T | null): u is T => u !== null)

  if (updates.length > 0) await Promise.all(updates)
}

// Recompute every teacher's invoices. Batched at 5 concurrent recomputes so
// admin pages don't fan out an unbounded number of DB calls on load.
export async function recomputeInvoiceAmountsForAllTeachers(): Promise<void> {
  const admin = createAdminClient()
  const { data: teachers } = await admin
    .from('profiles')
    .select('id')
    .in('role', ['teacher', 'admin'])

  const ids = (teachers || []).map(t => t.id)

  const BATCH = 5
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    await Promise.all(slice.map(id => recomputeInvoiceAmountsForTeacher(id)))
  }
}
