import { z } from 'zod'

// ─── Tag vocabulary (NEW345) ──────────────────────────────────────────────────
// tags and sheet_tags are service_role writes only — every mutation arrives
// through an /api/admin route that has already proven the caller is an admin.

// Uniqueness is enforced by unique (name, kind) in the DB
// (20260715120000_new345_library_owner_tags_activities.sql). Names are stored
// trimmed so ' Travel' and 'Travel' cannot both exist and defeat that constraint.
export const TagCreateSchema = z.object({
  name: z
    .string()
    .transform(s => s.trim())
    .refine(s => s.length > 0, 'Tag name is required')
    .refine(s => s.length <= 60, 'Tag name must be 60 characters or fewer'),
  kind: z.enum(['topic', 'skill'], { message: "Kind must be 'topic' or 'skill'" }),
})

// Replaces a sheet's entire tag set. An empty array is a legitimate "clear all"
// instruction, not a malformed body.
export const SheetTagsPutSchema = z.object({
  tag_ids: z.array(z.string().uuid('Must be a valid tag ID')),
})

export type TagCreateInput = z.infer<typeof TagCreateSchema>
export type SheetTagsPutInput = z.infer<typeof SheetTagsPutSchema>
