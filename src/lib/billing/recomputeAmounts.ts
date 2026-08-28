import { createAdminClient } from '@/lib/supabase/admin'
import { getBillability, MONTH_BILLING_PREFILTER_STATUSES } from '@/lib/billing/billability'
import { getMonthKeyInTz } from '@/lib/billing/monthRange'
import { fetchLessonRateMap, resolveLessonRate } from '@/lib/billing/lessonRates'

type InvoiceRow = {
  id: string
  billing_month: string
  amount_eur: number | string | null
  status: string
}

const INVOICE_COLUMNS = 'id, billing_month, amount_eur, status'

// reference_number generator. Mirrors the teacher /billing page's
// ensureCurrentInvoice loop (src/app/(dashboard)/billing/page.tsx:69) —
// `INV-YYYYMM-XXXX` with a random 4-char base36 suffix.
//
// ONE deliberate difference: YYYYMM is derived from the billing_month key being
// inserted ('YYYY-MM-01'), never from new Date(). This path backfills months
// that have already passed, so a now-derived reference would stamp a March row
// with the current month.
function buildInvoiceReference(billingMonth: string): string {
  const yyyymm = `${billingMonth.slice(0, 4)}${billingMonth.slice(5, 7)}`
  return `INV-${yyyymm}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`
}

// Creates the (teacher_id, billing_month) invoice row if it doesn't exist.
// Returns true when the row exists afterwards (created here or by a concurrent
// request), false when it does not and the caller must not expect to update it.
//
// The live DB has UNIQUE (teacher_id, billing_month) on invoices, so a 23505
// here is one of exactly two things:
//   - invoices_teacher_id_billing_month_key -> another request won the race and
//     the row already exists. That is success: the update pass still needs to
//     land the amount in it.
//   - a reference_number collision -> the row does NOT exist; retry with a
//     fresh suffix (same 5-attempt bound as the /billing page).
// Any other insert error is logged with teacher_id + month and NOT swallowed
// into a false success.
async function ensureInvoiceRow(
  admin: ReturnType<typeof createAdminClient>,
  teacherId: string,
  billingMonth: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await admin.from('invoices').insert({
      teacher_id: teacherId,
      billing_month: billingMonth,
      status: 'pending',
      reference_number: buildInvoiceReference(billingMonth),
    })

    if (!error) return true

    if (error.code === '23505') {
      const { data: nowExists } = await admin
        .from('invoices')
        .select('id')
        .eq('teacher_id', teacherId)
        .eq('billing_month', billingMonth)
        .maybeSingle()
      if (nowExists) return true
      // reference_number collision — the month row is still missing, retry.
      continue
    }

    console.error('recomputeInvoiceAmountsForTeacher: invoice insert failed', {
      teacher_id: teacherId,
      billing_month: billingMonth,
      error,
    })
    return false
  }

  console.error('recomputeInvoiceAmountsForTeacher: invoice insert exhausted 5 reference-number collisions', {
    teacher_id: teacherId,
    billing_month: billingMonth,
  })
  return false
}

// Recomputes invoices.amount_eur for one teacher.
//
// - Skips invoices with status='paid' (paid amounts freeze as a historical figure).
// - Skips rows whose computed value already matches the stored value (no-op write).
// - missing profile -> no-op. Rate <= 0 still recomputes: amounts are
//   driven by per-lesson snapshots, live rate is fallback only (NEW268 D1).
//
// Creates missing invoice rows. Any month whose billable sum rounds above zero
// but has no invoice row gets a 'pending' row inserted BEFORE the update pass,
// then the amount lands in the same call. Without this, the only INSERT in the
// codebase was the teacher's own /billing page load (current month only), so a
// teacher who never opened /billing in a given month had no row for it and
// admin billing silently under-reported what was owed — permanently, once the
// month passed. Zero-sum months get no row; existing rows (incl. 'paid') are
// never re-inserted.
//
// Month-boundary reschedules: lessons are re-bucketed by their current
// scheduled_at in the teacher's timezone, so a class moved from April → May
// drains the April bucket and lands in May. Both invoice rows are then
// reconciled in the same pass — the destination row is created here if the
// month didn't have one.
//
// TEST ACCOUNTS: this function deliberately does NOT check profiles.is_test.
// Called with an explicit teacher id it must keep working for a test teacher —
// the teacher portal legitimately recomputes the test account's own invoice when
// signed in as her, and every caller here passes a specific id. The is_test skip
// belongs to recomputeInvoiceAmountsForAllTeachers below, the only caller that
// fans out across teachers nobody named.
export async function recomputeInvoiceAmountsForTeacher(teacherId: string): Promise<void> {
  const admin = createAdminClient()

  const { data: teacher } = await admin
    .from('profiles')
    .select('id, hourly_rate, timezone')
    .eq('id', teacherId)
    .single()

  const hourlyRate = Number(teacher?.hourly_rate ?? 0)
  if (!teacher) return

  if (!teacher.timezone) {
    throw new Error(`TIMEZONE_MISSING:${teacherId}`)
  }
  const tz = teacher.timezone

  const { data: invoices, error: invoicesError } = await admin
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('teacher_id', teacherId)

  // A failed fetch is not "this teacher has no invoices" — bailing out beats
  // treating every month as missing and firing inserts against rows that exist.
  if (invoicesError) {
    console.error('recomputeInvoiceAmountsForTeacher: invoice fetch failed', {
      teacher_id: teacherId,
      error: invoicesError,
    })
    return
  }

  const { data: lessons } = await admin
    .from('lessons')
    .select('id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by')
    .eq('teacher_id', teacherId)
    .in('status', MONTH_BILLING_PREFILTER_STATUSES)

  // Per-lesson pay rate from lesson_rate_snapshots (admin client — deny-all RLS).
  // `hourlyRate` above is the teacher's live rate, used only as the fallback.
  const rateMap = await fetchLessonRateMap(admin, (lessons ?? []).map(l => l.id))

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
      hourlyRate: resolveLessonRate(rateMap, lesson.id, hourlyRate),
      durationMinutes: lesson.duration_minutes,
      cancelledBy: lesson.cancelled_by ?? null,
      rescheduledBy: lesson.rescheduled_by ?? null,
    })
    if (bill.billableToTeacher) {
      sumByMonth[key] = (sumByMonth[key] ?? 0) + bill.amount
    }
  }

  let invoiceRows: InvoiceRow[] = (invoices ?? []) as InvoiceRow[]

  // --- Insert pass: months with money but no row. ---
  // Keys are getMonthKeyInTz output ('YYYY-MM-01'), the same shape stored in
  // invoices.billing_month (a date column) and the same shape the update pass
  // below already matches against.
  const existingMonths = new Set(invoiceRows.map(inv => inv.billing_month))
  const monthsToCreate = Object.keys(sumByMonth).filter(key => {
    if (existingMonths.has(key)) return false
    return Math.round((sumByMonth[key] ?? 0) * 100) / 100 > 0
  })

  let created = false
  for (const month of monthsToCreate) {
    // Sequential, not Promise.all: a teacher backfills at most a handful of
    // months and recomputeInvoiceAmountsForAllTeachers already runs 5 teachers
    // concurrently.
    if (await ensureInvoiceRow(admin, teacherId, month)) created = true
  }

  // Re-fetch so the update pass covers the rows just created (and any a
  // concurrent request created underneath us).
  if (created) {
    const { data: refreshed, error: refreshError } = await admin
      .from('invoices')
      .select(INVOICE_COLUMNS)
      .eq('teacher_id', teacherId)

    if (refreshError || !refreshed) {
      // Rows exist but stay at their default amount until the next recompute.
      console.error('recomputeInvoiceAmountsForTeacher: invoice re-fetch after insert failed; new rows keep their default amount until the next recompute', {
        teacher_id: teacherId,
        error: refreshError,
      })
    } else {
      invoiceRows = refreshed as InvoiceRow[]
    }
  }

  if (invoiceRows.length === 0) return

  const updates = invoiceRows
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
    .select('id, is_test')
    .in('role', ['teacher', 'admin'])

  // Test teachers (profiles.is_test) get no invoice recompute from this fan-out:
  // nobody asked for them by name here. recomputeInvoiceAmountsForTeacher above is
  // deliberately NOT gated, so an explicit id still recomputes a test account.
  const ids = (teachers || []).filter(t => !t.is_test).map(t => t.id)

  const BATCH = 5
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const results = await Promise.allSettled(slice.map(id => recomputeInvoiceAmountsForTeacher(id)))
    results.forEach((r, idx) => {
      if (r.status === 'rejected') {
        console.error('recomputeInvoiceAmountsForAllTeachers: teacher recompute failed', { teacher_id: slice[idx], error: r.reason })
      }
    })
  }
}
