'use server'

import { createClient } from '@/lib/supabase/server'
import { getLiveLessonForTeacher, getAttributionLessonIdForTeacher } from '@/lib/lessons/liveLesson'
import type { Annotation } from '@/components/pdf/PdfViewer'

// ---------------------------------------------------------------------------
// Teacher annotation autosave (Milestone 4, Piece B, commit 2).
//
// The client calls this whenever a teacher's PDF marks change (debounced).
// It attaches those marks to whichever lesson is LIVE right now and upserts
// them into lesson_annotations.
//
// W1 (RLS must stay in force): every DB call here uses the USER-SCOPED client
// (createClient from server.ts), NEVER createAdminClient(). The service-role
// client bypasses RLS, which would make the ownership + cutoff gate on
// lesson_annotations decorative. The RLS policy is the hard gate on this write;
// this action must run under it. (Same bug class as the old PDF-proxy leak.)
//
// W2 (no wrong-class writes): the lesson WRITTEN TO is derived SERVER-SIDE by
// getLiveLessonForTeacher (schedule + clock), never named by the browser. The
// SaveAnnotationsInput type below has no field that can select a class: its one lesson-shaped
// field, seedLessonId, is compared for equality and can only REFUSE the write (see
// the guard in the body) — a caller cannot point marks at a class even if it wanted
// to, and a forged value only blocks its own save. And updated_at is set in code on
// every write, because lesson_annotations has no DB trigger for it.
// ---------------------------------------------------------------------------

// What the browser sends. Note: no field that NAMES the target class — that is W2.
// The class written to is resolved on the server; the one lesson id the caller does
// send (seedLessonId) is a refuse-only equality guard, never a destination.
export type SaveAnnotationsInput = {
  studySheetId: string
  attachmentIndex: number
  attachmentName: string
  annotations: Annotation[]
  // The lesson the client's in-memory marks BELONG TO: the lesson it seeded from
  // at mount, or — once any save has landed — the lesson that save wrote to (the
  // client tracks this itself from the lessonId returned on 'saved', or from the
  // attributionLessonId returned on 'no_live_class' when a class is in progress but
  // not writable). null while a tab has both seeded nothing and learned nothing.
  //
  // That second source is what keeps null honest. Arming only on a SUCCESSFUL save
  // left a real hole: file a report mid-class and the lesson leaves 'scheduled', so
  // every save for the rest of the hour is refused, the tab never learns which class
  // it was in, and the next class accepted the lot. Attribution arms the guard even
  // when nothing can be written, so null now really does mean "this tab has never
  // been in a class" — the one exception being a DB fault in the attribution query,
  // which logs and falls back to permissive.
  //
  // EQUALITY GUARD ONLY: this field can only BLOCK a write, never select a lesson
  // — the class written to is still resolved server-side by getLiveLessonForTeacher
  // below, so W2 holds. A caller sending a made-up id cannot redirect marks onto
  // another class; the worst it can do is refuse its own save.
  seedLessonId: string | null
}

// What the client gets back, to drive the four-state banner.
//  - 'saved'        : marks persisted; banner shows "Saving to your <time> class with <name>". Carries the lessonId written to, which the client keeps as the guard value for its next save (see seedLessonId above) — that is what stops a long-open tab from drifting onto the next class.
//  - 'no_live_class': nothing saved (prep time / between classes / class ended or already reported); the client renders NOTHING for this — it is the common case and a badge here was a permanent false alarm (NEW253)
//  - 'not_saving'   : a live class existed but the write was refused (e.g. raced past the RLS cutoff); client shows the amber warning. Carries lessonId for the same reason 'saved' does — a refused write still identifies the class
//  - 'stale_lesson' : nothing saved; the live class has changed since this page seeded its marks (see the guard below); banner tells the teacher to reload
export type SaveAnnotationsResult =
  | { status: 'saved'; lessonId: string; studentName: string; scheduledAt: string; endAt: string }
  | { status: 'no_live_class'; attributionLessonId: string | null }
  | { status: 'not_saving'; lessonId: string }
  | { status: 'stale_lesson' }

export async function saveLessonAnnotations(
  input: SaveAnnotationsInput
): Promise<SaveAnnotationsResult> {
  // Resolve the live lesson SERVER-SIDE. If none is live, nothing is saved —
  // prep marks correctly do not persist (a mark belongs to a class).
  const live = await getLiveLessonForTeacher()
  if (!live) {
    // Nothing is writable right now, so nothing is saved. Still tell the client WHICH
    // class it is sitting in, if any: a lesson whose report has already been filed is
    // no longer 'scheduled' and so is not writable, but marks drawn during it are
    // unmistakably that class's. Without this the client's guard would stay null for
    // the rest of the hour and hand the whole array to the NEXT class. Attribution
    // only — the resolver's note explains why this can never widen what is writable.
    //
    // Only ASK when the caller's guard is null. The client arms on attributionLessonId
    // solely under `guardLessonId === null`, so a tab that already sent a non-null
    // guard discards this value unconditionally — running the query for it is a DB
    // round-trip per debounce (prep time, between classes) whose result is thrown
    // away. Skipping it is behaviour-identical: returning null here can only leave a
    // guard UNARMED, never clear an armed one, so nothing about the write path
    // widens — the write target is still resolved from `live` alone.
    return { status: 'no_live_class', attributionLessonId: input.seedLessonId === null ? await getAttributionLessonIdForTeacher() : null }
  }

  // Cross-lesson bleed guard. A tab left open across a lesson change still holds
  // the PREVIOUS class's marks in the viewer: the seed is only re-applied when
  // the document (fileUrl) changes, and that URL is the study sheet's own
  // attachment path — it does not change when the clock rolls into the next
  // class. So the first stroke after lesson B starts would carry lesson A's whole
  // array and upsert it onto B's row. Refuse instead, and let the badge tell the
  // teacher to reload (which re-seeds from B's own row).
  //
  // The client's value tracks where its marks ACTUALLY live (last successful save,
  // else its mount-time seed) — NOT wherever the page most recently resolved a
  // live class. That distinction is the whole guard: a teacher who opens the sheet
  // during prep (seed null), teaches A, then rolls into B must be refused at B,
  // even though this page load never named A.
  //
  // null is allowed through so the ordinary prep flow keeps working: a teacher opens
  // the sheet before class, marks it up, and those marks must land in the class that
  // then starts. What makes that safe rather than merely convenient is that the
  // client now learns a lesson id from ANY save attempt made inside a class — see
  // attributionLessonId on the no-live-class result — so "drawn before any class"
  // and "drawn during a class that refused the write" are no longer the same state.
  if (input.seedLessonId !== null && input.seedLessonId !== live.lessonId) {
    return { status: 'stale_lesson' }
  }

  const supabase = await createClient()

  // Upsert on the unique key (lesson_id, study_sheet_id, attachment_index).
  // W1: user-scoped client, so RLS re-checks teacher ownership AND the deadline
  // on this exact write — if the teacher is not the class's teacher, or the
  // grace window has closed, the DB rejects it (no row returned).
  // W2: updated_at set in code (no DB trigger exists).
  const { data, error } = await supabase
    .from('lesson_annotations')
    .upsert(
      {
        lesson_id: live.lessonId,
        study_sheet_id: input.studySheetId,
        attachment_index: input.attachmentIndex,
        attachment_name: input.attachmentName,
        annotations: input.annotations,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'lesson_id,study_sheet_id,attachment_index' }
    )
    .select('id')
    .maybeSingle()

  // No row back (RLS refused the write, or a race past the cutoff) OR a DB
  // error: report not-saving so the banner flips to retrying — never silent.
  if (error || !data) {
    // Observability: a refused write (past-cutoff race) and a real defect
    // (grant regression, schema drift, network fault) both land here. Log the
    // failure + context so a genuine fault is visible in server/Sentry logs
    // instead of a silent, perpetual "retrying" banner. NEVER log annotation
    // CONTENT (user data, potentially large) - only its length.
    console.error('[saveLessonAnnotations] upsert refused or failed', {
      lessonId: live.lessonId,
      studySheetId: input.studySheetId,
      attachmentIndex: input.attachmentIndex,
      attachmentName: input.attachmentName,
      annotationCount: input.annotations.length,
      error,
    })
    // Carry the lesson even though nothing was written: the guard passed to get
    // here, so this IS the class the marks belong to. Without it a run of failures
    // during a class leaves the client's guard null, and once the fault clears the
    // next class accepts the whole array — the same bleed, entered through the
    // failure path instead of the report path.
    return { status: 'not_saving', lessonId: live.lessonId }
  }

  return {
    status: 'saved',
    // The class these marks are now committed to. The client holds on to this and
    // sends it back as seedLessonId on every later save from the same tab, so the
    // guard above tracks where the marks ACTUALLY live rather than where the page
    // happened to seed them. Not a secret: it is the teacher's own live lesson, a
    // row they can already read under RLS (a prep-opened tab seeds null, so this
    // may well be an id that page load did not carry).
    lessonId: live.lessonId,
    studentName: live.studentName,
    scheduledAt: live.scheduledAt,
    endAt: live.endAt,
  }
}
