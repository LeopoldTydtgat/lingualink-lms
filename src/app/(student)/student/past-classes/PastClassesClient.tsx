'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Star, X } from 'lucide-react';
import { EmptyPastClasses } from '@/components/EmptyPastClasses';
import PastClassStatusTag from '@/components/student/PastClassStatusTag';
import StarRating from '@/components/student/StarRating';

interface Report {
  id: string;
  feedback_text: string | null;
  did_class_happen: boolean | null;
  level_data: Record<string, string> | null;
}

interface Teacher {
  id: string;
  full_name: string;
  photo_url: string | null;
}

interface Lesson {
  id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
  teacher: Teacher | null;
  report: Report | null;
}

interface Props {
  lessons: Lesson[];
  studentTimezone: string;
  reviewedClassIds: string[];
  studentId: string;
}

const CARD_STYLE: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #f3f4f6',
  borderRadius: '12px',
};

function formatDateTime(isoString: string, timezone: string) {
  const date = new Date(isoString);
  const dateStr = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
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

function TeacherAvatar({
  teacher,
  size,
}: {
  teacher: Teacher | null;
  size: number;
}) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', backgroundColor: '#f3f4f6', flexShrink: 0 }}>
      {teacher?.photo_url ? (
        <Image
          src={teacher.photo_url}
          alt={teacher.full_name}
          width={size}
          height={size}
          style={{ objectFit: 'cover', width: '100%', height: '100%' }}
        />
      ) : (
        <div
          style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF8303', color: 'white', fontSize: '14px', fontWeight: '700' }}
        >
          {teacher?.full_name?.[0] ?? '?'}
        </div>
      )}
    </div>
  );
}

// ─── Review prompt card ─────────────────────────────────────────────────────────

function ReviewPromptCard({
  lesson,
  studentId,
  studentTimezone,
  onDismiss,
  onReviewed,
}: {
  lesson: Lesson;
  studentId: string;
  studentTimezone: string;
  onDismiss: () => void;
  onReviewed: (lessonId: string) => void;
}) {
  const { dateStr } = formatDateTime(lesson.scheduled_at, studentTimezone);
  const [rating, setRating] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
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
      onReviewed(lesson.id);
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '24px' }} className="shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center" style={{ gap: '7px' }}>
          <Star size={14} color="#FF8303" />
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', letterSpacing: '0.05em' }}>
            LEAVE A REVIEW
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="leading-none focus:outline-none"
          style={{ color: '#9ca3af' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#4b5563')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#9ca3af')}
        >
          <X size={16} />
        </button>
      </div>

      {submitted ? (
        <p className="mt-3 text-sm" style={{ color: '#9ca3af' }}>
          Thanks for your review!
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3 mt-3">
            <TeacherAvatar teacher={lesson.teacher} size={40} />
            <p className="font-medium" style={{ color: '#111827', fontSize: '14px' }}>
              How was your class with {lesson.teacher?.full_name ?? 'your teacher'} on {dateStr}?
            </p>
          </div>

          <div className="mt-3">
            <StarRating value={rating} onChange={setRating} />
          </div>

          <textarea
            value={reviewText}
            onChange={(e) => setReviewText(e.target.value)}
            placeholder="Write a review (optional)..."
            rows={2}
            className="mt-3 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 resize-none focus:outline-none focus:ring-2"
            style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
          />

          {submitError && (
            <p className="mt-2 text-xs text-red-500">{submitError}</p>
          )}

          <div className="mt-3">
            <button
              onClick={handleSubmit}
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
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────────

export default function PastClassesClient({
  lessons,
  studentTimezone,
  reviewedClassIds,
  studentId,
}: Props) {
  const [search, setSearch] = useState('');
  const [locallyReviewedIds, setLocallyReviewedIds] = useState<Set<string>>(new Set());

  // localStorage dismiss keys — read after mount to avoid hydration mismatch
  const [dismissLoaded, setDismissLoaded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next = new Set<string>();
    for (const lesson of lessons) {
      try {
        if (localStorage.getItem(`reviewPromptDismissed:${lesson.id}`)) {
          next.add(lesson.id);
        }
      } catch {
        // localStorage unavailable — treat as not dismissed
      }
    }
    setDismissed(next);
    setDismissLoaded(true);
  }, [lessons]);

  const promptLesson = useMemo(() => {
    if (!dismissLoaded) return null;
    const candidates = lessons
      .filter(
        (l) =>
          l.status === 'completed' &&
          !reviewedClassIds.includes(l.id) &&
          !dismissed.has(l.id)
      )
      .sort(
        (a, b) =>
          new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime()
      );
    return candidates[0] ?? null;
  }, [dismissLoaded, lessons, reviewedClassIds, dismissed]);

  function handleDismiss(lessonId: string) {
    try {
      localStorage.setItem(`reviewPromptDismissed:${lessonId}`, '1');
    } catch {
      // ignore
    }
    setDismissed((prev) => new Set(prev).add(lessonId));
  }

  function handleReviewed(lessonId: string) {
    setLocallyReviewedIds((prev) => new Set(prev).add(lessonId));
  }

  const filtered = lessons.filter((lesson) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const teacherName = lesson.teacher?.full_name?.toLowerCase() ?? '';
    const { dateStr } = formatDateTime(lesson.scheduled_at, studentTimezone);
    return teacherName.includes(q) || dateStr.toLowerCase().includes(q);
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%' }}>
        <h1 className="text-2xl font-bold text-gray-900">Past Classes</h1>
        <p className="text-sm text-gray-500 mt-1">
          {lessons.length} class{lessons.length !== 1 ? 'es' : ''} completed
        </p>
      </div>

      {/* Review prompt */}
      {promptLesson && (
        <ReviewPromptCard
          key={promptLesson.id}
          lesson={promptLesson}
          studentId={studentId}
          studentTimezone={studentTimezone}
          onDismiss={() => handleDismiss(promptLesson.id)}
          onReviewed={handleReviewed}
        />
      )}

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by teacher name or date..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2"
          style={{ '--tw-ring-color': '#FF8303' } as React.CSSProperties}
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">
          {!search && <EmptyPastClasses />}
          {search ? 'No classes match your search.' : 'No past classes yet.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((lesson) => {
            const { dateStr, timeStr } = formatDateTime(
              lesson.scheduled_at,
              studentTimezone
            );
            const hasReview =
              reviewedClassIds.includes(lesson.id) ||
              locallyReviewedIds.has(lesson.id);
            const needsReview = lesson.status === 'completed' && !hasReview;

            return (
              <Link
                key={lesson.id}
                href={`/student/past-classes/${lesson.id}`}
                prefetch={false}
                className="block p-4 shadow-sm hover:shadow-md transition-all"
                style={CARD_STYLE}
              >
                <div className="flex items-center gap-4">
                  {/* Teacher photo */}
                  <TeacherAvatar teacher={lesson.teacher} size={48} />

                  {/* Class info */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 text-sm truncate">
                      {lesson.teacher?.full_name ?? 'Unknown Teacher'}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {dateStr} · {timeStr} · {lesson.duration_minutes} min
                    </p>
                  </div>

                  {/* Right side — status + review nudge */}
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <PastClassStatusTag status={lesson.status} />
                    {needsReview && (
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                      >
                        ⭐ Leave a review
                      </span>
                    )}
                    {hasReview && (
                      <span className="text-xs text-gray-400">Reviewed</span>
                    )}
                  </div>
                </div>

                {/* Feedback preview */}
                {lesson.report?.feedback_text && (
                  <p className="mt-3 text-xs text-gray-500 line-clamp-2 pl-16">
                    {lesson.report.feedback_text}
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
