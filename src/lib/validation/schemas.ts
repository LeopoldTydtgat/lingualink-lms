import { z } from 'zod'

// ─── Reusable primitives ──────────────────────────────────────────────────────

const uuid = z.string().uuid('Must be a valid ID')
const optionalUuid = z.string().uuid('Must be a valid ID').optional().nullable()

// Accepts YYYY-MM-DD or empty string/null (empty string is coerced to null)
const dateString = z.preprocess(
  (val) => (val === '' ? null : val),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a valid date in YYYY-MM-DD format')
    .optional()
    .nullable()
)

// Accepts a valid email or empty string/null (used for optional email fields like paypal_email)
const optionalEmail = z
  .preprocess(
    (val) => (val === '' ? null : val),
    z.string().email('Must be a valid email address').optional().nullable()
  )

// Same '' → null coercion as optionalEmail, with the 320-character ceiling used
// for the companies contact_email / billing_email fields. Kept separate rather
// than widening optionalEmail so the teacher paypal_email rules are untouched.
const optionalCompanyEmail = z
  .preprocess(
    (val) => (val === '' ? null : val),
    z.string().max(320).email('Must be a valid email address').optional().nullable()
  )

// ─── Allowed enum values ──────────────────────────────────────────────────────

const ACCOUNT_TYPES = [
  'teacher',
  'teacher_exam',
  'staff',
] as const

const PROFILE_STATUS = ['current', 'former', 'on_hold'] as const

const CANCELLATION_POLICY = ['24hr', '48hr'] as const

const CEFR_LEVELS = [
  'A1', 'A2',
  'B1', 'B2',
  'C1', 'C2',
] as const

// Mirror the live CHECK constraints on public.companies exactly. A value outside
// these sets must be rejected as a 400 by the company routes before it reaches
// the DB, where it would raise a 23514 and surface as an opaque 500.
const COMPANY_TYPE = ['b2b', 'enterprise', 'partner'] as const

const COMPANY_STATUS = ['active', 'former'] as const

// ─── Create Teacher ───────────────────────────────────────────────────────────

export const CreateTeacherSchema = z.object({
  // Required account fields
  email: z.string().email('Must be a valid email address'),
  full_name: z.string().min(1, 'Full name is required').max(100, 'Full name must be 100 characters or fewer'),
  timezone: z.string().min(1, 'Timezone is required').max(100),
  account_types: z
    .array(z.enum(ACCOUNT_TYPES))
    .min(1, 'At least one account type is required')
    .refine((arr) => arr.includes('teacher'), 'The Teacher account type is required and cannot be removed.'),
  status: z.enum(PROFILE_STATUS).default('current'),

  // Admin-only financial fields
  hourly_rate: z.number().positive('Hourly rate must be a positive number').max(10_000).optional().nullable(),
  currency: z.enum(['EUR', 'GBP', 'USD']).default('EUR').optional(),
  vat_required: z.boolean().optional().default(false),
  tax_number: z.string().max(100).optional().nullable(),
  iban: z.string().max(50).optional().nullable(),
  bic: z.string().max(50).optional().nullable(),
  paypal_email: optionalEmail,
  preferred_payment_type: z.string().max(50).optional().nullable(),

  // Admin-only HR fields
  contract_start: dateString,
  orientation_date: dateString,
  observed_lesson_date: dateString,
  follow_up_date: dateString,
  follow_up_reason: z.string().max(1000).optional().nullable(),
  admin_notes: z.string().max(10_000).optional().nullable(),

  // Profile/public fields
  bio: z.string().max(2000).optional().nullable(),
  qualifications: z.string().max(2000).optional().nullable(),
  street_address: z.string().max(200).optional().nullable(),
  area_code: z.string().max(20).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  native_languages: z.array(z.string().max(100)).optional().default([]),
  teaching_languages: z.array(z.string().max(100)).optional().default([]),
  specialties: z.string().max(1000).optional().nullable(),
  quote: z.string().max(500).optional().nullable(),
  title: z.string().max(10).optional().nullable(),
  gender: z.string().max(50).optional().nullable(),
  nationality: z.string().max(100).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  date_of_birth: dateString,
})

export type CreateTeacherInput = z.infer<typeof CreateTeacherSchema>

// ─── Create Student ───────────────────────────────────────────────────────────

export const CreateStudentSchema = z.object({
  // Required account fields
  email: z.string().email('Must be a valid email address'),
  full_name: z.string().min(1, 'Full name is required').max(100, 'Full name must be 100 characters or fewer'),
  timezone: z.string().min(1, 'Timezone is required').max(100),
  status: z.enum(PROFILE_STATUS).default('current'),

  // Required training fields
  total_hours: z
    .number()
    .positive('Total hours must be a positive number')
    .max(500, 'Total hours cannot exceed 500')
    .multipleOf(0.5, 'Hours must be in 0.5-hour increments'),
  end_date: dateString,
  package_name: z.string().min(1, 'Package name is required').max(100),

  // Optional account fields
  is_private: z.boolean().optional().default(true),
  company_id: optionalUuid,
  academic_advisor_id: optionalUuid,
  customer_number: z.string().max(50).optional().nullable(),
  date_of_birth: dateString,
  phone: z.string().max(30).optional().nullable(),
  language_preference: z.string().max(100).optional().nullable(),
  cancellation_policy: z.enum(CANCELLATION_POLICY).default('24hr'),

  // Learning profile
  native_language: z.string().max(100).optional().nullable(),
  learning_language: z.string().max(100).optional().nullable(),
  current_fluency_level: z.enum(CEFR_LEVELS).optional().nullable(),
  learning_goals: z.string().max(2000).optional().nullable(),
  interests: z.string().max(1000).optional().nullable(),

  // Notes
  admin_notes: z.string().max(10_000).optional().nullable(),
  teacher_notes: z.string().max(5000).optional().nullable(),

  // Teacher assignments
  assigned_teacher_ids: z.array(uuid).optional().default([]),
})

export type CreateStudentInput = z.infer<typeof CreateStudentSchema>

// ─── Create Training ──────────────────────────────────────────────────────────

// Standalone training creation for a student who has NO active training
// (POST /api/admin/students/[id]/trainings). The three training fields mirror
// CreateStudentSchema's training block exactly — same 100-char package name,
// same 500-hour ceiling, same 0.5-hour increments, same YYYY-MM-DD/'' → null
// date handling — so a training created here can never hold a value the
// create-student flow would have rejected.
//
// teacher_ids may legitimately be EMPTY: a training with nobody attached is a
// valid intermediate state (the student simply cannot book until a teacher is
// assigned), so unlike the student PATCH gate there is no min(1) here. The .max
// is a payload cap only — CreateStudentSchema.assigned_teacher_ids carries no
// ceiling, so this mirrors the only array cap convention in this file
// (CreateCompanySchema.tags, max 50). Assignability (role/status) is NOT
// checked here; the route re-validates every id against the same
// role in ('teacher','admin') AND status = 'current' filter the create-student
// route uses.
export const CreateTrainingSchema = z.object({
  package_name: z
    .string()
    .trim()
    .min(1, 'Package name is required')
    .max(100, 'Package name must be 100 characters or fewer'),
  total_hours: z
    .number()
    .positive('Total hours must be a positive number')
    .max(500, 'Total hours cannot exceed 500')
    .multipleOf(0.5, 'Hours must be in 0.5-hour increments'),
  end_date: dateString,
  teacher_ids: z
    .array(uuid)
    .max(50, 'A training cannot have more than 50 assigned teachers')
    .optional()
    .default([]),
})

export type CreateTrainingInput = z.infer<typeof CreateTrainingSchema>

// ─── Update Teacher ───────────────────────────────────────────────────────────

export const UpdateTeacherSchema = z.object({
  full_name: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(100).optional(),
  account_types: z
    .array(z.enum(ACCOUNT_TYPES))
    .min(1)
    .refine((arr) => arr.includes('teacher'), 'The Teacher account type is required and cannot be removed.')
    .optional(),
  status: z.enum(PROFILE_STATUS).optional(),
  teacher_type: z.enum(['teacher', 'teacher_exam']).optional(),
  contract_start: dateString,
  orientation_date: dateString,
  observed_lesson_date: dateString,
  date_of_birth: dateString,
  follow_up_date: dateString,
  title: z.string().max(10).optional().nullable(),
  gender: z.string().max(50).optional().nullable(),
  nationality: z.string().max(100).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  street_address: z.string().max(200).optional().nullable(),
  area_code: z.string().max(20).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  paypal_email: optionalEmail,
  iban: z.string().max(50).optional().nullable(),
  bic: z.string().max(50).optional().nullable(),
  vat_required: z.boolean().optional(),
  tax_number: z.string().max(100).optional().nullable(),
  hourly_rate: z.number().positive().max(10_000).optional().nullable(),
  currency: z.enum(['EUR', 'GBP', 'USD']).optional(),
  native_languages: z.array(z.string().max(100)).optional(),
  teaching_languages: z.array(z.string().max(100)).optional(),
  qualifications: z.string().max(2000).optional().nullable(),
  specialties: z.string().max(1000).optional().nullable(),
  bio: z.string().max(2000).optional().nullable(),
  quote: z.string().max(500).optional().nullable(),
  admin_notes: z.string().max(10_000).optional().nullable(),
  follow_up_reason: z.string().max(1000).optional().nullable(),
  preferred_payment_type: z.string().max(50).optional().nullable(),
})

export type UpdateTeacherInput = z.infer<typeof UpdateTeacherSchema>

// ─── Update Student ───────────────────────────────────────────────────────────

export const UpdateStudentSchema = z.object({
  full_name: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(100).optional(),
  status: z.enum(PROFILE_STATUS).optional(),
  date_of_birth: dateString,
  end_date: dateString,
  phone: z.string().max(30).optional().nullable(),
  language_preference: z.string().max(100).optional().nullable(),
  customer_number: z.string().max(50).optional().nullable(),
  is_private: z.boolean().optional(),
  company_id: optionalUuid,
  academic_advisor_id: optionalUuid,
  training_id: optionalUuid,
  native_language: z.string().max(100).optional().nullable(),
  learning_language: z.string().max(100).optional().nullable(),
  current_fluency_level: z.enum(CEFR_LEVELS).optional().nullable(),
  learning_goals: z.string().max(2000).optional().nullable(),
  interests: z.string().max(1000).optional().nullable(),
  cancellation_policy: z.enum(CANCELLATION_POLICY).optional(),
  admin_notes: z.string().max(10_000).optional().nullable(),
  teacher_notes: z.string().max(5000).optional().nullable(),
  assigned_teacher_ids: z.array(uuid).optional(),
  package_name: z.string().min(1).max(100).optional(),
  total_hours: z.number().positive().max(500).multipleOf(0.5).optional(),
})

export type UpdateStudentInput = z.infer<typeof UpdateStudentSchema>

// ─── Create Company ───────────────────────────────────────────────────────────

// type / status / cancellation_policy are REQUIRED non-nullable enums: the live
// companies CHECK constraints reject anything else, and both DB defaults and the
// old `?? '24hr'` / `?? 'active'` route coalescing hid a bad or missing value
// instead of reporting it. name is trimmed before its length checks, so a
// whitespace-only name fails min(1) exactly as the old !body.name?.trim() did.
export const CreateCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Company name is required')
    .max(200, 'Company name must be 200 characters or fewer'),
  type: z.enum(COMPANY_TYPE),
  cancellation_policy: z.enum(CANCELLATION_POLICY),
  status: z.enum(COMPANY_STATUS),

  contact_name: z.string().max(200).optional().nullable(),
  contact_phone: z.string().max(200).optional().nullable(),
  country: z.string().max(200).optional().nullable(),
  contact_email: optionalCompanyEmail,
  billing_email: optionalCompanyEmail,
  tags: z.array(z.string().max(100)).max(50, 'A company cannot have more than 50 tags').optional(),
  notes: z.string().max(5000).optional().nullable(),
})

export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>

// ─── Update Company ───────────────────────────────────────────────────────────

// Every field optional so a partial PATCH such as { status } stays legal. No
// .default() anywhere: a default would materialise a key the caller never sent,
// and the PATCH route writes exactly the keys present in the parsed result.
// The three enums stay non-nullable — an explicit null is now a 400 rather than
// being silently coalesced to '24hr' / 'active'.
export const UpdateCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Company name is required')
    .max(200, 'Company name must be 200 characters or fewer')
    .optional(),
  type: z.enum(COMPANY_TYPE).optional(),
  cancellation_policy: z.enum(CANCELLATION_POLICY).optional(),
  status: z.enum(COMPANY_STATUS).optional(),

  contact_name: z.string().max(200).optional().nullable(),
  contact_phone: z.string().max(200).optional().nullable(),
  country: z.string().max(200).optional().nullable(),
  contact_email: optionalCompanyEmail,
  billing_email: optionalCompanyEmail,
  tags: z.array(z.string().max(100)).max(50, 'A company cannot have more than 50 tags').optional(),
  notes: z.string().max(5000).optional().nullable(),
})

export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>

// ─── Teacher-authored student notes ────────────────────────────────────────────

export const TeacherNotesSchema = z.object({
  notes: z.string().max(5000),
})

export type TeacherNotesInput = z.infer<typeof TeacherNotesSchema>

// ─── Hours adjustment ─────────────────────────────────────────────────────────

export const HoursAdjustmentSchema = z.object({
  action: z.enum(['add', 'remove'], {
    error: "Action must be 'add' or 'remove'",
  }),
  amount: z
    .number()
    .positive('Amount must be a positive number')
    .max(500, 'Cannot adjust more than 500 hours at once')
    .multipleOf(0.5, 'Hours must be in 0.5-hour increments'),
  training_id: uuid,
  invoice_reference: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

export type HoursAdjustmentInput = z.infer<typeof HoursAdjustmentSchema>

// ─── Book / Reschedule class ──────────────────────────────────────────────────

export const BookClassSchema = z.object({
  trainingId: uuid,
  teacherId: uuid,
  studentId: uuid,
  durationMinutes: z.union(
    [z.literal(30), z.literal(60), z.literal(90)],
    { error: 'Duration must be 30, 60, or 90 minutes' }
  ),
  // UTC ISO 8601 with Z suffix — no bare-local, no offset. Only caller sends toISOString() output.
  scheduledAt: z.iso.datetime({
    error: 'scheduledAt must be a UTC ISO 8601 datetime (e.g. 2026-07-15T14:00:00.000Z)',
  }),
  rescheduleId: z.string().uuid('Must be a valid ID').optional().nullable(),
})

export type BookClassInput = z.infer<typeof BookClassSchema>

// ─── Teacher availability ─────────────────────────────────────────────────────

const HHMM = /^\d{2}:\d{2}(:\d{2})?$/
const isoDateTime = z
  .string()
  .min(1)
  .refine((val) => !isNaN(Date.parse(val)), 'Must be a valid ISO 8601 datetime')

export const TeacherAvailabilitySchema = z.object({
  teacher_id: uuid,
  type: z.enum(['general', 'specific', 'holiday']),
  // recurring rows have day_of_week + start_time/end_time
  day_of_week: z.number().int().min(0).max(6).optional().nullable(),
  start_time: z
    .string()
    .regex(HHMM, 'start_time must be HH:mm or HH:mm:ss')
    .optional()
    .nullable(),
  end_time: z
    .string()
    .regex(HHMM, 'end_time must be HH:mm or HH:mm:ss')
    .optional()
    .nullable(),
  // override rows have start_at + end_at as ISO timestamps
  start_at: isoDateTime.optional().nullable(),
  end_at: isoDateTime.optional().nullable(),
  is_available: z.boolean(),
})
  // Holidays are unavailability by definition, and nothing downstream enforces
  // that. Both add-override paths, src/app/api/student/availability/slotEngine.ts
  // and src/lib/availability.ts, select overrides on is_available alone with no
  // type filter, while their holiday-blocking passes require !is_available. So a
  // holiday row stored as available skips blocking AND mints a full day of
  // bookable slots. This schema is the only gate.
  .refine((val) => !(val.type === 'holiday' && val.is_available), {
    error: 'Holiday periods cannot be marked available',
    path: ['is_available'],
  })

export type TeacherAvailabilityInput = z.infer<typeof TeacherAvailabilitySchema>

// ─── Submit Report ────────────────────────────────────────────────────────────

export const SubmitReportSchema = z
  .object({
    did_class_happen: z.boolean(),
    no_show_type: z.enum(['student', 'teacher']).nullable(),
    feedback_text: z.string().max(1000).nullable(),
    additional_details: z.string().max(2000).nullable(),
    level_data: z.record(z.string(), z.string()).nullable(),
    student_confirmed: z.boolean().nullable(),
    impersonation_note: z.string().max(2000).nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.did_class_happen) {
      if (!val.feedback_text || val.feedback_text.trim().length < 150) {
        ctx.addIssue({
          code: 'custom',
          path: ['feedback_text'],
          message: 'Feedback must be at least 150 characters when the class took place',
        })
      }
      if (val.student_confirmed === false && (!val.impersonation_note || !val.impersonation_note.trim())) {
        ctx.addIssue({
          code: 'custom',
          path: ['impersonation_note'],
          message: 'A note is required when the student did not personally attend',
        })
      }
    } else {
      if (!val.no_show_type) {
        ctx.addIssue({
          code: 'custom',
          path: ['no_show_type'],
          message: "no_show_type must be 'student' or 'teacher' when the class did not happen",
        })
      }
      if (!val.additional_details || !val.additional_details.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['additional_details'],
          message: 'Additional details are required when the class did not happen',
        })
      }
    }
  })

export type SubmitReportInput = z.infer<typeof SubmitReportSchema>

// ─── Admin classes PATCH ──────────────────────────────────────────────────────

export const adminClassesPatchEditSchema = z.object({
  action: z.literal('edit'),
  scheduled_at: z.string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
      'scheduled_at must be naive local ISO format YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS, no timezone suffix'
    )
    .refine(
      val => !isNaN(Date.parse(val + 'Z')),
      { message: 'scheduled_at has invalid date components' }
    )
    .optional(),
  teacher_id: z.string().uuid().optional(),
  duration_minutes: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
}).refine(
  data =>
    data.scheduled_at !== undefined ||
    data.teacher_id !== undefined ||
    data.duration_minutes !== undefined,
  { message: 'At least one of scheduled_at, teacher_id, or duration_minutes must be provided for an edit action' }
);

export const adminClassesPatchCancelSchema = z.object({
  action: z.literal('cancel'),
  cancellation_reason: z.string().min(1).max(500),
  refund_hours: z.boolean(),
});

export const adminClassesPatchSchema = z.discriminatedUnion('action', [
  adminClassesPatchEditSchema,
  adminClassesPatchCancelSchema,
]);

// ─── Admin classes POST (manual create) ───────────────────────────────────────

export const adminClassesPostSchema = z.object({
  teacher_id: z.string().uuid(),
  student_id: z.string().uuid(),
  training_id: z.string().uuid(),
  duration_minutes: z.union([z.literal(30), z.literal(60), z.literal(90)]),
  scheduled_at: z.string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
      'scheduled_at must be naive local ISO format YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS, no timezone suffix'
    )
    .refine(
      val => !isNaN(Date.parse(val + 'Z')),
      { message: 'scheduled_at has invalid date components' }
    ),
});

// ─── Join-class click log ─────────────────────────────────────────────────────

export const JoinClickSchema = z.object({
  lesson_id: z.string().uuid(),
})

export type JoinClickInput = z.infer<typeof JoinClickSchema>

// --- Teaching-material homework grant (material_assignments) ------------------
//
// Body of POST /api/teacher/material-assignments. The page-range rules MIRROR
// the live CHECK constraint material_assignments_page_range:
//
//   (page_start is null and page_end is null)
//   or (page_start >= 1 and page_end >= page_start)
//
// They are duplicated here on purpose: a half-filled or inverted range must come
// back as a readable 422 for the teacher, not as an opaque 23514 from Postgres.
// The DB constraint remains the authority - this schema only front-runs it.
export const MaterialAssignmentCreateSchema = z
  .object({
    student_id: uuid,
    study_sheet_id: uuid,
    attachment_index: z
      .number()
      .int()
      .min(0, 'Choose a file from this sheet'),
    page_start: z
      .number()
      .int()
      .min(1, 'The first page must be 1 or higher')
      .optional()
      .nullable(),
    page_end: z
      .number()
      .int()
      .min(1, 'The last page must be 1 or higher')
      .optional()
      .nullable(),
  })
  .superRefine((val, ctx) => {
    const hasStart = val.page_start !== null && val.page_start !== undefined
    const hasEnd = val.page_end !== null && val.page_end !== undefined

    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: 'custom',
        path: ['page_end'],
        message: 'Give both a first and a last page, or leave both empty for the whole document',
      })
      return
    }

    if (hasStart && hasEnd && (val.page_end as number) < (val.page_start as number)) {
      ctx.addIssue({
        code: 'custom',
        path: ['page_end'],
        message: 'The last page cannot come before the first page',
      })
    }
  })

export type MaterialAssignmentCreateInput = z.infer<typeof MaterialAssignmentCreateSchema>
