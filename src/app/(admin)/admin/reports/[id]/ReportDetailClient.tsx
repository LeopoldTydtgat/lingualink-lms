'use client';

// src/app/(admin)/admin/reports/[id]/ReportDetailClient.tsx

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface LevelData {
  grammar?:       number;
  expression?:    number;
  comprehension?: number;
  vocabulary?:    number;
  accent?:        number;
  spoken?:        number;
  written?:       number;
  [key: string]:  number | undefined;
}

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
  sheet:       { id: string; title: string; category: string; level: string; } | null;
}

interface Props {
  report:      Report;
  assignments: Assignment[];
}

function formatDateTime(iso: string) {
  const d   = new Date(iso);
  const day = d.getDate().toString().padStart(2, '0');
  const mon = d.toLocaleString('en-GB', { month: 'long' });
  const yr  = d.getFullYear();
  const hr  = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${day} ${mon} ${yr} at ${hr}:${min}`;
}

const CEFR_LABELS = ['A1', 'A1+', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1', 'C1+', 'C2'];

const SKILLS = [
  { key: 'grammar',       label: 'Grammar' },
  { key: 'expression',    label: 'Expression' },
  { key: 'comprehension', label: 'Comprehension' },
  { key: 'vocabulary',    label: 'Vocabulary' },
  { key: 'accent',        label: 'Accent' },
  { key: 'spoken',        label: 'Spoken' },
  { key: 'written',       label: 'Written' },
];

function RadarChart({ levelData }: { levelData: LevelData }) {
  const size = 280; const cx = size / 2; const cy = size / 2;
  const maxRadius = 90; const n = SKILLS.length; const maxValue = 10;

  function angle(i: number) { return (Math.PI * 2 * i) / n - Math.PI / 2; }
  function axisPoint(i: number, fraction: number) {
    const r = maxRadius * fraction;
    return { x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) };
  }

  const gridPolygons = [0.2, 0.4, 0.6, 0.8, 1].map((f) =>
    SKILLS.map((_, i) => { const p = axisPoint(i, f); return `${p.x},${p.y}`; }).join(' ')
  );
  const dataPoints  = SKILLS.map((s, i) => axisPoint(i, Math.max(0.02, (levelData[s.key] ?? 0) / maxValue)));
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const labelPoints = SKILLS.map((_, i) => {
    const r = maxRadius + 20;
    return { x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      {gridPolygons.map((pts, gi) => <polygon key={gi} points={pts} fill="none" stroke="#E5E7EB" strokeWidth="1" />)}
      {SKILLS.map((_, i) => { const end = axisPoint(i, 1); return <line key={i} x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#E5E7EB" strokeWidth="1" />; })}
      <polygon points={dataPolygon} fill="#FF8303" fillOpacity={0.25} stroke="#FF8303" strokeWidth="2" />
      {dataPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4} fill="#FF8303" />)}
      {SKILLS.map((s, i) => {
        const lp = labelPoints[i];
        const val = levelData[s.key];
        const cefrLabel = val !== undefined ? CEFR_LABELS[Math.round(val)] ?? '' : '';
        return (
          <g key={i}>
            <text x={lp.x} y={lp.y} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontFamily="Inter, sans-serif" fill="#374151" fontWeight="500">{s.label}</text>
            {cefrLabel && <text x={lp.x} y={lp.y + 12} textAnchor="middle" dominantBaseline="middle" fontSize="9" fontFamily="Inter, sans-serif" fill="#FF8303" fontWeight="600">{cefrLabel}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function ReportDetailClient({ report, assignments }: Props) {
  const router = useRouter();
  const [reopening,   setReopening]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleReopen() {
    setReopening(true);
    try {
      await fetch(`/api/admin/reports/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' }),
      });
      router.push('/admin/reports');
    } finally {
      setReopening(false);
      setShowConfirm(false);
    }
  }

  const hasLevelData = report.level_data &&
    Object.values(report.level_data).some((v) => v !== undefined && v !== null);

  return (
    <div className="p-6 max-w-4xl">
      <Link href="/admin/reports" className="text-sm hover:underline mb-5 inline-flex items-center gap-1" style={{ color: '#FF8303' }}>← Back to Reports</Link>

      <div className="flex items-center justify-between mt-3 mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Report Detail</h1>
        <div className="flex items-center gap-3">
          {report.status === 'flagged'   && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#FEE2E2', color: '#991B1B' }}>Flagged</span>}
          {report.status === 'completed' && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#DCFCE7', color: '#166534' }}>Completed</span>}
          {report.status === 'pending'   && <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>Pending</span>}
          {report.status === 'flagged' && (
            <button onClick={() => setShowConfirm(true)} className="text-sm font-medium text-white px-4 py-2 rounded-lg" style={{ backgroundColor: '#FF8303' }}>Reopen Report</button>
          )}
        </div>
      </div>

      {report.impersonation_note && (
        <div className="text-sm rounded-lg p-3 mb-5" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
          <strong>Admin note:</strong> {report.impersonation_note}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Class Info</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Date &amp; Time</dt>
              <dd className="text-gray-800 font-medium">{report.lesson?.scheduled_at ? formatDateTime(report.lesson.scheduled_at) : '—'}</dd>
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
                <dd className="text-gray-800">{formatDateTime(report.completed_at)}</dd>
              </div>
            )}
            {report.flagged_at && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Flagged at</dt>
                <dd style={{ color: '#DC2626' }}>{formatDateTime(report.flagged_at)}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5">
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
        <div className="bg-white rounded-xl border border-gray-100 p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Class Recap, Feedback &amp; Next Steps</h2>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{report.feedback_text}</p>
        </div>
      )}

      {report.additional_details && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Additional Details</h2>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{report.additional_details}</p>
        </div>
      )}

      {hasLevelData && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Student Level Assessment</h2>
          <div className="flex flex-col items-center">
            <RadarChart levelData={report.level_data!} />
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
              {SKILLS.map((s) => {
                const val = report.level_data![s.key];
                const cefrLabel = val !== undefined ? CEFR_LABELS[Math.round(val)] ?? '—' : '—';
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: '#FF8303' }} />
                    <span className="text-gray-500">{s.label}:</span>
                    <span className="font-medium" style={{ color: '#FF8303' }}>{cefrLabel}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {assignments.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-5 mt-5">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Assigned for Next Time</h2>
          <div className="space-y-2">
            {assignments.map((a) => (
              <div key={a.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-800">{a.sheet?.title ?? 'Untitled sheet'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{a.sheet?.category} · {a.sheet?.level}</p>
                </div>
                <span className="text-xs text-gray-400">{a.assigned_at ? new Date(a.assigned_at).toLocaleDateString('en-GB') : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Reopen this report?</h3>
            <p className="text-sm text-gray-600 mb-5">The report status will be set back to pending and the teacher will be able to submit it late.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowConfirm(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50" disabled={reopening}>Cancel</button>
              <button onClick={handleReopen} disabled={reopening} className="px-4 py-2 text-sm text-white rounded-lg font-medium" style={{ backgroundColor: '#FF8303' }}>
                {reopening ? 'Reopening…' : 'Reopen Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
