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
    category: string;
    level: string;
  } | null;
}

interface ExistingReview {
  id: string;
  rating: number;
  review_text: string | null;
}

interface Props {
  lesson: Lesson;
  assignments: Assignment[];
  existingReview: ExistingReview | null;
  studentId: string;
  studentTimezone: string;
}

// ─── CEFR level → numeric for radar chart ─────────────────────────────────────

const LEVEL_ORDER = [
  'A1', 'A1+', 'A2', 'A2+',
  'B1', 'B1+', 'B2', 'B2+',
  'C1', 'C1+', 'C2',
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

function StatusTag({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span
        style={{ backgroundColor: '#dcfce7', color: '#166534' }}
        className="text-xs font-medium px-2 py-0.5 rounded-full"
      >
        Completed
      </span>
    );
  }
  if (status === 'student_no_show') {
    return (
      <span
        style={{ backgroundColor: '#fff7ed', color: '#c2410c' }}
        className="text-xs font-medium px-2 py-0.5 rounded-full"
      >
        You were absent
      </span>
    );
  }
  if (status === 'teacher_no_show') {
    return (
      <span
        style={{ backgroundColor: '#fef2f2', color: '#991b1b' }}
        className="text-xs font-medium px-2 py-0.5 rounded-full"
      >
        Teacher was absent
      </span>
    );
  }
  return null;
}

// ─── Star rating component ────────────────────────────────────────────────────

function StarRating({
  value,
  onChange,
  readonly = false,
}: {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
}) {
  const [hovered, setHovered] = useState(0);

  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = readonly ? star <= value : star <= (hovered || value);
        return (
          <button
            key={star}
            type="button"
            disabled={readonly}
            onClick={() => !readonly && onChange?.(star)}
            onMouseEnter={() => !readonly && setHovered(star)}
            onMouseLeave={() => !readonly && setHovered(0)}
            className="text-2xl leading-none focus:outline-none"
            style={{ color: filled ? '#FF8303' : '#d1d5db', cursor: readonly ? 'default' : 'pointer' }}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PastClassDetailClient({
  lesson,
  assignments,
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
    fullMark: 11,
  }));

  const hasLevelData =
    lesson.report?.level_data &&
    Object.values(lesson.report.level_data).some((v) => v);

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
    <div className="p-6 max-w-3xl mx-auto">
      {/* Back link */}
      <Link
        href="/student/past-classes"
        className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-6"
      >
        ← Back to Past Classes
      </Link>

      {/* ── Teacher + class header ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full overflow-hidden bg-gray-100 flex-shrink-0">
            {lesson.teacher?.photo_url ? (
              <Image
                src={lesson.teacher.photo_url}
                alt={lesson.teacher.full_name}
                width={64}
                height={64}
                className="object-cover w-full h-full"
              />
            ) : (
              <div
                className="w-full h-full flex items-center justify-center text-white text-lg font-bold"
                style={{ backgroundColor: '#FF8303' }}
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
              <StatusTag status={lesson.status} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Teacher feedback ── */}
      {lesson.report?.feedback_text && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
          <h2 className="font-semibold text-gray-900 mb-2 text-sm">
            Teacher Feedback
          </h2>
          <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">
            {lesson.report.feedback_text}
          </p>
        </div>
      )}

      {/* ── Assigned study sheets ── */}
      {assignments.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
          <h2 className="font-semibold text-gray-900 mb-3 text-sm">
            Study Sheets Assigned
          </h2>
          <div className="space-y-2">
            {assignments.map((a) =>
              a.study_sheet ? (
                <div
                  key={a.id}
                  className="flex items-center justify-between text-sm border border-gray-100 rounded-lg px-3 py-2"
                >
                  <span className="text-gray-800">{a.study_sheet.title}</span>
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span>{a.study_sheet.category}</span>
                    <span>·</span>
                    <span>{a.study_sheet.level}</span>
                  </div>
                </div>
              ) : null
            )}
          </div>
        </div>
      )}

      {/* ── Level radar chart ── */}
      {hasLevelData && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
          <h2 className="font-semibold text-gray-900 mb-4 text-sm">
            Your Level at This Class
          </h2>
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
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
          <h2 className="font-semibold text-gray-900 mb-1 text-sm">
            {submitted ? 'Your Review' : `How was your class with ${lesson.teacher?.full_name ?? 'your teacher'}?`}
          </h2>

          {submitted ? (
            <div>
              <StarRating value={rating} readonly />
              {reviewText && (
                <p className="mt-2 text-sm text-gray-600 italic">"{reviewText}"</p>
              )}
              <p className="mt-2 text-xs text-gray-400">Thank you for your feedback.</p>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-500 mb-3">
                Your review is shared with the admin and displayed on your teacher's profile.
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
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity"
                  style={{ backgroundColor: '#FF8303', opacity: submitting ? 0.6 : 1 }}
                >
                  {submitting ? 'Submitting...' : 'Submit Review'}
                </button>
                <button
                  onClick={() => router.push('/student/past-classes')}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
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
