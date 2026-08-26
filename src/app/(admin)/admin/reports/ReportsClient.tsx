'use client';

// src/app/(admin)/admin/reports/ReportsClient.tsx

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { getCancellationLabel } from '@/lib/lessons/statusLabel';
import { DateRangeFilter } from '../_components/DateRangeFilter';
import { useFilterPersistence } from '@/lib/hooks/useFilterPersistence';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Teacher { id: string; full_name: string; photo_url?: string | null; }
interface Student { id: string; full_name: string; photo_url?: string | null; }
interface LessonSummary { id: string; scheduled_at: string; duration_minutes: number; status: string; }

interface Report {
  id:               string;
  lesson_id:        string;
  status:           'pending' | 'completed' | 'flagged' | 'reopened';
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
  cancelled_by:     string | null;
  rescheduled_by:   string | null;
  teacher:          Teacher | null;
  student:          { id: string; full_name: string } | null;
  report:           { id: string; status: string; completed_at: string | null; flagged_at: string | null } | null;
}

interface Props {
  initialReports: Report[];
  teachers:       { id: string; full_name: string }[];
  students:       { id: string; full_name: string }[];
  // Seeded from ?filter= by the server page; '' means "All Statuses".
  initialStatusFilter?: string;
  // Seeded from ?reopen= by the server page; opens the reopen-confirmation modal
  // for that report on load. undefined means "no modal open".
  initialReopenId?: string;
  // The logged-in admin's IANA timezone (server page falls back to 'UTC').
  adminTimezone: string;
  // The SAME profiles.timezone as adminTimezone above, but WITHOUT the 'UTC' fallback.
  // Deliberately a second prop rather than a reuse of that one: adminTimezone feeds Intl
  // formatting, which needs a string and for which UTC is a survivable last resort, while
  // this feeds the DateRangeFilter presets, where "which day is today" has no honest
  // answer without a zone. The presets must go dead on null rather than quietly name the
  // UTC day - so the null has to survive the trip, and collapsing the two props into one
  // would destroy exactly the distinction that keeps them from guessing.
  adminTzRaw: string | null;
  // Global outstanding-work counts from the server - NOT scoped by the list filters, and
  // never a placeholder 0 (the server falls back to a derived number on a failed count).
  initialPendingCount: number;
  initialFlaggedCount: number;
  // The server's exact row count for the SEEDED filter state - the same number the GET
  // route's page-1 response reports for those filters. null when the seed query FAILED,
  // which forces the mount fetch rather than trusting the rows that query produced.
  initialTotal: number | null;
  // The date range the list OPENS on, resolved server-side in the admin's own timezone:
  // month-to-date on a plain landing, and '' under ANY URL param or a timezone-less
  // profile. '' means "no date bound" - all history.
  initialDateFrom: string;
  initialDateTo: string;
  // The LANDING default, which the Clear button returns to. A separate pair because the
  // two DISAGREE under a deep link: ?filter= / ?reopen= land on no date bound at all, but
  // Clear must hand back the month-to-date view. Equal to the initial pair on every plain
  // landing, and '' for both on a timezone-less profile - where Clear empties the two
  // inputs exactly as it always did.
  defaultDateFrom: string;
  defaultDateTo: string;
  // True when the URL carried ?filter= or ?reopen=. The URL then wins outright: no
  // restore from sessionStorage, and storage is overwritten from what the URL produced,
  // so a deep link is never quietly widened or narrowed by a remembered filter.
  hasUrlFilters?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Times are stored in UTC. We format each in the admin's own timezone via Intl with an
// explicit timeZone. That is deterministic: the same output on server and client, so it is
// safe in this client component under SSR (no hydration mismatch). Without the timeZone the
// server rendered in the host's zone and the browser re-rendered in the viewer's, which both
// mismatched on hydration and showed the wrong wall-clock time.
function formatDateTime(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function hoursAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs  = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hrs > 0) return `${hrs}h ${mins}m ago`;
  return `${mins}m ago`;
}

// Mirrors the exportError pattern in generateExport: prefer the server's error
// string, fall back to the status code when the body is not JSON.
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

// ─── Badges ───────────────────────────────────────────────────────────────────

function ReportStatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    pending:   { bg: '#FFF8E8', text: '#B45309', label: 'Pending' },
    completed: { bg: '#DCFCE7', text: '#15803D', label: 'Completed' },
    flagged:   { bg: '#FFEEE6', text: '#FD5602', label: 'Flagged' },
    reopened:  { bg: '#FFF8E8', text: '#B45309', label: 'Reopened' },
  };
  const s = styles[status] ?? { bg: '#F3F4F6', text: '#374151', label: status };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: s.bg, color: s.text }}>
      {s.label}
    </span>
  );
}

function LessonStatusBadge({ status, cancelled_by, rescheduled_by }: { status: string; cancelled_by?: string | null; rescheduled_by?: string | null }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    scheduled: { bg: '#EFF6FF', text: '#1D4ED8', label: 'Upcoming' },
    completed: { bg: '#DCFCE7', text: '#15803D', label: 'Completed' },
    cancelled: { bg: '#F3F4F6', text: '#374151', label: 'Cancelled' },
    cancelled_by_student: { bg: '#F3F4F6', text: '#374151', label: 'Cancelled by student' },
    cancelled_by_teacher: { bg: '#F3F4F6', text: '#374151', label: 'Cancelled by teacher' },
    student_no_show: { bg: '#FFF7ED', text: '#C2410C', label: 'Student No-Show' },
    teacher_no_show: { bg: '#FEF2F2', text: '#B91C1C', label: 'Teacher No-Show' },
    missed:    { bg: '#FFF8E8', text: '#B45309', label: 'Missed' },
    flagged:   { bg: '#FFEEE6', text: '#FD5602', label: 'Flagged' },
  };
  const s = map[status] ?? { bg: '#F3F4F6', text: '#374151', label: status };
  const label = getCancellationLabel({ status, cancelled_by, rescheduled_by }, 'admin') ?? s.label;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: s.bg, color: s.text }}>
      {label}
    </span>
  );
}

// ─── List filter persistence ──────────────────────────────────────────────────

// The Status dropdown's options, and with them the set of status values this page is
// willing to restore. One list rather than two: a value read back out of storage is
// accepted only if it is still something the dropdown can display.
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '',          label: 'All Statuses' },
  { value: 'pending',   label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'flagged',   label: 'Flagged' },
  { value: 'reopened',  label: 'Reopened' },
];

// Same contract for the Class Type dropdown. The values are the ones the GET route
// understands as class_status (taken | student_no_show | teacher_no_show).
const CLASS_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '',                label: 'All Class Types' },
  { value: 'taken',           label: 'Class Taken' },
  { value: 'student_no_show', label: 'Student No-Show' },
  { value: 'teacher_no_show', label: 'Teacher No-Show' },
];

// Page-scoped, so each admin list keeps its own record (cf. 'll-admin-classes-filters').
const FILTERS_STORAGE_KEY = 'll-admin-reports-filters';

/**
 * What this page remembers for the rest of the browsing session.
 *
 * NOT the open tab, NOT how many pages of rows had been loaded, and nothing from the
 * export modal: a remembered page 3 is meaningless against a result set that has moved
 * on, and the export dialog is a one-shot form rather than a view of this list.
 *
 * AND NOT THE DATE RANGE, deliberately. The landing default is recomputed server-side on
 * every visit - month-to-date, from the clock at request time - so a stored range could
 * add nothing except the chance of disagreeing with it, and month-to-date can never go
 * stale across a month boundary the way a written-down range would. It also retires the
 * staleness the old preset/from/to split existed to work around: a stored range cannot go
 * stale if there is no stored range. The consequence is intended - a hand-picked range
 * does NOT survive navigation, the admin re-picks it, and every landing in between opens
 * on month-to-date. Client decision, 22 Aug, matching the Classes and Billing lists.
 *
 * Records written BEFORE dates left this key still carry preset/from/to.
 * parseStoredFilters below reads the three fields it knows and ignores the rest rather
 * than rejecting the record, so an admin mid-session keeps the selection they had. That
 * is also why the storage key is deliberately unchanged: there is no incompatible shape
 * to fence off, only three fields nothing reads any more.
 */
interface StoredFilters {
  status:      string;
  teacher:     string;
  classStatus: string;
}

const DEFAULT_STORED_FILTERS: StoredFilters = {
  status:      '',
  teacher:     '',
  classStatus: '',
};

// The five list-filter params, built in ONE place. fetchReports sends them, and the mount
// effect compares them against what the server already rendered to decide whether that
// fetch is worth making at all. Those two must never disagree about what a given filter
// state asks for - which is exactly what a second copy of this if-chain would eventually do,
// the first time a filter is added to one of them and not the other.
//
// Names and order are the GET route's own (status, teacher_id, class_status, date_from,
// date_to; each set only when non-empty). `page` is deliberately NOT here: it is appended
// by the fetch and is not part of what identifies a view.
function buildFilterParams(status: string, teacher: string, classStatus: string, from: string, to: string): string {
  const params = new URLSearchParams();
  if (status)      params.set('status',       status);
  if (teacher)     params.set('teacher_id',   teacher);
  if (classStatus) params.set('class_status', classStatus);
  if (from)        params.set('date_from',    from);
  if (to)          params.set('date_to',      to);
  return params.toString();
}

// ─── Reports List ─────────────────────────────────────────────────────────────

function ReportsList({ initialReports, teachers, initialStatusFilter, initialReopenId, adminTimezone, adminTzRaw, hasUrlFilters, initialTotal, initialDateFrom, initialDateTo, defaultDateFrom, defaultDateTo, seedFreshRef, onTotalsChange }: { initialReports: Report[]; teachers: { id: string; full_name: string }[]; initialStatusFilter: string; initialReopenId?: string; adminTimezone: string; adminTzRaw: string | null; hasUrlFilters: boolean; initialTotal: number | null; initialDateFrom: string; initialDateTo: string; defaultDateFrom: string; defaultDateTo: string; seedFreshRef: React.MutableRefObject<boolean>; onTotalsChange: (pending: number | null, flagged: number | null) => void }) {
  const [reports,       setReports]       = useState<Report[]>(initialReports);
  const [loading,       setLoading]       = useState(false);
  // Separate from `loading`: a Load More fetch must leave the already-rendered table on
  // screen, so it never touches the full-list spinner.
  const [loadingMore,   setLoadingMore]   = useState(false);
  // Separate from `loading` in the other direction: true while a page-1 fetch asking for
  // the view ALREADY on screen is in flight (a retry of the same filters, the post-reopen
  // reload, a return to this tab). The table stays rendered throughout - those rows are
  // still the right rows, merely about to be replaced by fresher copies of themselves - so
  // this flag exists to stop Load More racing that replacement, not to gate the render.
  const [refreshing,    setRefreshing]    = useState(false);
  // Server-reported row count for the CURRENT filters. Seeded from the server render's own
  // exact count for the seeded filter state, so Load More is correct on the very first
  // frame instead of appearing only once the mount fetch lands. null means "not known yet"
  // (a failed seed, or a failed fetch), which keeps the Load More button off screen.
  const [total,         setTotal]         = useState<number | null>(initialTotal);
  const [listError,     setListError]     = useState('');
  // Seeded from the ?reopen= deep link so the confirmation modal is already open on
  // mount; from there it is the same state the in-row Reopen button drives.
  const [reopenId,      setReopenId]      = useState<string | null>(initialReopenId ?? null);
  const [reopenLoading, setReopenLoading] = useState(false);
  const [reopenError,   setReopenError]   = useState('');

  // Advisory only. The recompute that follows a reopen skips invoices already
  // marked paid, so a pay change on a paid month has to be settled by hand - the
  // admin is told that here, before confirming. This check must NEVER disable or
  // delay the confirm button, and a failed lookup shows "could not verify"
  // instead of a false all-clear.
  const [invoiceCheck, setInvoiceCheck] = useState<InvoiceCheck>('loading');
  // Monotonic token: bumped on every open AND every close, so a slow response
  // can never land in a modal that has since been closed or reopened for a
  // different report.
  const invoiceCheckTokenRef = useRef(0);

  const startInvoiceCheck = useCallback((reportId: string) => {
    const token = ++invoiceCheckTokenRef.current;
    setInvoiceCheck('loading');
    fetch(`/api/admin/reports/${reportId}/invoice-status`)
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
  }, []);

  function openReopen(reportId: string) {
    setReopenError('');
    setReopenId(reportId);
    startInvoiceCheck(reportId);
  }

  // Resets to 'loading' so a reopened modal re-fetches rather than flashing the
  // previous report's answer, and invalidates any in-flight response.
  function closeReopen() {
    invoiceCheckTokenRef.current++;
    setInvoiceCheck('loading');
    setReopenId(null);
  }

  // The ?reopen= deep link opens the modal on mount without going through the
  // in-row Reopen button, so the paid-invoice check has to be fired here too.
  // Ref-guarded to the mount-time seed only, mirroring the reopenId useState
  // initialiser above (which likewise only applies initialReopenId once).
  const deepLinkCheckedRef = useRef(false);
  useEffect(() => {
    if (deepLinkCheckedRef.current) return;
    deepLinkCheckedRef.current = true;
    if (initialReopenId) startInvoiceCheck(initialReopenId);
  }, [initialReopenId, startInvoiceCheck]);

  // Seeded from the ?filter= deep link; the mount-time fetchReports effect below
  // then loads the list through the same query path as a manual dropdown pick.
  const [statusFilter,      setStatusFilter]      = useState(initialStatusFilter);
  const [teacherFilter,     setTeacherFilter]     = useState('');
  const [classStatusFilter, setClassStatusFilter] = useState('');
  const [dateFrom,          setDateFrom]          = useState(initialDateFrom);
  const [dateTo,            setDateTo]            = useState(initialDateTo);

  // The record handed to sessionStorage, rebuilt only when a PERSISTED filter moves.
  // Both dates are absent from the deps on purpose: neither is stored any more, so neither
  // should cost a rebuild or a write.
  const persistedFilters = useMemo<StoredFilters>(() => ({
    status:      statusFilter,
    teacher:     teacherFilter,
    classStatus: classStatusFilter,
  }), [statusFilter, teacherFilter, classStatusFilter]);

  /**
   * Shape validation for a decoded stored record. Null rejects the whole record and the
   * page opens on defaults.
   *
   * STRUCTURAL problems reject everything: not an object, or a field of the wrong type - a
   * record written by a different version of this page, or edited by hand, cannot be
   * trusted field by field.
   *
   * DATA DRIFT does not: a teacher who has since left, or a status the dropdown no longer
   * offers, is a well-formed record whose target has moved. Those single fields fall back
   * to "all" instead of throwing the whole record away with them. Left as-is, a teacher id
   * absent from the dropdown would filter the list by an invisible selection - the select
   * would render blank while the fetch quietly narrowed the results.
   *
   * OLD-SHAPE RECORDS PARSE. A record still carrying preset/from/to from before the date
   * range left this key is read for status, teacher and classStatus and nothing else:
   * those three keys are never read, never validated, and never a reason to reject. The
   * next write replaces the record with the current shape, so the migration costs nothing.
   */
  function parseStoredFilters(raw: unknown): StoredFilters | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;

    const status      = record.status;
    const teacher     = record.teacher;
    const classStatus = record.classStatus;
    if (typeof status !== 'string' || typeof teacher !== 'string') return null;
    if (typeof classStatus !== 'string') return null;

    return {
      status:      STATUS_OPTIONS.some((o) => o.value === status) ? status : '',
      teacher:     teachers.some((t) => t.id === teacher) ? teacher : '',
      classStatus: CLASS_STATUS_OPTIONS.some((o) => o.value === classStatus) ? classStatus : '',
    };
  }

  /**
   * Push a restored record into filter state. Runs once, from the hook's mount effect -
   * never during render. loadedPageRef is untouched: a restore only ever happens on mount,
   * and the page-1 fetch it provokes resets that ref itself.
   *
   * Status, teacher and class type ONLY. It must NOT touch dateFrom/dateTo, and that is
   * the whole point of taking dates out of the record: the seeded landing range stays in
   * place under a restore instead of being overwritten a frame later by a range from an
   * earlier visit. In the browser that reads as "teacher/status remembered, dates reset".
   */
  function applyStoredFilters(stored: StoredFilters) {
    setStatusFilter(stored.status);
    setTeacherFilter(stored.teacher);
    setClassStatusFilter(stored.classStatus);
  }

  // RESTORE RACE - already covered by the request token below, deliberately and with no
  // extra guard. The mount fetch fires once from the fetchReports effect with the default
  // filters; the restore lands a frame later, changes the filter state, re-memoises
  // fetchReports and re-runs that effect. Both requests are then in flight, and
  // reportsRequestIdRef makes the newer one win whichever order they return in - which is
  // what that token is for. ClassesListClient documents the same thing about its own.
  //
  // This also runs on a RETURN to the All Reports tab, because the tab switch unmounts
  // ReportsList outright. That is the intended behaviour: the filters survive the round
  // trip instead of snapping back to defaults, exactly as they do across a Back nav.
  const { clear: clearStoredFilters } = useFilterPersistence<StoredFilters>({
    storageKey: FILTERS_STORAGE_KEY,
    value: persistedFilters,
    defaultValue: DEFAULT_STORED_FILTERS,
    skipRestore: hasUrlFilters,
    parse: parseStoredFilters,
    apply: applyStoredFilters,
  });

  // The header badge counts live in the parent. Held in a ref so fetchReports can call it
  // WITHOUT taking it as a dependency: fetchReports is keyed on the five filters and drives
  // the mount effect below, so a callback in those deps would refetch forever.
  const onTotalsChangeRef = useRef(onTotalsChange);
  onTotalsChangeRef.current = onTotalsChange;

  // Monotonic request token. The filter controls stay enabled during a fetch, so a
  // filter change mid-flight fires a second request; without this, a slow earlier
  // response could overwrite the newer list/error, and its loading-off could clear
  // the spinner while the newer request is still in flight.
  const reportsRequestIdRef = useRef(0);

  // Highest page whose rows are actually in `reports`. Load More asks for the next one;
  // any page-1 fetch (filter change, retry, post-reopen refresh) resets it to 1.
  const loadedPageRef = useRef(1);

  // What the SERVER seed asked for: the ?filter= status, plus - on a plain landing - the
  // month-to-date bounds the seed query applied to the embedded lessons.scheduled_at.
  // Teacher and class type are '' by construction: the seed query filters on neither.
  const seededParams = buildFilterParams(initialStatusFilter, '', '', initialDateFrom, initialDateTo);

  // The filter-param string that produced the rows CURRENTLY on screen, seeded from the
  // server render when that seed is usable. null means "unknown" - the seed query failed,
  // or the last fetch did - and forces the honest spinner on the next page-1 fetch rather
  // than a silent refresh over rows nothing can vouch for.
  const displayedParamsRef = useRef<string | null>(initialTotal !== null ? seededParams : null);

  // Returns true only when the list was actually refreshed from the server.
  // page 1 REPLACES the list; page > 1 APPENDS to it (the Load More button).
  const fetchReports = useCallback(async (page = 1) => {
    // Claim the newest request; every post-await write below re-checks this id.
    const requestId = ++reportsRequestIdRef.current;
    // Through the shared builder, so this request and the mount effect's skip test can
    // never describe the same filter state differently.
    const filterParams = buildFilterParams(statusFilter, teacherFilter, classStatusFilter, dateFrom, dateTo);
    // Whether this fetch is about to show the SAME view that is already rendered.
    // Meaningless for page > 1, which appends to that view and touches neither flag.
    const isSameView = filterParams === displayedParamsRef.current;
    if (page === 1) {
      // A same-view refresh keeps the table up; anything else is about to show DIFFERENT
      // rows, and the spinner is the honest signal that what is on screen no longer answers
      // the filters above it. Both flags are set unconditionally, so a superseded request's
      // leftovers cannot survive into this one.
      setLoading(!isSameView);
      setRefreshing(isSameView);
    } else {
      setLoadingMore(true);
    }
    setListError('');
    // page FIRST, then the filter portion - the exact param order this request has always
    // used, so the URL stays byte-identical to the pre-refactor one for every filter state.
    const queryString = filterParams ? `page=${page}&${filterParams}` : `page=${page}`;
    try {
      const res = await fetch(`/api/admin/reports?${queryString}`);
      if (requestId !== reportsRequestIdRef.current) return false;
      if (!res.ok) {
        const message = await errorText(res, 'Could not load reports');
        if (requestId !== reportsRequestIdRef.current) return false;
        setListError(message);
        // Whatever is behind the error banner can no longer be vouched for against the
        // filters above, so the retry shows the spinner instead of a silent refresh.
        displayedParamsRef.current = null;
        return false;
      }
      const data = await res.json();
      if (requestId !== reportsRequestIdRef.current) return false;
      const rows: Report[] = data.reports ?? [];
      if (page === 1) {
        setReports(rows);
      } else {
        // Deduplicated by id: the list is ordered newest-CLASS-first over an offset
        // window, so any reschedule between page fetches shifts rows across the page
        // boundary. A class moved LATER pushes rows down and a later page re-includes
        // rows already on screen - that is what this dedupe absorbs. A class moved
        // EARLIER pulls rows up past the offset and a row can be missed entirely.
        // Accepted rather than fixed: keyset pagination is the only real cure, the
        // window is 50 rows wide, and any refresh reseeds the list correctly.
        setReports((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))]);
      }
      setTotal(typeof data.total === 'number' ? data.total : null);
      loadedPageRef.current = page;
      // The rows now on screen came from these filter params. Recorded behind the same
      // staleness guard as the rows themselves, so a superseded response can never relabel
      // a list it did not produce.
      displayedParamsRef.current = filterParams;
      // Behind the staleness guard above, so a superseded response can never overwrite
      // fresher counts. Nulls are ignored by the parent - last known good number survives.
      onTotalsChangeRef.current(data.pendingTotal ?? null, data.flaggedTotal ?? null);
      return true;
    } catch {
      if (requestId !== reportsRequestIdRef.current) return false;
      setListError('Network error - could not load reports.');
      displayedParamsRef.current = null;
      return false;
    } finally {
      // A superseded request must never turn either page-1 flag off - the newest request
      // set its own pair on the way in and owns them until its own response lands. Both are
      // cleared together: whichever of the two this request turned on is the one it has to
      // turn off, and it is the only request allowed to.
      if (page === 1 && requestId === reportsRequestIdRef.current) { setLoading(false); setRefreshing(false); }
      // loadingMore is cleared UNCONDITIONALLY, staleness token or not: a load-more whose
      // writes the token refused (a filter changed mid-flight) would otherwise leave the
      // button stuck disabled forever. Safe because only one load-more can ever be in
      // flight - the button is disabled while loadingMore - and page-1 fetches use
      // `loading` and never touch this flag.
      if (page > 1) setLoadingMore(false);
    }
  }, [statusFilter, teacherFilter, classStatusFilter, dateFrom, dateTo]);

  // The mount fetch, with ONE skip: the first run after a full page load, when the
  // server-rendered rows already ARE what this fetch would return.
  //
  // (a) This effect's FIRST run always sees the server-seeded filter state. The persistence
  //     restore runs from an earlier effect in the same mount pass, but its setState lands a
  //     render later - so statusFilter is still initialStatusFilter here and the dates are
  //     still initialDateFrom/initialDateTo, with teacher and class type still ''. That is
  //     what makes the comparison against seededParams meaningful.
  // (b) A restore that CHANGES a filter re-memoises fetchReports and re-runs this effect.
  //     seedFreshRef is already false by then, so that run fetches - and with the honest
  //     spinner, because displayedParamsRef still holds the seeded params and cannot match.
  // (c) A restore that restores nothing (or one skipped outright by hasUrlFilters) changes
  //     no state, so React schedules no re-render and there is no second run - and the
  //     seeded rows ARE the correct list, so there is nothing to fetch.
  // (d) initialTotal === null means the seed query FAILED: the empty list on screen means
  //     "error", not "no reports", so the fetch must run and heal it.
  // (e) A tab switch unmounts ReportsList outright; returning re-mounts it with seedFreshRef
  //     already false (the ref lives in the parent, which does not unmount), so tab returns
  //     still refetch for freshness - but as a same-view refresh, which keeps the table on
  //     screen instead of blanking it to the spinner.
  useEffect(() => {
    if (seedFreshRef.current) {
      seedFreshRef.current = false;
      const filterParams = buildFilterParams(statusFilter, teacherFilter, classStatusFilter, dateFrom, dateTo);
      if (initialTotal !== null && filterParams === seededParams) return;
    }
    fetchReports();
  }, [fetchReports, initialTotal, seededParams, seedFreshRef, statusFilter, teacherFilter, classStatusFilter, dateFrom, dateTo]);

  async function handleReopen(reportId: string) {
    setReopenError('');
    setReopenLoading(true);
    try {
      const res = await fetch(`/api/admin/reports/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen' }),
      });
      if (!res.ok) {
        // Keep the modal open so the admin can retry - the report was not reopened.
        setReopenError(await errorText(res, 'Reopen failed'));
        return;
      }
      // Deliberately page 1: the reopened report moves status, so the list is reloaded
      // from the top rather than patched, dropping any extra pages the admin had loaded.
      await fetchReports();
      closeReopen();
    } catch {
      setReopenError('Network error - the report was not reopened. Please try again.');
    } finally {
      setReopenLoading(false);
    }
  }

  return (
    <div>
      {/* Filters. items-end is new alongside the DateRangeFilter swap and is not
          decoration: that component's three items each stack a label above their control
          and so stand taller than the bare selects beside them. Left at the row's default
          align-items:stretch, those selects would stretch to the new height. The Classes
          filter row pins alignItems:'flex-end' for the same reason. */}
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Teachers</option>
          {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
        </select>
        <select value={classStatusFilter} onChange={(e) => setClassStatusFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
          {CLASS_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {/* Date range. The From/To pair plus the timezone-correct quick-range presets; a
            preset reports both halves in ONE onChange, so one click is one render and one
            request. No page reset here (unlike the Classes list, which owns a page state):
            any filter change re-memoises fetchReports, whose effect always refetches page
            1 and resets loadedPageRef with it. */}
        <DateRangeFilter
          from={dateFrom}
          to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t); }}
          tz={adminTzRaw}
        />
        {(statusFilter || teacherFilter || classStatusFilter || dateFrom || dateTo) && (
          // clearStoredFilters() alongside the state resets: "Clear" has to mean cleared
          // for the next visit too, and without it the only thing wiping the key would be
          // the hook noticing the state fell back to its defaults - which it cannot notice
          // when no state actually changed. This button only renders while a filter is
          // set, so that case is unreachable through it today; the call is what keeps the
          // guarantee true if the condition ever changes. ClassesListClient's clearFilters
          // calls it for the same reason.
          //
          // The dates go back to the LANDING DEFAULT, not to all-history: Clear means "as I
          // landed", and landing here means month-to-date. Under a deep link that default
          // differs from what the page actually landed on (?filter= / ?reopen= open with no
          // date bound), exactly as it does on the Classes list. Both props are '' on a
          // timezone-less profile, so Clear empties the two inputs there as it always did.
          <button onClick={() => { setStatusFilter(''); setTeacherFilter(''); setClassStatusFilter(''); setDateFrom(defaultDateFrom); setDateTo(defaultDateTo); clearStoredFilters(); }} className="text-sm font-medium hover:underline" style={{ color: '#FF8303' }}>
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading reports…</div>
      ) : listError ? (
        <div className="py-12 text-center">
          <p className="text-sm font-medium" style={{ color: '#DC2626' }}>{listError}</p>
          <p className="text-xs text-gray-500 mt-1">This list may be out of date - it is not an empty result.</p>
          <button onClick={() => { fetchReports(); }} className="mt-3 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50">
            Try again
          </button>
        </div>
      ) : reports.length === 0 ? (
        <div className="text-sm text-gray-400 py-12 text-center">No reports match these filters.</div>
      ) : (
        <>
          <div className="card-elevated overflow-hidden">
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
                    if (r.status === 'reopened') rowBg = '#FFF7ED';
                    return (
                      <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors" style={rowBg ? { backgroundColor: rowBg } : {}}>
                        <td className="py-3 px-3 text-gray-700">{r.lesson?.scheduled_at ? formatDateTime(r.lesson.scheduled_at, adminTimezone) : '—'}</td>
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
                            : r.status === 'completed' && r.completed_at
                              ? `Submitted ${formatDateTime(r.completed_at, adminTimezone)}`
                              : r.status === 'completed' || r.status === 'reopened'
                                ? '—'
                                : r.deadline_at ? formatDateTime(r.deadline_at, adminTimezone) : '—'}
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <Link href={`/admin/reports/${r.id}`} prefetch={false} className="text-xs font-medium hover:underline" style={{ color: '#FF8303' }}>View</Link>
                            {(r.status === 'flagged' || r.status === 'completed') && (
                              <button onClick={() => openReopen(r.id)} className="text-xs font-medium hover:underline" style={{ color: '#FF8303' }}>Reopen</button>
                            )}
                            {(r.status === 'pending' || r.status === 'reopened') && (
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
          </div>

          {typeof total === 'number' && reports.length < total && (
            <div className="mt-4 text-center">
              <button
                onClick={() => { fetchReports(loadedPageRef.current + 1); }}
                // refreshing too: a silent same-view refresh is in flight, and letting Load
                // More race it would append fresh page-2 rows onto a page-1 set the request
                // token is about to discard.
                disabled={loadingMore || refreshing}
                className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-60"
              >
                {loadingMore ? 'Loading...' : `Load more (${total - reports.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}

      {reopenId && (
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
              <button onClick={() => { setReopenError(''); closeReopen(); }} className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50" disabled={reopenLoading}>Cancel</button>
              <button onClick={() => handleReopen(reopenId)} disabled={reopenLoading} className="px-4 py-2 text-sm text-white rounded-lg font-medium" style={{ backgroundColor: '#FF8303' }}>
                {reopenLoading ? 'Reopening…' : reopenError ? 'Try again' : 'Reopen Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Live Trace ───────────────────────────────────────────────────────────────

function LiveTrace({ adminTimezone }: { adminTimezone: string }) {
  const [lessons,      setLessons]      = useState<TraceLesson[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [traceError,   setTraceError]   = useState('');
  const [refreshing,   setRefreshing]   = useState(false);
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTrace = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/reports/live-trace');
      if (!res.ok) {
        setTraceError(await errorText(res, 'Could not load the class trace'));
        return;
      }
      const data = await res.json();
      setLessons(data.lessons ?? []);
      setTraceError('');
      setLastRefresh(new Date());
    } catch {
      setTraceError('Network error - could not load the class trace.');
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleRefreshNow() {
    setRefreshing(true);
    try {
      await fetchTrace();
    } finally {
      setRefreshing(false);
    }
  }

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
          <button onClick={handleRefreshNow} disabled={refreshing} className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-60">
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>

      {traceError && !loading && (
        <p className="text-sm mb-4" style={{ color: '#DC2626' }}>
          {traceError}{lessons.length > 0 ? ' Showing the last successful load.' : ''}
        </p>
      )}

      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
      ) : traceError && lessons.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-gray-500">The trace could not be loaded - this is not an empty result.</p>
        </div>
      ) : lessons.length === 0 ? (
        <div className="text-sm text-gray-400 py-12 text-center">No classes found.</div>
      ) : (
        <div className="card-elevated overflow-hidden">
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
                    <td className="py-3 px-3 text-gray-700 whitespace-nowrap">{formatDateTime(l.scheduled_at, adminTimezone)}</td>
                    <td className="py-3 px-3 font-medium text-gray-800">{l.teacher?.full_name ?? '—'}</td>
                    <td className="py-3 px-3 text-gray-700">{l.student?.full_name ?? '—'}</td>
                    <td className="py-3 px-3 text-gray-600">{l.duration_minutes} min</td>
                    <td className="py-3 px-3"><LessonStatusBadge status={l.lesson_status} cancelled_by={l.cancelled_by} rescheduled_by={l.rescheduled_by} /></td>
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
        </div>
      )}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function ReportsClient({ initialReports, teachers, students, initialStatusFilter = '', initialReopenId, adminTimezone, adminTzRaw, initialPendingCount, initialFlaggedCount, initialTotal, initialDateFrom, initialDateTo, defaultDateFrom, defaultDateTo, hasUrlFilters = false }: Props) {
  const [activeTab, setActiveTab] = useState<'list' | 'trace'>('list');

  // Owned by the PARENT deliberately. ReportsList unmounts on every tab switch, so a ref
  // declared inside it would read true again on every return to All Reports and skip a
  // fetch the seeded rows can no longer answer for. The skip must apply only to the FIRST
  // mount after a full page load; tab returns must still refetch so the list stays fresh.
  const seedFreshRef = useRef(true);

  // Seeded from the server's global counts, then kept in step with each list fetch. These
  // are the outstanding-work totals, not a count of the rows currently on screen.
  const [pendingCount, setPendingCount] = useState(initialPendingCount);
  const [flaggedCount, setFlaggedCount] = useState(initialFlaggedCount);

  // Empty deps: state setter identities are stable. A null means "count unavailable", so it
  // is ignored and the last known good number stays on the badge rather than dropping to 0.
  const handleTotalsChange = useCallback((pending: number | null, flagged: number | null) => {
    if (pending !== null) setPendingCount(pending);
    if (flagged !== null) setFlaggedCount(flagged);
  }, []);

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
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-1">Class reports submitted by teachers. Flagged reports require your attention.</p>
          {(pendingCount > 0 || flaggedCount > 0) && (
            <div className="flex gap-3 mt-3">
              {pendingCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1 rounded-full" style={{ backgroundColor: '#FFF8E8', color: '#B45309' }}>
                  <span className="font-semibold">{pendingCount}</span> pending
                </span>
              )}
              {flaggedCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1 rounded-full" style={{ backgroundColor: '#FFEEE6', color: '#FD5602' }}>
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

      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-5 py-2 text-sm font-medium transition-colors"
            style={activeTab === tab.id
              ? { backgroundColor: '#FF8303', color: 'white' }
              : { backgroundColor: 'white', color: '#6b7280' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'list'  && <ReportsList initialReports={initialReports} teachers={teachers} initialStatusFilter={initialStatusFilter} initialReopenId={initialReopenId} adminTimezone={adminTimezone} adminTzRaw={adminTzRaw} hasUrlFilters={hasUrlFilters} initialTotal={initialTotal} initialDateFrom={initialDateFrom} initialDateTo={initialDateTo} defaultDateFrom={defaultDateFrom} defaultDateTo={defaultDateTo} seedFreshRef={seedFreshRef} onTotalsChange={handleTotalsChange} />}
      {activeTab === 'trace' && <LiveTrace adminTimezone={adminTimezone} />}

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
                  {/* Option VALUES must byte-match getCancellationLabel's admin output
                      (statusLabel.ts, lowercase actor) — the export route filters rows
                      by exact string equality. Display text stays capitalised. */}
                  <option value="Cancelled by student">Cancelled by Student</option>
                  <option value="Cancelled by teacher">Cancelled by Teacher</option>
                  <option value="Cancelled by admin">Cancelled by Admin</option>
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
