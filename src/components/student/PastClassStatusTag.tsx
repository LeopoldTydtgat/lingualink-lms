'use client';

export default function PastClassStatusTag({ status }: { status: string }) {
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
        style={{ backgroundColor: '#FFF3EE', color: '#FD5602' }}
        className="text-xs font-medium px-2 py-0.5 rounded-full"
      >
        You were absent
      </span>
    );
  }
  if (status === 'teacher_no_show') {
    return (
      <span
        style={{ backgroundColor: '#FFF3EE', color: '#FD5602' }}
        className="text-xs font-medium px-2 py-0.5 rounded-full"
      >
        Teacher was absent
      </span>
    );
  }
  return null;
}
