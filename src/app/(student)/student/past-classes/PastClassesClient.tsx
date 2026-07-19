'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Star, X, ChevronDown, ChevronRight } from 'lucide-react';
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

const ROW_STYLE: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #E0DFDC',
  borderRadius: '8px',
};

const PAGE_SIZE = 20;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

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

// Local hour/minute/year/month parts for the given timezone, read via
// Intl.DateTimeFormat (never toLocaleTimeString — this file renders on both
// server and client) so start/end times can be built manually below.
function getLocalParts(isoString: string, timezone: string) {
  const date = new Date(isoString);
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone: timezone,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), hour: get('hour'), minute: get('minute') };
}

function getMonthKey(isoString: string, timezone: string) {
  const { year, month } = getLocalParts(isoString, timezone);
  return `${year}-${pad2(month)}`;
}

function formatMonthLabel(isoString: string, timezone: string) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(date);
}

// "Thu, 16 Jul 2026 · 08:00 – 08:30 · 30 min" — end time is start + duration,
// computed manually from local hour/minute parts (no toISOString).
function formatClassRowLabel(isoString: string, durationMinutes: number, timezone: string) {
  const { dateStr } = formatDateTime(isoString, timezone);
  const { hour, minute } = getLocalParts(isoString, timezone);
  const startStr = `${pad2(hour)}:${pad2(minute)}`;
  const totalEndMinutes = hour * 60 + minute + durationMinutes;
  const endHour = Math.floor(totalEndMinutes / 60) % 24;
  const endMinute = totalEndMinutes % 60;
  const endStr = `${pad2(endHour)}:${pad2(endMinute)}`;
  return `${dateStr} · ${startStr} – ${endStr} · ${durationMinutes} min`;
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
          style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF8303', color: 'white', fontSize: '12px', fontWeight: '700' }}
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

// ─── Class row ───────────────────────────────────────────────────────────────────

function ClassRow({
  lesson,
  studentTimezone,
  hasReview,
  needsReview,
}: {
  lesson: Lesson;
  studentTimezone: string;
  hasReview: boolean;
  needsReview: boolean;
}) {
  const rowLabel = formatClassRowLabel(lesson.scheduled_at, lesson.duration_minutes, studentTimezone);

  return (
    <Link
      href={`/student/past-classes/${lesson.id}`}
      prefetch={false}
      className="flex items-center gap-3 px-3 py-2 shadow-sm hover:shadow-md transition-all"
      style={ROW_STYLE}
    >
      <TeacherAvatar teacher={lesson.teacher} size={32} />

      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">
          <span style={{ fontWeight: 600, color: '#111827' }}>
            {lesson.teacher?.full_name ?? 'Unknown Teacher'}
          </span>
          <span style={{ color: '#9ca3af' }}> · </span>
          <span style={{ color: '#4b5563' }}>{rowLabel}</span>
        </p>
      </div>

      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <PastClassStatusTag status={lesson.status} />
        {needsReview && (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
          >
            Leave a review
          </span>
        )}
        {hasReview && (
          <span className="text-xs" style={{ color: '#9ca3af' }}>Reviewed</span>
        )}
      </div>
    </Link>
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
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset pagination whenever the search narrows/widens the result set.
  // Adjusted during render (React's recommended pattern for resetting state
  // on prop/state change) rather than in a useEffect, which would fire an
  // extra cascading render on every search keystroke.
  const [prevSearch, setPrevSearch] = useState(search);
  if (search !== prevSearch) {
    setPrevSearch(search);
    setVisibleCount(PAGE_SIZE);
  }

  // Newest month is expanded by default; every other month starts collapsed.
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => {
    if (lessons.length === 0) return new Set();
    return new Set([getMonthKey(lessons[0].scheduled_at, studentTimezone)]);
  });

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

  function toggleMonth(key: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const filtered = lessons.filter((lesson) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const teacherName = lesson.teacher?.full_name?.toLowerCase() ?? '';
    const { dateStr } = formatDateTime(lesson.scheduled_at, studentTimezone);
    return teacherName.includes(q) || dateStr.toLowerCase().includes(q);
  });

  // Group the full filtered list by month (for accurate per-month counts),
  // then only reveal rows within `visibleCount` — groups sorted-descending
  // stay contiguous, so a running cursor tells each group how many of its
  // rows have been paged in so far.
  type MonthGroup = { key: string; label: string; items: Lesson[] };
  const monthGroups: MonthGroup[] = [];
  for (const lesson of filtered) {
    const key = getMonthKey(lesson.scheduled_at, studentTimezone);
    const last = monthGroups[monthGroups.length - 1];
    if (last && last.key === key) {
      last.items.push(lesson);
    } else {
      monthGroups.push({ key, label: formatMonthLabel(lesson.scheduled_at, studentTimezone), items: [lesson] });
    }
  }

  let cursor = 0;
  const visibleGroups = monthGroups
    .map((group) => {
      const groupStart = cursor;
      cursor += group.items.length;
      const loadedInGroup = Math.max(0, Math.min(group.items.length, visibleCount - groupStart));
      return { ...group, visibleItems: group.items.slice(0, loadedInGroup) };
    })
    .filter((group) => group.visibleItems.length > 0);

  const hasMore = visibleCount < filtered.length;

  return (
    <div className="p-6">
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
        <>
          <div className="space-y-4">
            {visibleGroups.map((group) => {
              const isExpanded = expandedMonths.has(group.key);
              return (
                <div key={group.key}>
                  <button
                    type="button"
                    onClick={() => toggleMonth(group.key)}
                    className="w-full flex items-center justify-between px-1 py-2"
                    style={{ position: 'sticky', top: 0, backgroundColor: '#f9fafb', zIndex: 10 }}
                  >
                    <span
                      style={{
                        backgroundColor: '#FFF3E0',
                        color: '#FF8303',
                        fontWeight: 600,
                        fontSize: '13px',
                        padding: '4px 12px',
                        borderRadius: '9999px',
                        display: 'inline-block',
                      }}
                    >
                      {group.label} — {group.items.length} class{group.items.length !== 1 ? 'es' : ''}
                    </span>
                    {isExpanded ? (
                      <ChevronDown size={16} color="#9ca3af" />
                    ) : (
                      <ChevronRight size={16} color="#9ca3af" />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="space-y-2">
                      {group.visibleItems.map((lesson) => {
                        const hasReview =
                          reviewedClassIds.includes(lesson.id) ||
                          locallyReviewedIds.has(lesson.id);
                        const needsReview = lesson.status === 'completed' && !hasReview;

                        return (
                          <ClassRow
                            key={lesson.id}
                            lesson={lesson}
                            studentTimezone={studentTimezone}
                            hasReview={hasReview}
                            needsReview={needsReview}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {hasMore && (
            <div className="flex justify-center mt-6">
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ border: '1px solid #E0DFDC', color: '#4b5563', backgroundColor: '#ffffff' }}
              >
                Load More
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
