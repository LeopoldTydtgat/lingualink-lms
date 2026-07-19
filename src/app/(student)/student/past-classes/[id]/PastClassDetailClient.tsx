'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from 'recharts';
import {
  MessageSquareText,
  BookOpen,
  PenLine,
  Activity,
  Star,
} from 'lucide-react';
import PdfViewer, { type Annotation } from '@/components/pdf/PdfViewer';
import PastClassStatusTag from '@/components/student/PastClassStatusTag';
import StarRating from '@/components/student/StarRating';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Report {
  id: string;
  feedback_text: string | null;
  did_class_happen: boolean | null;
  level_data: Record<string, string> | null;
  additional_details: string | null;
}

interface Teacher {
  id: string;
  full_name: string;
  photo_url: string | null;
  bio: string | null;
}

interface Lesson {
  id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
  teacher: Teacher | null;
  report: Report | null;
}

interface Assignment {
  id: string;
  study_sheet: {
    id: string;
    title: string;
    category: string | null;
    level: string | null;
  } | null;
}

interface ExistingReview {
  id: string;
  rating: number;
  review_text: string | null;
}

interface AnnotatedPdf {
  studySheetId: string;
  attachmentIndex: number;
  annotations: Annotation[];
}

interface Props {
  lesson: Lesson;
  assignments: Assignment[];
  annotatedPdfs: AnnotatedPdf[];
  existingReview: ExistingReview | null;
  studentId: string;
  studentTimezone: string;
}

// ─── CEFR level → numeric for radar chart ─────────────────────────────────────

const LEVEL_ORDER = [
  'A1', 'A2',
  'B1', 'B2',
  'C1', 'C2',
];

function levelToNumber(level: string | undefined): number {
  if (!level) return 0;
  const idx = LEVEL_ORDER.indexOf(level);
  return idx === -1 ? 0 : idx + 1;
}

const SKILLS = [
  { key: 'grammar', label: 'Grammar' },
  { key: 'expression', label: 'Expression' },
  { key: 'comprehension', label: 'Comprehension' },
  { key: 'vocabulary', label: 'Vocabulary' },
  { key: 'accent', label: 'Accent' },
  { key: 'overall_spoken', label: 'Spoken' },
  { key: 'overall_written', label: 'Written' },
];

// ─── Design system ────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #f3f4f6',
  borderRadius: '12px',
};

function CardHeader({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center" style={{ gap: '7px' }}>
      <Icon size={14} color="#FF8303" />
      <span style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', letterSpacing: '0.05em' }}>
        {label}
      </span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(isoString: string, timezone: string) {
  const date = new Date(isoString);
  const dateStr = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(date);
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    hour12: false,
  }).format(date);
  return { dateStr, timeStr };
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PastClassDetailClient({
  lesson,
  assignments,
  annotatedPdfs,
  existingReview,
  studentId,
  studentTimezone,
}: Props) {
  const router = useRouter();
  const { dateStr, timeStr } = formatDateTime(lesson.scheduled_at, studentTimezone);

  // Review form state
  const [rating, setRating] = useState(existingReview?.rating ?? 0);
  const [reviewText, setReviewText] = useState(existingReview?.review_text ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(!!existingReview);

  // Build radar chart data from report level_data
  const radarData = SKILLS.map((skill) => ({
    skill: skill.label,
    value: levelToNumber(lesson.report?.level_data?.[skill.key]),
    fullMark: 6,
  }));

  const hasLevelData =
    lesson.report?.level_data &&
    Object.values(lesson.report.level_data).some((v) => v);

  const hasSheets = assignments.some((a) => a.study_sheet);

  // Submit review
  async function handleSubmitReview() {
    if (rating === 0) {
      setSubmitError('Please select a star rating before submitting.');
      return;
    }
    setSubmitting(true);
    setSubmitError('');

    try {
      const res = await fetch('/api/student/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_id: lesson.id,
          student_id: studentId,
          teacher_id: lesson.teacher?.id,
          rating,
          review_text: reviewText.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setSubmitError(data.error ?? 'Something went wrong. Please try again.');
        return;
      }

      setSubmitted(true);
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Back link */}
      <Link
        href="/student/past-classes"
        prefetch={false}
        className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-6"
      >
        ← Back to Past Classes
      </Link>

      {/* ── Teacher + class header ── */}
      <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }} className="shadow-sm">
        <div className="flex items-center gap-4">
          <div style={{ width: '64px', height: '64px', borderRadius: '50%', overflow: 'hidden', backgroundColor: '#f3f4f6', flexShrink: 0 }}>
            {lesson.teacher?.photo_url ? (
              <Image
                src={lesson.teacher.photo_url}
                alt={lesson.teacher.full_name}
                width={64}
                height={64}
                style={{ objectFit: 'cover', width: '100%', height: '100%' }}
              />
            ) : (
              <div
                style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF8303', color: 'white', fontSize: '18px', fontWeight: '700' }}
              >
                {lesson.teacher?.full_name?.[0] ?? '?'}
              </div>
            )}
          </div>
          <div className="flex-1">
            <p className="font-bold text-gray-900 text-lg">
              {lesson.teacher?.full_name ?? 'Unknown Teacher'}
            </p>
            <p className="text-sm text-gray-500 mt-0.5">
              {dateStr} · {timeStr} · {lesson.duration_minutes} min
            </p>
            <div className="mt-1.5">
              <PastClassStatusTag status={lesson.status} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Teacher feedback ── */}
      <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }} className="shadow-sm">
        <div className="mb-3">
          <CardHeader icon={MessageSquareText} label="TEACHER FEEDBACK" />
        </div>
        {lesson.report?.feedback_text ? (
          <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">
            {lesson.report.feedback_text}
          </p>
        ) : (
          <p style={{ fontSize: '13px', color: '#9ca3af' }}>
            Your teacher didn&apos;t leave written feedback for this class.
          </p>
        )}
      </div>

      {/* ── Assigned study sheets ── */}
      <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }} className="shadow-sm">
        <div className="mb-3">
          <CardHeader icon={BookOpen} label="STUDY SHEETS ASSIGNED" />
        </div>
        {hasSheets ? (
          <div className="space-y-2">
            {assignments.map((a) =>
              a.study_sheet ? (
                <div
                  key={a.id}
                  className="flex items-center justify-between text-sm rounded-lg px-3 py-2"
                  style={{ border: '1px solid #f3f4f6' }}
                >
                  <span className="text-gray-800">{a.study_sheet.title}</span>
                  <div className="flex items-center gap-2 text-xs" style={{ color: '#9ca3af' }}>
                    {a.study_sheet.category && <span>{a.study_sheet.category}</span>}
                    {a.study_sheet.category && a.study_sheet.level && <span>{String.fromCharCode(183)}</span>}
                    {a.study_sheet.level && <span>{a.study_sheet.level}</span>}
                  </div>
                </div>
              ) : null
            )}
          </div>
        ) : (
          <p style={{ fontSize: '13px', color: '#9ca3af' }}>
            No study sheets were assigned after this class.
          </p>
        )}
      </div>

      {/* ── Teacher's marked-up material ── */}
      {annotatedPdfs.length > 0 && (
        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }} className="shadow-sm">
          <div className="mb-1">
            <CardHeader icon={PenLine} label="MATERIAL YOUR TEACHER MARKED UP" />
          </div>
          <p className="text-xs text-gray-500 mb-3">
            The notes your teacher made on screen during this class. View only.
          </p>
          <div className="space-y-4">
            {annotatedPdfs.map((pdf) => (
              <div
                key={`${pdf.studySheetId}:${pdf.attachmentIndex}`}
                className="overflow-hidden bg-white"
                style={{ border: '1px solid #f3f4f6', borderRadius: '12px' }}
              >
                <PdfViewer
                  fileUrl={`/api/lesson-annotation-file/${lesson.id}/${pdf.studySheetId}/${pdf.attachmentIndex}`}
                  initialAnnotations={pdf.annotations}
                  readOnly
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Level radar chart ── */}
      {hasLevelData && (
        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }} className="shadow-sm">
          <div className="mb-4">
            <CardHeader icon={Activity} label="YOUR LEVEL AT THIS CLASS" />
          </div>
          <div className="w-full" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData}>
                <PolarGrid stroke="#e5e7eb" />
                <PolarAngleAxis
                  dataKey="skill"
                  tick={{ fontSize: 12, fill: '#6b7280' }}
                />
                <Radar
                  name="Level"
                  dataKey="value"
                  stroke="#FF8303"
                  fill="#FF8303"
                  fillOpacity={0.25}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          {/* Level labels reference */}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 justify-center">
            {SKILLS.map((skill) => {
              const level = lesson.report?.level_data?.[skill.key];
              return level ? (
                <span key={skill.key} className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{skill.label}:</span> {level}
                </span>
              ) : null;
            })}
          </div>
        </div>
      )}

      {/* ── Review section ── */}
      {lesson.status === 'completed' && (
        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }} className="shadow-sm">
          <div className="mb-1">
            <CardHeader icon={Star} label={submitted ? 'YOUR REVIEW' : 'LEAVE A REVIEW'} />
          </div>
          <h2 className="font-semibold text-gray-900 mb-2 text-sm">
            {submitted ? 'Your Review' : `How was your class with ${lesson.teacher?.full_name ?? 'your teacher'}?`}
          </h2>

          {submitted ? (
            <div>
              <StarRating value={rating} readonly />
              {reviewText && (
                <p className="mt-2 text-sm text-gray-600 italic">&quot;{reviewText}&quot;</p>
              )}
              <p className="mt-2 text-xs text-gray-400">Thank you for your feedback.</p>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-500 mb-3">
                Your review is shared with the admin and displayed on your teacher&apos;s profile.
              </p>

              <StarRating value={rating} onChange={setRating} />

              <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                placeholder="Write a review (optional)..."
                rows={3}
                className="mt-3 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 resize-none focus:outline-none focus:ring-2"
                style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
              />

              {submitError && (
                <p className="mt-2 text-xs text-red-500">{submitError}</p>
              )}

              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleSubmitReview}
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={
                    submitting
                      ? { backgroundColor: '#E5E7EB', color: '#9CA3AF' }
                      : { backgroundColor: '#FF8303', color: '#ffffff' }
                  }
                >
                  {submitting ? 'Submitting...' : 'Submit Review'}
                </button>
                <button
                  onClick={() => router.push('/student/past-classes')}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ border: '1px solid #E0DFDC', color: '#4b5563' }}
                >
                  Skip for now
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
