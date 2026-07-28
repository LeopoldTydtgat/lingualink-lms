import { z } from 'zod'

// ─── Admin announcements ──────────────────────────────────────────────────────
// announcements is a server-write table: create / edit / activate / delete all
// arrive through an /api/admin/announcements route that has already proven the
// caller is an admin (requireAdmin) and writes with the service-role client.
// The DB-side admin RLS policy stays as the backstop; these schemas are the
// request-side contract the browser can no longer bypass.

export const ANNOUNCEMENT_AUDIENCES = [
  'all_teachers',
  'all_students',
  'everyone',
  'specific_teacher',
  'specific_student',
] as const

export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number]

// The two person-scoped audiences carry a target_id: profiles.id for a teacher,
// students.id for a student. Every other audience is a broadcast and must not
// carry one — the routes null it out rather than persisting a stale selection.
export function audienceNeedsTarget(audience: string): boolean {
  return audience === 'specific_teacher' || audience === 'specific_student'
}

// announcements.title is NOT NULL. A blank title is rejected here with a usable
// message instead of reaching Postgres as a null and returning an opaque 23502.
const announcementTitle = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, 'Title is required')
  .refine((s) => s.length <= 200, 'Title must be 200 characters or fewer')

const announcementMessage = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, 'Message is required')
  .refine((s) => s.length <= 5000, 'Message must be 5000 characters or fewer')

// start_date / end_date are timestamptz columns. A timezone designator is
// mandatory (Z or ±hh:mm) so the stored instant is never ambiguous; the empty
// string the form sends for "no date" means null, not a validation failure.
const nullableIsoDate = z.preprocess(
  (val) => (val === '' ? null : val),
  z.iso
    .datetime({
      offset: true,
      error: 'Dates must be ISO 8601 with a timezone (e.g. 2026-07-15T00:00:00.000Z)',
    })
    .nullable()
)

const nullableTargetId = z.preprocess(
  (val) => (val === '' ? null : val),
  z.string().uuid('Must be a valid ID').nullable()
)

// ─── Create ───────────────────────────────────────────────────────────────────

export const CreateAnnouncementSchema = z
  .object({
    title: announcementTitle,
    message: announcementMessage,
    target_audience: z.enum(ANNOUNCEMENT_AUDIENCES, {
      error: 'Choose a valid target audience',
    }),
    target_id: nullableTargetId.optional(),
    is_dismissable: z.boolean(),
    is_active: z.boolean(),
    start_date: nullableIsoDate.optional(),
    end_date: nullableIsoDate.optional(),
  })
  .superRefine((val, ctx) => {
    if (audienceNeedsTarget(val.target_audience) && !val.target_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['target_id'],
        message: 'Select the teacher or student this announcement targets',
      })
    }
  })

export type CreateAnnouncementInput = z.infer<typeof CreateAnnouncementSchema>

// ─── Update ───────────────────────────────────────────────────────────────────
// Serves both the full edit form and the one-field activate/deactivate toggle,
// so every field is optional. Zod 4 omits absent optional keys from the parsed
// output, which is what lets the route write ONLY the fields that were sent.

export const UpdateAnnouncementSchema = z
  .object({
    title: announcementTitle.optional(),
    message: announcementMessage.optional(),
    target_audience: z
      .enum(ANNOUNCEMENT_AUDIENCES, { error: 'Choose a valid target audience' })
      .optional(),
    target_id: nullableTargetId.optional(),
    is_dismissable: z.boolean().optional(),
    is_active: z.boolean().optional(),
    start_date: nullableIsoDate.optional(),
    end_date: nullableIsoDate.optional(),
  })
  .superRefine((val, ctx) => {
    if (Object.keys(val).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'No fields to update',
      })
    }
    // Only enforced when the audience itself is part of the request: a lone
    // { is_active } toggle says nothing about targeting and must not be judged
    // against a target_id it never sent.
    if (
      val.target_audience &&
      audienceNeedsTarget(val.target_audience) &&
      !val.target_id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['target_id'],
        message: 'Select the teacher or student this announcement targets',
      })
    }
  })

export type UpdateAnnouncementInput = z.infer<typeof UpdateAnnouncementSchema>
