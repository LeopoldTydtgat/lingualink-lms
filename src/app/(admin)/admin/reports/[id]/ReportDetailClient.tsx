'use client';

// src/app/(admin)/admin/reports/[id]/ReportDetailClient.tsx

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  computeOverallLevel,
  hasUsableLevelData,
  type LevelData,
} from '@/lib/levels/levelData';
import LevelTracks from '@/components/shared/LevelTracks';

interface Report {
  id:                 string;
  lesson_id:          string;
  status:             string;
  did_class_happen:   boolean | null;
  no_show_type:       string | null;
  feedback_text:      string | null;
  additional_details: string | null;
  level_data:         LevelData | null;
  flagged_at:         string | null;
  completed_at:       string | null;
  deadline_at:        string | null;
  created_at:         string;
  impersonation_note: string | null;
  lesson: {
    id:               string;
    scheduled_at:     string;
    duration_minutes: number;
    status:           string;
    teams_join_url:   string | null;
  } | null;
  teacher: { id: string; full_name: string; photo_url?: string | null; } | null;
  student: { id: string; full_name: string; photo_url?: string | null; } | null;
}

interface Assignment {
  id:          string;
  assigned_at: string;
  sheet:       { id: string; title: string; category: string | null; level: string | null; } | null;
}

interface Props {
  report:      Report;
  assignments: Assignment[];
  // The logged-in admin's IANA timezone (server page falls back to 'UTC').
  adminTimezone: string;
}

// Times are stored in UTC. We format each in the admin's own timezone via Intl with an
// explicit timeZone. That is deterministic: the same output on server and client, so it is
// safe in this client component under SSR (no hydration mismatch). Without the timeZone the
// server rendered in the host's zone and the browser re-rendered in the viewer's, which both
// mismatched on hydration and showed the wrong wall-clock time.
function formatDateTime(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

// Prefer the server's error string, fall back to the status code when the body is not JSON.
async function errorText(res: Response, fallback: string) {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {
    // non-JSON error body; keep the status message
  }
  return `${fallback} (${res.status}).`;
}

// Result of the advisory "is this month's invoice already paid?" lookup that runs
// while the reopen-confirmation modal is open.
//   loading    - request in flight (render nothing; never a reason to wait)
//   paid       - the month's invoice is status='paid'
//   clear      - positively established as not paid
//   unverified - the answer could not be established; NEVER shown as "not paid"
type InvoiceCheck = 'loading' | 'paid' | 'clear' | 'unverified';

export default function ReportDetailClient({ report, assignments, adminTimezone }: Props) {
  const router = useRouter();
  const [reopening,   setReopening]   = useState(false);
  const [reopenError, setReopenError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  // Advisory only. The recompute that follows a reopen skips invoices already
  // marked paid, so a pay change on a paid month has to be settled by hand - the
  // admin is told that here, before confirming. This check must NEVER disable or
  // delay the confirm button, and a failed lookup shows "could not verify"
  // instead of a false all-clear.
  const [invoiceCheck, setInvoiceCheck] = useState<InvoiceCheck>('loading');
  // Monotonic token: bumped on every open AND every close, so a slow response
  // can never land in a modal that has since been closed or reopened.
  const invoiceCheckTokenRef = useRef(0);

  function startInvoiceCheck() {
    const token = ++invoiceCheckTokenRef.current;
    setInvoiceCheck('loading');
    fetch(`/api/admin/reports/${report.id}/invoice-status`)
      .then(async (res) => {
        if (token !== invoiceCheckTokenRef.current) return;
        if (!res.ok) { setInvoiceCheck('unverified'); return; }
        const body = await res.json();
        if (token !== invoiceCheckTokenRef.current) return;
        // checked:false means the server could not establish the answer.
        if (!body?.checked) { setInvoiceCheck('unverified'); return; }
        setInvoiceCheck(body.invoicePaid === true ? 'paid' : 'clear');
      })
      .catch(() => {
        // Network failure, or a body that is not JSON.
        if (token !== invoiceCheckTokenRef.current) return;
        setInvoiceCheck('unverified');
      });
  }

  function openConfirm() {
    setReopenError('');
    setShowConfirm(true);
    startInvoiceCheck();
  }

  // Resets to 'loading' so a reopened modal re-fetches rather than flashing the
  // previous answer, and invalidates any in-flight response.
  function closeConfirm() {
    invoiceCheckTokenRef.current++;
    setInvoiceCheck('loading');
    setShowConfirm(false);
  }

  async function handleReopen() {
    setReopenError('');
    setReopening(true);
    try {
      const res = await fetch(`/api/admin/reports/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' }),
      });
      if (!res.ok) {
        // Stay on the page - the report was not reopened and the admin can retry.
        setReopenError(await errorText(res, 'Reopen failed'));
        return;
      }
      closeConfirm();
      toast.success('Report reopened and returned to the teacher.');
      router.push('/admin/reports');
      router.refresh();
    } catch {
      setReopenError('Network error - the report was not reopened. Please try again.');
    } finally {
      setReopening(false);
    }
  }

  // Shared predicate. This used to accept any non-null value, so a row of empty
  // strings rendered here as a collapsed, all-zero assessment while the two
  // student surfaces showed their empty state for the same report.
  const hasLevelData = hasUsableLevelData(report.level_data);

  // Derived headline: the equal-weight average of all seven skills, or null
  // when the assessment is partial. Same function the teacher report form and
  // the teacher student-detail page use, so no two surfaces can show a
  // different overall level for the same report.
  const levelOverall = computeOverallLevel(report.level_data);

  return (
    <div className="p-6">
      <Link href="/admin/reports" prefetch={false} className="text-sm hover:underline mb-5 inline-flex items-center gap-1" style={{ color: '#FF8303' }}>← Back to Reports</Link>

      <div className="flex items-center justify-between mt-3 mb-6">
        <h1 className="text-xl font-bold text-gray-900">Report Detail</h1>
        <div className="flex items-center gap-3">
          {report.status === 'flagged'   && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#FFEEE6', color: '#FD5602' }}>Flagged</span>}
          {report.status === 'completed' && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#DCFCE7', color: '#15803D' }}>Completed</span>}
          {report.status === 'pending'   && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}>Pending</span>}
          {report.status === 'reopened'  && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}>Reopened</span>}
          {(report.status === 'flagged' || report.status === 'completed') && (
            <button onClick={openConfirm} className="text-sm font-medium text-white px-4 py-2 rounded-lg" style={{ backgroundColor: '#FF8303' }}>Reopen Report</button>
          )}
        </div>
      </div>

      {reopenError && !showConfirm && (
        <div className="text-sm rounded-lg p-3 mb-5" style={{ backgroundColor: '#FEE2E2', color: '#991B1B' }}>
          <strong>Report not reopened:</strong> {reopenError}
        </div>
      )}

      {report.impersonation_note && (
        <div className="text-sm rounded-lg p-3 mb-5" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
          <strong>Admin note:</strong> {report.impersonation_note}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card-elevated p-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Class Info</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Date &amp; Time</dt>
              <dd className="text-gray-800 font-medium">{report.lesson?.scheduled_at ? formatDateTime(report.lesson.scheduled_at, adminTimezone) : '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Duration</dt>
              <dd className="text-gray-800">{report.lesson?.duration_minutes ? `${report.lesson.duration_minutes} minutes` : '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Class took place?</dt>
              <dd>
                {report.did_class_happen === true  && <span className="text-green-700 font-medium">Yes</span>}
                {report.did_class_happen === false && <span className="text-red-600 font-medium">No — {report.no_show_type === 'student' ? 'Student no-show' : report.no_show_type === 'teacher' ? 'Teacher no-show' : 'Not specified'}</span>}
                {report.did_class_happen === null  && <span className="text-gray-400">—</span>}
              </dd>
            </div>
            {report.completed_at && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Report submitted</dt>
                <dd className="text-gray-800">{formatDateTime(report.completed_at, adminTimezone)}</dd>
              </div>
            )}
            {report.flagged_at && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Flagged at</dt>
                <dd style={{ color: '#DC2626' }}>{formatDateTime(report.flagged_at, adminTimezone)}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="card-elevated p-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Participants</h2>
          <div className="space-y-4">
            {report.teacher && (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-medium shrink-0" style={{ backgroundColor: '#FF8303' }}>
                  {report.teacher.full_name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">{report.teacher.full_name}</p>
                  <p className="text-xs text-gray-400">Teacher</p>
                </div>
              </div>
            )}
            {report.student && (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-sm font-medium shrink-0">
                  {report.student.full_name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">{report.student.full_name}</p>
                  <p className="text-xs text-gray-400">Student</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {report.feedback_text && (
        <div className="card-elevated p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Class Recap, Feedback &amp; Next Steps</h2>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{report.feedback_text}</p>
        </div>
      )}

      {report.additional_details && (
        <div className="card-elevated p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Additional Details</h2>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{report.additional_details}</p>
        </div>
      )}

      {hasLevelData && (
        <div className="card-elevated p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Student Level Assessment</h2>
          {levelOverall && (
            <div className="flex flex-col items-center" style={{ marginBottom: '20px' }}>
              <p
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#9ca3af',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  margin: 0,
                }}
              >
                Overall Level
              </p>
              <p style={{ fontSize: '40px', fontWeight: 700, color: '#FF8303', lineHeight: 1.1, margin: '4px 0 0 0' }}>
                {levelOverall}
              </p>
            </div>
          )}
          <LevelTracks levelData={report.level_data} />
        </div>
      )}

      {assignments.length > 0 && (
        <div className="card-elevated p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Assigned for Next Time</h2>
          <div className="space-y-2">
            {assignments.map((a) => (
              <div key={a.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-800">{a.sheet?.title ?? 'Untitled sheet'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{[a.sheet?.category, a.sheet?.level].filter(Boolean).join(' ' + String.fromCharCode(183) + ' ')}</p>
                </div>
                <span className="text-xs text-gray-400">{a.assigned_at ? new Intl.DateTimeFormat('en-GB', { timeZone: adminTimezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(a.assigned_at)) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Reopen this report?</h3>
            <p className="text-sm text-gray-600 mb-5">The report will be returned to the teacher to submit again. If the corrected report changes the class outcome, the student&apos;s hours and the teacher&apos;s pay will adjust automatically.</p>
            {reopenError && (
              <p className="text-sm mb-4" style={{ color: '#DC2626' }}>{reopenError}</p>
            )}
            {invoiceCheck === 'paid' && (
              <div className="text-sm rounded-lg p-3 mb-4" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
                This month&apos;s invoice is already marked paid - any pay change from this correction must be settled manually.
              </div>
            )}
            {invoiceCheck === 'unverified' && (
              <p className="text-xs text-gray-500 mb-4">Could not verify whether this month&apos;s invoice is already paid.</p>
            )}
            <div className="flex gap-3 justify-end">
              <button onClick={closeConfirm} className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50" disabled={reopening}>Cancel</button>
              <button onClick={handleReopen} disabled={reopening} className="px-4 py-2 text-sm text-white rounded-lg font-medium" style={{ backgroundColor: '#FF8303' }}>
                {reopening ? 'Reopening…' : reopenError ? 'Try again' : 'Reopen Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
