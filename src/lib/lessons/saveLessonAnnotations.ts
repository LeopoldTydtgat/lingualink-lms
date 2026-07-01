'use server'

import { createClient } from '@/lib/supabase/server'
import { getLiveLessonForTeacher } from '@/lib/lessons/liveLesson'
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
// W2 (no wrong-class writes): the lesson is derived SERVER-SIDE by
// getLiveLessonForTeacher (schedule + clock), never named by the browser. The
// SaveInput type below deliberately has NO lessonId field — the caller cannot
// point the marks at a class even if it wanted to. And updated_at is set in
// code on every write, because lesson_annotations has no DB trigger for it.
// ---------------------------------------------------------------------------

// What the browser sends. Note: NO lessonId — that is W2. The class is resolved
// on the server, not supplied by the caller.
export type SaveAnnotationsInput = {
  studySheetId: string
  attachmentIndex: number
  annotations: Annotation[]
}

// What the client gets back, to drive the four-state banner.
//  - 'saved'        : marks persisted; banner shows "Saving to your <time> class with <name>"
//  - 'no_live_class': nothing saved (prep time / between classes / class ended); banner shows the not-saving state
//  - 'not_saving'   : a live class existed but the write was refused (e.g. raced past the RLS cutoff); banner shows retrying
export type SaveAnnotationsResult =
  | { status: 'saved'; studentName: string; scheduledAt: string; endAt: string }
  | { status: 'no_live_class' }
  | { status: 'not_saving' }

export async function saveLessonAnnotations(
  input: SaveAnnotationsInput
): Promise<SaveAnnotationsResult> {
  // Resolve the live lesson SERVER-SIDE. If none is live, nothing is saved —
  // prep marks correctly do not persist (a mark belongs to a class).
  const live = await getLiveLessonForTeacher()
  if (!live) {
    return { status: 'no_live_class' }
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
      annotationCount: input.annotations.length,
      error,
    })
    return { status: 'not_saving' }
  }

  return {
    status: 'saved',
    studentName: live.studentName,
    scheduledAt: live.scheduledAt,
    endAt: live.endAt,
  }
}
