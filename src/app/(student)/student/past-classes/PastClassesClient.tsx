'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

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

export default function PastClassesClient({
  lessons,
  studentTimezone,
  reviewedClassIds,
  studentId,
}: Props) {
  const [search, setSearch] = useState('');

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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Past Classes</h1>
        <p className="text-sm text-gray-500 mt-1">
          {lessons.length} class{lessons.length !== 1 ? 'es' : ''} completed
        </p>
      </div>

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by teacher name or date..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2"
          style={{ focusRingColor: '#FF8303' } as React.CSSProperties}
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">
          {search ? 'No classes match your search.' : 'No past classes yet.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((lesson) => {
            const { dateStr, timeStr } = formatDateTime(
              lesson.scheduled_at,
              studentTimezone
            );
            const hasReview = reviewedClassIds.includes(lesson.id);
            const needsReview =
              lesson.status === 'completed' && !hasReview;

            return (
              <Link
                key={lesson.id}
                href={`/student/past-classes/${lesson.id}`}
                className="block bg-white border border-gray-200 rounded-xl p-4 hover:border-orange-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-4">
                  {/* Teacher photo */}
                  <div className="w-12 h-12 rounded-full overflow-hidden bg-gray-100 flex-shrink-0">
                    {lesson.teacher?.photo_url ? (
                      <Image
                        src={lesson.teacher.photo_url}
                        alt={lesson.teacher.full_name}
                        width={48}
                        height={48}
                        className="object-cover w-full h-full"
                      />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center text-white text-sm font-bold"
                        style={{ backgroundColor: '#FF8303' }}
                      >
                        {lesson.teacher?.full_name?.[0] ?? '?'}
                      </div>
                    )}
                  </div>

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
                    <StatusTag status={lesson.status} />
                    {needsReview && (
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: '#fff7ed', color: '#FF8303' }}
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