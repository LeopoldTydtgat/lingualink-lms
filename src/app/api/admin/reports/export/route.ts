// src/app/api/admin/reports/export/route.ts

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { getExportTimezone, tzLabel, formatInstantInTz, zonedDayRangeToUtcBounds } from '@/lib/exportTime';
import { NextRequest, NextResponse } from 'next/server';
import { buildExportWorkbook, type ExportColumn } from '@/lib/exports/workbook';
import { buildFilterLines } from '@/lib/exports/filterLines';
import { getCancellationLabel } from '@/lib/lessons/statusLabel';
import { getBillability } from '@/lib/billing/billability';
import { fetchLessonRateMap, resolveLessonRate } from '@/lib/billing/lessonRates';

export const runtime = 'nodejs';

// Display formatters are built PER REQUEST inside GET() from the settings-driven
// export timezone (was a hardcoded Africa/Johannesburg/SAST). Format style is
// unchanged (en-GB, month:'short', hour12:false); only the zone + header labels
// are now dynamic. NEW273: the calendar-day QUERY BOUNDS below now resolve in
// that SAME settings-driven zone (were hardcoded +02:00). Scoping and display
// therefore agree — previously a non-SAST export zone scoped rows by SAST days
// while rendering them in another zone, so boundary-day rows (each carrying an
// Amount Owed to Teacher) could sit outside, or drop out of, the requested
// window. At the SAST default the row set is unchanged.
//
// The three billing-derived columns — Teacher Billable, Amount Owed to Teacher,
// Billable Under Policy — derive from getBillability in
// src/lib/billing/billability.ts (the same single source of truth the invoice
// recompute uses), replacing the previous ad-hoc outcome-string and
// window-arithmetic rules. cancelled_by / rescheduled_by are threaded into the
// call, so the reschedule-leg zeroing and cancellation-actor precedence now live
// INSIDE getBillability (no local reschedule-leg branch here). 'scheduled' rows
// are the only special case; see the derive block below.
//
// The teacher pay RATE feeding those columns resolves snapshot-first: the
// per-lesson lesson_rate_snapshots rate when one exists, otherwise the teacher's
// live profiles.hourly_rate (NEW268 Decision A), via the shared
// fetchLessonRateMap / resolveLessonRate helpers in
// src/lib/billing/lessonRates.ts — the exact same resolution the invoice
// recompute and every other billing export use.

// Flatten a Supabase nested join result to its first element (project rule).
function firstOf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v.length ? v[0] : null;
  return (v ?? null) as T | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    // --- Auth gate — shared canonical rule (same as /api/admin/reports) ---
    const supabase = await createClient();

    const user = await requireAdmin();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // --- Params ---
    const { searchParams } = new URL(request.url);
    const dateFrom      = searchParams.get('date_from');
    const dateTo        = searchParams.get('date_to');
    const teacherId     = searchParams.get('teacher_id') || null;
    const studentId     = searchParams.get('student_id') || null;
    const outcomeFilter = searchParams.get('status') || null;       // Class Outcome label, filtered in JS
    const clientType    = searchParams.get('client_type') || null;  // 'private' | 'company' | null

    if (!dateFrom || !dateTo || !DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
      return NextResponse.json(
        { error: 'date_from and date_to are required in yyyy-mm-dd format' },
        { status: 400 }
      );
    }

    // --- Data queries: service-role admin client (all three snapshot/log tables are admin-only) ---
    const admin = createAdminClient();

    // Resolve the settings-driven export timezone once and build the display
    // formatters in that zone. Format style matches the previous SAST formatters
    // exactly (en-GB, month:'short', hour12:false); only the timezone and the
    // column-header labels are now dynamic.
    const exportTz = await getExportTimezone();
    const exportTzLabel = tzLabel(exportTz);
    const dateFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: exportTz,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const timeFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: exportTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const fmtDate = (iso: string | null | undefined): string => (iso ? dateFmt.format(new Date(iso)) : '');
    const fmtTime = (iso: string | null | undefined): string => (iso ? timeFmt.format(new Date(iso)) : '');
    const fmtDateTime = (iso: string | null | undefined): string => {
      if (!iso) return '';
      const d = new Date(iso);
      return `${dateFmt.format(d)}, ${timeFmt.format(d)}`;
    };

    // Calendar-day bounds resolved in the export timezone (NEW273). Half-open:
    // [local 00:00 on dateFrom, local 00:00 on the day after dateTo) — both ends
    // are full local days, with no 23:59:59 sub-second gap at the top.
    const { gteIso, ltIso } = zonedDayRangeToUtcBounds(dateFrom, dateTo, exportTz);

    let query = admin
      .from('lessons')
      .select(`
        id, scheduled_at, duration_minutes, status, cancelled_at, cancelled_by, rescheduled_by, hours_refunded, teacher_id, student_id,
        profiles!lessons_teacher_id_fkey ( full_name, hourly_rate ),
        reports ( status, completed_at, feedback_text, did_class_happen, no_show_type, flagged_at ),
        lesson_join_clicks ( user_type, clicked_at )
      `)
      .gte('scheduled_at', gteIso)
      .lt('scheduled_at', ltIso)
      .order('scheduled_at', { ascending: true });

    if (teacherId) query = query.eq('teacher_id', teacherId);
    if (studentId) query = query.eq('student_id', studentId);

    const { data: lessonsData, error: lessonsError } = await query;
    if (lessonsError) {
      console.error('Reports export lessons error:', lessonsError);
      return NextResponse.json({ error: lessonsError.message }, { status: 500 });
    }

    const lessons = lessonsData ?? [];

    // Per-lesson pay rate from lesson_rate_snapshots (admin client — deny-all RLS).
    // The teacher's live profiles.hourly_rate is used only as the fallback (NEW268 D1).
    const rateMap = await fetchLessonRateMap(admin, lessons.map((l) => l.id as string));

    // Students by id.
    const studentIds = [...new Set(lessons.map((l) => l.student_id).filter(Boolean) as string[])];
    const { data: studentsData } = studentIds.length
      ? await admin
          .from('students')
          .select('id, full_name, company_id, is_private, cancellation_policy')
          .in('id', studentIds)
      : { data: [] };
    const students = studentsData ?? [];
    const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));

    // Companies by id.
    const companyIds = [...new Set(students.map((s) => s.company_id).filter(Boolean) as string[])];
    const { data: companiesData } = companyIds.length
      ? await admin.from('companies').select('id, name, cancellation_policy').in('id', companyIds)
      : { data: [] };
    const companyMap = Object.fromEntries((companiesData ?? []).map((c) => [c.id, c]));

    // Reviews: a matching student_reviews row (class_id === lesson id) means a review was submitted.
    const lessonIds = lessons.map((l) => l.id as string);
    const { data: reviewsData } = lessonIds.length
      ? await admin.from('student_reviews').select('class_id, submitted_at').in('class_id', lessonIds)
      : { data: [] };
    const reviewedLessonIds = new Set((reviewsData ?? []).map((r) => r.class_id));

    // --- Derive one row object per lesson ---
    const derived = lessons.map((l) => {
      const teacher  = firstOf(l.profiles);
      const report   = firstOf(l.reports);
      const student  = l.student_id ? studentMap[l.student_id] ?? null : null;
      const company  = student?.company_id ? companyMap[student.company_id] ?? null : null;
      const companyName: string | null = company ? company.name : null;

      // Client type: company name when resolvable; a B2B row (is_private === false) with no
      // resolvable company is surfaced as 'Company (unassigned)' and bucketed as company, never
      // silently as Private (billing reconciliation - inconsistent data must be visible).
      let clientTypeLabel: string;
      let isCompanyBucket: boolean;
      if (companyName) {
        clientTypeLabel = companyName;
        isCompanyBucket = true;
      } else if (student?.is_private === false) {
        clientTypeLabel = 'Company (unassigned)';
        isCompanyBucket = true;
      } else {
        clientTypeLabel = 'Private';
        isCompanyBucket = false;
      }

      // Outcome from lesson status + cancellation attribution. Cancellation-family
      // wording (incl. reschedule-leg attribution) comes from the shared helper;
      // the non-cancel labels below are export-specific and stay verbatim.
      let outcome: string;
      const st = l.status as string;
      const cancelOutcome = getCancellationLabel(
        { status: st, cancelled_by: l.cancelled_by, rescheduled_by: l.rescheduled_by },
        'admin'
      );
      if (cancelOutcome !== null) outcome = cancelOutcome;
      else if (st === 'completed') outcome = 'Taken';
      else if (st === 'student_no_show') outcome = 'Student No-Show';
      else if (st === 'teacher_no_show') outcome = 'Teacher No-Show';
      else if (st === 'scheduled') outcome = 'Scheduled';
      else outcome = st;

      // Raw outcome label kept for the JS-side outcome filter below, which
      // compares against the dropdown values exactly. The displayed outcome
      // may carry a refund suffix; the filter must not see it.
      const outcomeRaw = outcome;
      // Refund outcome belongs on the outcome cell so it reads like the old
      // LearnCube Past Classes export. Only TRUE cancellations carry it.
      // Reschedule legs (rescheduled_by set) move the hours to the new booking
      // and refund nothing, so they keep the plain "Rescheduled by ..." label.
      // hours_refunded is nullable: only literal true reads as refunded.
      // Display only - getBillability below does not read hours_refunded.
      const isRescheduleLeg = l.rescheduled_by === 'student' || l.rescheduled_by === 'admin';
      if (cancelOutcome !== null && !isRescheduleLeg) {
        outcome = `${outcome} - ${l.hours_refunded === true ? 'refunded' : 'not refunded'}`;
      }

      // Cancellation window: absolute-instant gap between schedule and cancellation (tz-independent).
      let cancellationWindow = '';
      let windowHours: number | null = null;
      if (l.cancelled_at) {
        windowHours = (new Date(l.scheduled_at).getTime() - new Date(l.cancelled_at).getTime()) / 3600000;
        if (windowHours < 24) cancellationWindow = '<24hr';
        else if (windowHours < 48) cancellationWindow = '24-48hr';
        else cancellationWindow = '>48hr';
      }

      // Policy applied: student, else company, else 24hr default.
      const policyApplied: string =
        student?.cancellation_policy || company?.cancellation_policy || '24hr';

      // Rate: per-lesson snapshot, else the teacher's live profiles.hourly_rate
      // (NEW268 Decision A — same resolution as the invoice recompute and all
      // other exports, via the shared resolveLessonRate helper).
      const rate = resolveLessonRate(rateMap, l.id as string, Number(teacher?.hourly_rate ?? 0));

      // Teacher Billable / Amount Owed / Billable Under Policy all derive from
      // getBillability (single source of truth, shared with the invoice
      // recompute). Two legs:
      //  A. 'scheduled' — outcome not settled yet; all three stay blank/null.
      //  B. Everything else — one getBillability call with cancelled_by /
      //     rescheduled_by threaded in, so reschedule legs (cancel-family
      //     status + rescheduled_by student/admin) and the cancellation-actor
      //     precedence are handled INSIDE getBillability: a reschedule leg
      //     comes back billableToTeacher=false, billable48hr=false — nothing
      //     owed anywhere. Teacher pay is ALWAYS the 24hr rule inside
      //     getBillability; billable48hr carries the 48hr company-policy leg
      //     for Billable Under Policy.
      let teacherBillable = '';
      let amountOwed: number | null = null;
      let billableUnderPolicy = '';
      if (st !== 'scheduled') {
        const bill = getBillability({
          status: l.status,
          scheduledAt: l.scheduled_at,
          cancelledAt: l.cancelled_at ?? null,
          cancellationPolicy: policyApplied === '48hr' ? '48hr' : '24hr',
          hourlyRate: rate,
          durationMinutes: l.duration_minutes,
          cancelledBy: l.cancelled_by ?? null,
          rescheduledBy: l.rescheduled_by ?? null,
        });
        teacherBillable = bill.billableToTeacher ? 'Yes' : 'No';
        amountOwed = bill.billableToTeacher ? bill.amount : 0;
        if (l.cancelled_at) {
          billableUnderPolicy = bill.billableToTeacher || bill.billable48hr ? 'Yes' : 'No';
        }
      }

      // Earliest join click per user_type.
      const clicks = Array.isArray(l.lesson_join_clicks)
        ? l.lesson_join_clicks
        : l.lesson_join_clicks
        ? [l.lesson_join_clicks]
        : [];
      const earliest = (userType: string): string | null => {
        const times = clicks
          .filter((c) => c.user_type === userType)
          .map((c) => c.clicked_at as string)
          .filter(Boolean);
        if (!times.length) return null;
        return times.reduce((min: string, t: string) =>
          new Date(t).getTime() < new Date(min).getTime() ? t : min
        );
      };
      const teacherJoinedAt = earliest('teacher');
      const studentJoinedAt = earliest('student');

      return {
        classDate: fmtDate(l.scheduled_at),
        classTime: fmtTime(l.scheduled_at),
        duration: l.duration_minutes,
        teacher: teacher?.full_name ?? '',
        student: student?.full_name ?? '',
        clientType: clientTypeLabel,
        outcome,
        _outcomeRaw: outcomeRaw,
        reportSubmitted: report?.status === 'completed' ? 'Yes' : 'No',
        reportSubmittedAt: fmtDateTime(report?.completed_at),
        flagged: report?.status === 'flagged' ? 'Yes' : 'No',
        feedback: report?.feedback_text ?? '',
        teacherJoinedAt: fmtDateTime(teacherJoinedAt),
        studentJoinedAt: fmtDateTime(studentJoinedAt),
        reviewSubmitted: reviewedLessonIds.has(l.id) ? 'Yes' : 'No',
        teacherBillable,
        hourlyRate: rate,
        amountOwed,
        cancelledAt: fmtDateTime(l.cancelled_at),
        // RAW stored value, not passed through getCancellationLabel - proves what was stored.
        cancelledBy: l.cancelled_by ?? '',
        hoursRefunded: l.hours_refunded === true ? 'Yes' : 'No',
        cancellationWindow,
        policyApplied,
        billableUnderPolicy,
        classId: l.id,
        _reportStatus: (report?.status ?? null) as string | null,
        _isCompany: isCompanyBucket,
      };
    });

    // --- JS-side filters: outcome + client type ---
    let rows = derived;
    if (outcomeFilter) rows = rows.filter((r) => r._outcomeRaw === outcomeFilter);
    if (clientType === 'company') rows = rows.filter((r) => r._isCompany);
    else if (clientType === 'private') rows = rows.filter((r) => !r._isCompany);

    // --- Workbook ---
    // Layout (title block, branded header row, banding, freeze panes, autofilter,
    // print setup) comes from the shared writer in @/lib/exports/workbook — the
    // same one the six /api/admin/exports/[type] sheets use. The columns, their
    // order, headers and widths, and the row set are unchanged from the
    // hand-rolled ExcelJS version this replaced.
    //
    // No totals row on purpose: this sheet has no Currency column, so a total
    // over "Amount Owed to Teacher" would silently sum across currencies the
    // moment any teacher is non-EUR.
    const columns: ExportColumn[] = [
      { header: `Class Date (${exportTzLabel})`, key: 'classDate', width: 16 },
      { header: `Class Time (${exportTzLabel})`, key: 'classTime', width: 12 },
      { header: 'Duration (mins)', key: 'duration', width: 14, format: 'integer' },
      { header: 'Teacher', key: 'teacher', width: 22 },
      { header: 'Student', key: 'student', width: 22 },
      { header: 'Client Type', key: 'clientType', width: 20 },
      { header: 'Class Outcome', key: 'outcome', width: 20 },
      { header: `Cancelled At (${exportTzLabel})`, key: 'cancelledAt', width: 24 },
      { header: 'Cancelled By', key: 'cancelledBy', width: 14 },
      { header: 'Hours Refunded', key: 'hoursRefunded', width: 16 },
      { header: 'Report Submitted', key: 'reportSubmitted', width: 16 },
      { header: `Report Submitted At (${exportTzLabel})`, key: 'reportSubmittedAt', width: 24 },
      { header: 'Flagged', key: 'flagged', width: 10 },
      { header: 'Feedback / Recap', key: 'feedback', width: 60 },
      { header: `Teacher Joined At (${exportTzLabel})`, key: 'teacherJoinedAt', width: 24 },
      { header: `Student Joined At (${exportTzLabel})`, key: 'studentJoinedAt', width: 24 },
      { header: 'Review Submitted', key: 'reviewSubmitted', width: 16 },
      { header: 'Teacher Billable', key: 'teacherBillable', width: 16 },
      { header: 'Hourly Rate', key: 'hourlyRate', width: 12, format: 'decimal2' },
      { header: 'Amount Owed to Teacher', key: 'amountOwed', width: 22, format: 'decimal2' },
      { header: 'Cancellation Window', key: 'cancellationWindow', width: 18 },
      { header: 'Cancellation Policy Applied', key: 'policyApplied', width: 24 },
      { header: 'Billable Under Policy', key: 'billableUnderPolicy', width: 18 },
      { header: 'Class ID', key: 'classId', width: 38 },
    ];

    // Applied-filter lines for the workbook header block. The shared helper
    // resolves the teacher/student ids to names through the cookie client; the
    // two JS-side filters below have no id to resolve, so they are appended here
    // rather than pushed into the shared helper. There is no company filter on
    // this export.
    const filterLines = await buildFilterLines(supabase, {
      fromDate: dateFrom,
      toDate: dateTo,
      teacherId,
      studentId,
      companyId: null,
    });
    if (outcomeFilter) filterLines.push(`Class Outcome: ${outcomeFilter}`);
    if (clientType) filterLines.push(`Client Type: ${clientType === 'company' ? 'Company' : 'Private'}`);

    const buffer = await buildExportWorkbook({
      title: 'Class Reports',
      columns,
      rows,
      generatedAtLabel: formatInstantInTz(new Date(), exportTz),
      timezoneLabel: exportTzLabel,
      filterLines,
      sheetName: 'Class Reports',
      freezeColumns: 2,
      // Whole-row fill matching the portal report colours. This is the signal the
      // writer's alternate-row banding cannot carry, so it overrides the banding
      // on flagged/pending rows only — every other row keeps the normal banding.
      rowFill: (row) =>
        row._reportStatus === 'flagged'
          ? 'FFFEF2F2'
          : row._reportStatus === 'pending'
          ? 'FFFFFBEB'
          : null,
    });

    // --- Audit log: this route writes the first export_log rows. ---
    // Isolated so a thrown/rejected insert can never turn an already-built download into a 500.
    try {
      const { error: logError } = await admin.from('export_log').insert({
        exported_by: user.id,
        date_from: dateFrom,
        date_to: dateTo,
        filters: {
          teacher_id: teacherId,
          student_id: studentId,
          status: outcomeFilter,
          client_type: clientType,
        },
        row_count: rows.length,
      });
      if (logError) console.error('Reports export log insert error:', logError);
    } catch (logErr) {
      console.error('Reports export log insert threw:', logErr);
    }

    // --- Return workbook ---
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':
          'attachment; filename="Lingualink_ClassReports_' + dateFrom + '_to_' + dateTo + '.xlsx"',
      },
    });
  } catch (err) {
    console.error('Reports export error:', err);
    return NextResponse.json({ error: 'Failed to generate export' }, { status: 500 });
  }
}
