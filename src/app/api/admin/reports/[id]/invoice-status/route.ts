// src/app/api/admin/reports/[id]/invoice-status/route.ts

import { createAdminClient } from '@/lib/supabase/admin';
import { getMonthKeyInTz } from '@/lib/billing/monthRange';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { NextRequest, NextResponse } from 'next/server';

// Advisory read for the admin reopen-confirmation modals: is the invoice that
// covers this report's lesson month ALREADY marked paid?
//
// Why it matters: recomputeInvoiceAmountsForTeacher deliberately skips
// status='paid' invoices (recomputeAmounts.ts:208 - paid amounts freeze as a
// historical figure). So when a reopened report changes the class outcome, the
// resulting pay delta silently never lands on a paid month; it has to be settled
// by hand. The admin needs that fact BEFORE confirming the reopen.
//
// Read-only. This route changes nothing and gates nothing - the reopen PATCH is
// untouched by it.
//
// FAIL-SAFE CONTRACT: every path that cannot positively establish the answer
// returns { checked: false }, never { invoicePaid: false }. A failed lookup is
// not evidence that the invoice is unpaid, and the modal renders "could not
// verify" for it rather than a false all-clear.
//
// The month is bucketed in the TEACHER's timezone, never the admin's - that is
// the recompute convention (recomputeAmounts.ts:148 keys sumByMonth off the
// teacher's tz), and bucketing here in any other zone could name a different
// month than the one the recompute would actually skip.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Service-role client, mirroring recomputeAmounts.ts: invoices and the
  // teacher's profile row are both outside an admin's RLS reach through the
  // cookie client, and this handler has already gated on requireAdmin above.
  const admin = createAdminClient();

  const { data: report, error: reportError } = await admin
    .from('reports')
    .select('id, teacher_id, lessons ( scheduled_at )')
    .eq('id', id)
    .maybeSingle();

  if (reportError) {
    console.error('Report invoice-status: report lookup failed', { report_id: id, error: reportError });
    return NextResponse.json({ checked: false });
  }
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });

  const lesson = Array.isArray(report.lessons) ? report.lessons[0] : report.lessons;

  // No lesson or no scheduled_at -> there is no month to bucket into.
  if (!lesson?.scheduled_at) return NextResponse.json({ checked: false });
  if (!report.teacher_id)    return NextResponse.json({ checked: false });

  const { data: teacher, error: teacherError } = await admin
    .from('profiles')
    .select('timezone')
    .eq('id', report.teacher_id)
    .maybeSingle();

  if (teacherError) {
    console.error('Report invoice-status: teacher profile lookup failed', { report_id: id, teacher_id: report.teacher_id, error: teacherError });
    return NextResponse.json({ checked: false });
  }
  // Missing profile or unset timezone: the month cannot be bucketed the way the
  // recompute would. Do not substitute a default zone - a guessed month could
  // report the wrong invoice.
  if (!teacher?.timezone) return NextResponse.json({ checked: false });

  const billingMonth = getMonthKeyInTz(new Date(lesson.scheduled_at), teacher.timezone);

  // UNIQUE (teacher_id, billing_month) on invoices (recomputeAmounts.ts:32),
  // so maybeSingle is exact: zero rows or one.
  const { data: invoice, error: invoiceError } = await admin
    .from('invoices')
    .select('status')
    .eq('teacher_id', report.teacher_id)
    .eq('billing_month', billingMonth)
    .maybeSingle();

  if (invoiceError) {
    console.error('Report invoice-status: invoice lookup failed', { report_id: id, teacher_id: report.teacher_id, billing_month: billingMonth, error: invoiceError });
    return NextResponse.json({ checked: false });
  }

  // No invoice row for the month is a genuine answer: nothing is paid yet.
  return NextResponse.json({
    checked: true,
    invoicePaid: invoice?.status === 'paid',
    billingMonth,
  });
}
