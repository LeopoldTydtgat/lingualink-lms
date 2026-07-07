'use client';

// src/app/(admin)/admin/reports/ReportsClient.tsx

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Teacher { id: string; full_name: string; photo_url?: string | null; }
interface Student { id: string; full_name: string; photo_url?: string | null; }
interface LessonSummary { id: string; scheduled_at: string; duration_minutes: number; status: string; }

interface Report {
  id:               string;
  lesson_id:        string;
  status:           'pending' | 'completed' | 'flagged';
  did_class_happen: boolean | null;
  no_show_type:     string | null;
  feedback_text:    string | null;
  flagged_at:       string | null;
  completed_at:     string | null;
  deadline_at:      string | null;
  created_at:       string;
  lesson:           LessonSummary | null;
  teacher:          Teacher | null;
  student:          Student | null;
}

interface TraceLesson {
  id:               string;
  scheduled_at:     string;
  duration_minutes: number;
  lesson_status:    string;
  teacher:          Teacher | null;
  student:          { id: string; full_name: string } | null;
  report:           { id: string; status: string; completed_at: string | null; flagged_at: string | null } | null;
}

interface Props {
  initialReports: Report[];
  teachers:       { id: string; full_name: string }[];
  students:       { id: string; full_name: string }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string) {
  const d   = new Date(iso);
  const day = d.getDate().toString().padStart(2, '0');
  const mon = d.toLocaleString('en-GB', { month: 'short' });
  const yr  = d.getFullYear();
  const hr  = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${day} ${mon} ${yr}, ${hr}:${min}`;
}

function hoursAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs  = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hrs > 0) return `${hrs}h ${mins}m ago`;
  return `${mins}m ago`;
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function ReportStatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    pending:   { bg: '#FEF3C7', text: '#92400E', label: 'Pending' },
    completed: { bg: '#DCFCE7', text: '#166534', label: 'Completed' },
    flagged:   { bg: '#FEE2E2', text: '#991B1B', label: 'Flagged' },
  };
  const s = styles[status] ?? { bg: '#F3F4F6', text: '#374151', label: status };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: s.bg, color: s.text }}>
      {s.label}
    </span>
  );
}

function LessonStatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    upcoming:  { bg: '#EFF6FF', text: '#1D4ED8', label: 'Upcoming' },
    completed: { bg: '#DCFCE7', text: '#166534', label: 'Completed' },
    cancelled: { bg: '#F3F4F6', text: '#374151', label: 'Cancelled' },
    cancelled_by_student: { bg: '#F3F4F6', text: '#374151', label: 'Cancelled by student' },
    cancelled_by_teacher: { bg: '#F3F4F6', text: '#374151', label: 'Cancelled by teacher' },
    no_show:   { bg: '#FEF3C7', text: '#92400E', label: 'No-Show' },
    flagged:   { bg: '#FEE2E2', text: '#991B1B', label: 'Flagged' },
  };
  const s = map[status] ?? { bg: '#F3F4F6', text: '#374151', label: status };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: s.bg, color: s.text }}>
      {s.label}
    </span>
  );
}

// ─── Reports List ─────────────────────────────────────────────────────────────

function ReportsList({ initialReports, teachers }: { initialReports: Report[]; teachers: { id: string; full_name: string }[] }) {
  const [reports,       setReports]       = useState<Report[]>(initialReports);
  const [loading,       setLoading]       = useState(false);
  const [reopenId,      setReopenId]      = useState<string | null>(null);
  const [reopenLoading, setReopenLoading] = useState(false);

  const [statusFilter,      setStatusFilter]      = useState('');
  const [teacherFilter,     setTeacherFilter]     = useState('');
  const [classStatusFilter, setClassStatusFilter] = useState('');
  const [dateFrom,          setDateFrom]          = useState('');
  const [dateTo,            setDateTo]            = useState('');

  const fetchReports = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter)      params.set('status',       statusFilter);
    if (teacherFilter)     params.set('teacher_id',   teacherFilter);
    if (classStatusFilter) params.set('class_status', classStatusFilter);
    if (dateFrom)          params.set('date_from',    dateFrom);
    if (dateTo)            params.set('date_to',      dateTo);
    try {
      const res  = await fetch(`/api/admin/reports?${params.toString()}`);
      const data = await res.json();
      setReports(data.reports ?? []);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, teacherFilter, classStatusFilter, dateFrom, dateTo]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  async function handleReopen(reportId: string) {
    setReopenLoading(true);
    try {
      await fetch(`/api/admin/reports/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' }),
      });
      await fetchReports();
    } finally {
      setReopenLoading(false);
      setReopenId(null);
    }
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="flagged">Flagged</option>
        </select>
        <select value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Teachers</option>
          {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
        </select>
        <select value={classStatusFilter} onChange={(e) => setClassStatusFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Class Types</option>
          <option value="taken">Class Taken</option>
          <option value="student_no_show">Student No-Show</option>
          <option value="teacher_no_show">Teacher No-Show</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
        <input type="date" value={dateTo}   onChange={(e) => setDateTo(e.target.value)}   className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
        {(statusFilter || teacherFilter || classStatusFilter || dateFrom || dateTo) && (
          <button onClick={() => { setStatusFilter(''); setTeacherFilter(''); setClassStatusFilter(''); setDateFrom(''); setDateTo(''); }} className="text-sm text-gray-500 hover:text-gray-700 underline">
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading reports…</div>
      ) : reports.length === 0 ? (
        <div className="text-sm text-gray-400 py-12 text-center">No reports match these filters.</div>
      ) : (
        <div className="overflow-x-auto thin-scroll">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Class Date</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Teacher</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Student</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Duration</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Report Status</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Deadline / Flag</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                let rowBg = '';
                if (r.status === 'flagged') rowBg = '#FEF2F2';
                if (r.status === 'pending') rowBg = '#FFFBEB';
                return (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors" style={rowBg ? { backgroundColor: rowBg } : {}}>
                    <td className="py-3 px-3 text-gray-700">{r.lesson?.scheduled_at ? formatDateTime(r.lesson.scheduled_at) : '—'}</td>
                    <td className="py-3 px-3 font-medium text-gray-800">{r.teacher?.full_name ?? '—'}</td>
                    <td className="py-3 px-3 text-gray-700">{r.student?.full_name ?? '—'}</td>
                    <td className="py-3 px-3 text-gray-600">{r.lesson?.duration_minutes ? `${r.lesson.duration_minutes} min` : '—'}</td>
                    <td className="py-3 px-3">
                      <div className="flex flex-col gap-1">
                        <ReportStatusBadge status={r.status} />
                        {r.did_class_happen === false && r.no_show_type && (
                          <span className="text-xs text-gray-400 capitalize">{r.no_show_type} no-show</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-gray-600 text-xs">
                      {r.status === 'flagged' && r.flagged_at
                        ? <span style={{ color: '#DC2626' }}>Flagged {hoursAgo(r.flagged_at)}</span>
                        : r.deadline_at ? formatDateTime(r.deadline_at) : '—'}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        {(r.status === 'completed' || r.status === 'flagged') && (
                          <Link href={`/admin/reports/${r.id}`} prefetch={false} className="text-xs font-medium hover:underline" style={{ color: '#FF8303' }}>View</Link>
                        )}
                        {r.status === 'flagged' && (
                          <button onClick={() => setReopenId(r.id)} className="text-xs font-medium text-white px-2 py-0.5 rounded" style={{ backgroundColor: '#FF8303' }}>Reopen</button>
                        )}
                        {r.status === 'pending' && (
                          <span className="text-xs text-gray-400 italic">Awaiting teacher</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {reopenId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Reopen flagged report?</h3>
            <p className="text-sm text-gray-600 mb-5">This will set the report back to pending and allow the teacher to submit it late.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setReopenId(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50" disabled={reopenLoading}>Cancel</button>
              <button onClick={() => handleReopen(reopenId)} disabled={reopenLoading} className="px-4 py-2 text-sm text-white rounded-lg font-medium" style={{ backgroundColor: '#FF8303' }}>
                {reopenLoading ? 'Reopening…' : 'Reopen Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Live Trace ───────────────────────────────────────────────────────────────

function LiveTrace() {
  const [lessons,      setLessons]      = useState<TraceLesson[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTrace = useCallback(async () => {
    try {
      const res  = await fetch('/api/admin/reports/live-trace');
      const data = await res.json();
      setLessons(data.lessons ?? []);
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrace();
    intervalRef.current = setInterval(fetchTrace, 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchTrace]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Last 50 classes — auto-refreshes every 30 seconds</p>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-gray-400">
              Updated {lastRefresh.getHours().toString().padStart(2,'0')}:{lastRefresh.getMinutes().toString().padStart(2,'0')}
            </span>
          )}
          <button onClick={fetchTrace} className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50">Refresh now</button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : lessons.length === 0 ? (
        <div className="text-sm text-gray-400 py-12 text-center">No classes found.</div>
      ) : (
        <div className="overflow-x-auto thin-scroll">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Date / Time</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Teacher</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Student</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Duration</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Class Status</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Report</th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody>
              {lessons.map((l) => (
                <tr key={l.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="py-3 px-3 text-gray-700 whitespace-nowrap">{formatDateTime(l.scheduled_at)}</td>
                  <td className="py-3 px-3 font-medium text-gray-800">{l.teacher?.full_name ?? '—'}</td>
                  <td className="py-3 px-3 text-gray-700">{l.student?.full_name ?? '—'}</td>
                  <td className="py-3 px-3 text-gray-600">{l.duration_minutes} min</td>
                  <td className="py-3 px-3"><LessonStatusBadge status={l.lesson_status} /></td>
                  <td className="py-3 px-3">
                    {l.report ? <ReportStatusBadge status={l.report.status} /> : <span className="text-xs text-gray-400 italic">No report</span>}
                  </td>
                  <td className="py-3 px-3">
                    {l.report?.id && (
                      <Link href={`/admin/reports/${l.report.id}`} prefetch={false} className="text-xs font-medium hover:underline" style={{ color: '#FF8303' }}>View report →</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function ReportsClient({ initialReports, teachers, students }: Props) {
  const [activeTab, setActiveTab] = useState<'list' | 'trace'>('list');

  const pendingCount = initialReports.filter((r) => r.status === 'pending').length;
  const flaggedCount = initialReports.filter((r) => r.status === 'flagged').length;

  const tabs = [
    { id: 'list',  label: 'All Reports' },
    { id: 'trace', label: 'Live Classes Trace' },
  ] as const;

  // -- Export modal state --
  const [showExport,       setShowExport]       = useState(false);
  const [exportPreset,     setExportPreset]     = useState<'today' | 'week' | 'month' | 'custom'>('month');
  const [exportFrom,       setExportFrom]       = useState('');
  const [exportTo,         setExportTo]         = useState('');
  const [exportTeacher,    setExportTeacher]    = useState('');
  const [exportStudent,    setExportStudent]    = useState('');
  const [exportOutcome,    setExportOutcome]    = useState('');
  const [exportClientType, setExportClientType] = useState('');
  const [generating,       setGenerating]       = useState(false);
  const [exportError,      setExportError]      = useState('');

  const pad2   = (n: number) => n.toString().padStart(2, '0');
  const ymdUTC = (dt: Date) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;

  // Preset ranges anchored to the SAST business calendar - never the admin's browser clock, and
  // never toISOString. The server interprets these yyyy-mm-dd bounds as SAST days, so the reference
  // "today" must be SAST too. UTC-noon arithmetic keeps the day/week/month math boundary-safe.
  function rangeForPreset(preset: 'today' | 'week' | 'month') {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const y = part('year');
    const m = part('month'); // 1-based
    const d = part('day');

    if (preset === 'today') {
      const t = new Date(Date.UTC(y, m - 1, d, 12));
      return { from: ymdUTC(t), to: ymdUTC(t) };
    }
    if (preset === 'week') {
      const base = new Date(Date.UTC(y, m - 1, d, 12));
      const dow = base.getUTCDay();                 // 0=Sun .. 6=Sat
      const toMonday = dow === 0 ? -6 : 1 - dow;    // week starts Monday
      const monday = new Date(Date.UTC(y, m - 1, d + toMonday, 12));
      const sunday = new Date(Date.UTC(y, m - 1, d + toMonday + 6, 12));
      return { from: ymdUTC(monday), to: ymdUTC(sunday) };
    }
    const first = new Date(Date.UTC(y, m - 1, 1, 12));
    const last  = new Date(Date.UTC(y, m, 0, 12));  // day 0 of next month = last day of this month
    return { from: ymdUTC(first), to: ymdUTC(last) };
  }

  function openExport() {
    const { from, to } = rangeForPreset('month');
    setExportPreset('month');
    setExportFrom(from);
    setExportTo(to);
    setExportTeacher('');
    setExportStudent('');
    setExportOutcome('');
    setExportClientType('');
    setExportError('');
    setGenerating(false);
    setShowExport(true);
  }

  function applyPreset(preset: 'today' | 'week' | 'month' | 'custom') {
    setExportPreset(preset);
    if (preset !== 'custom') {
      const { from, to } = rangeForPreset(preset);
      setExportFrom(from);
      setExportTo(to);
    }
  }

  async function generateExport() {
    if (!exportFrom || !exportTo) return;
    const params = new URLSearchParams();
    params.set('date_from', exportFrom);
    params.set('date_to', exportTo);
    if (exportTeacher)    params.set('teacher_id',  exportTeacher);
    if (exportStudent)    params.set('student_id',  exportStudent);
    if (exportOutcome)    params.set('status',      exportOutcome);
    if (exportClientType) params.set('client_type', exportClientType);
    setExportError('');
    setGenerating(true);
    try {
      const res = await fetch(`/api/admin/reports/export?${params.toString()}`);
      if (!res.ok) {
        let msg = `Export failed (${res.status}).`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          // non-JSON error body; keep the status message
        }
        setExportError(msg);
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `Lingualink_ClassReports_${exportFrom}_to_${exportTo}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setShowExport(false);
    } catch {
      setExportError('Network error - please try again.');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="p-6">
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-1">Class reports submitted by teachers. Flagged reports require your attention.</p>
          {(pendingCount > 0 || flaggedCount > 0) && (
            <div className="flex gap-3 mt-3">
              {pendingCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1 rounded-full" style={{ backgroundColor: '#FFFBEB', color: '#92400E' }}>
                  <span className="font-semibold">{pendingCount}</span> pending
                </span>
              )}
              {flaggedCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1 rounded-full" style={{ backgroundColor: '#FEF2F2', color: '#991B1B' }}>
                  <span className="font-semibold">{flaggedCount}</span> flagged — action required
                </span>
              )}
            </div>
          )}
        </div>

        <button
          onClick={openExport}
          className="text-sm font-medium px-4 py-2 rounded-lg text-white whitespace-nowrap"
          style={{ backgroundColor: '#FF8303' }}
        >
          Export Reports
        </button>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-5 py-3 text-sm font-medium border-b-2 transition-colors"
              style={activeTab === tab.id ? { borderBottomColor: '#FF8303', color: '#FF8303' } : { borderBottomColor: 'transparent', color: '#6B7280' }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-5">
        {activeTab === 'list'  && <ReportsList initialReports={initialReports} teachers={teachers} />}
        {activeTab === 'trace' && <LiveTrace />}
      </div>

      {showExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Export Reports</h3>

            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Date Range</label>
                <select
                  value={exportPreset}
                  onChange={(e) => applyPreset(e.target.value as 'today' | 'week' | 'month' | 'custom')}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
                  <input
                    type="date"
                    value={exportFrom}
                    onChange={(e) => { setExportFrom(e.target.value); setExportPreset('custom'); }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
                  <input
                    type="date"
                    value={exportTo}
                    onChange={(e) => { setExportTo(e.target.value); setExportPreset('custom'); }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Teacher</label>
                <select
                  value={exportTeacher}
                  onChange={(e) => setExportTeacher(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">All Teachers</option>
                  {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Student</label>
                <select
                  value={exportStudent}
                  onChange={(e) => setExportStudent(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">All Students</option>
                  {students.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Class Outcome</label>
                <select
                  value={exportOutcome}
                  onChange={(e) => setExportOutcome(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">All Outcomes</option>
                  <option value="Taken">Taken</option>
                  <option value="Student No-Show">Student No-Show</option>
                  <option value="Teacher No-Show">Teacher No-Show</option>
                  <option value="Cancelled by Student">Cancelled by Student</option>
                  <option value="Cancelled by Teacher">Cancelled by Teacher</option>
                  <option value="Cancelled by Admin">Cancelled by Admin</option>
                  <option value="Scheduled">Scheduled</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Client Type</label>
                <select
                  value={exportClientType}
                  onChange={(e) => setExportClientType(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">All</option>
                  <option value="private">Private</option>
                  <option value="company">Company</option>
                </select>
              </div>
            </div>

            {exportError && (
              <p className="text-sm mt-4" style={{ color: '#DC2626' }}>{exportError}</p>
            )}

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setShowExport(false)}
                className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={generateExport}
                disabled={generating || !exportFrom || !exportTo}
                className="px-4 py-2 text-sm text-white rounded-lg font-medium disabled:opacity-60"
                style={{ backgroundColor: '#FF8303' }}
              >
                {generating ? 'Generating...' : 'Generate & Download'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
