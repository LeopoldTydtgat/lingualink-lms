import { z } from 'zod'

// ─── Reusable primitives ──────────────────────────────────────────────────────

const uuid = z.string().uuid('Must be a valid ID')
const optionalUuid = z.string().uuid('Must be a valid ID').optional().nullable()

// Accepts YYYY-MM-DD only
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a valid date in YYYY-MM-DD format')
  .optional()
  .nullable()

// Accepts a valid http/https URL or empty string/null
const optionalUrl = z
  .preprocess(
    (val) => (val === '' ? null : val),
    z
      .string()
      .url('Must be a valid URL starting with http:// or https://')
      .optional()
      .nullable()
  )

// Accepts a valid email or empty string/null (used for optional email fields like paypal_email)
const optionalEmail = z
  .preprocess(
    (val) => (val === '' ? null : val),
    z.string().email('Must be a valid email address').optional().nullable()
  )

// ─── Allowed enum values ──────────────────────────────────────────────────────

const ACCOUNT_TYPES = [
  'teacher',
  'teacher_exam',
  'staff',
  'hr_admin',
  'school_admin',
] as const

const PROFILE_STATUS = ['current', 'former', 'on_hold'] as const

const CANCELLATION_POLICY = ['24hr', '48hr'] as const

const CEFR_LEVELS = [
  'A1', 'A1+', 'A2', 'A2+',
  'B1', 'B1+', 'B2', 'B2+',
  'C1', 'C1+', 'C2',
] as const

// ─── Create Teacher ───────────────────────────────────────────────────────────

export const CreateTeacherSchema = z.object({
  // Required account fields
  email: z.string().email('Must be a valid email address'),
  temp_password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  full_name: z.string().min(1, 'Full name is required').max(100, 'Full name must be 100 characters or fewer'),
  timezone: z.string().min(1, 'Timezone is required').max(100),
  account_types: z
    .array(z.enum(ACCOUNT_TYPES))
    .min(1, 'At least one account type is required'),
  status: z.enum(PROFILE_STATUS).default('current'),

  // Admin-only financial fields
  hourly_rate: z.number().positive('Hourly rate must be a positive number').max(10_000).optional().nullable(),
  vat_required: z.boolean().optional().default(false),
  tax_number: z.string().max(100).optional().nullable(),
  iban: z.string().max(50).optional().nullable(),
  bic: z.string().max(20).optional().nullable(),
  paypal_email: optionalEmail,

  // Admin-only HR fields
  contract_start: dateString,
  orientation_date: dateString,
  observed_lesson_date: dateString,
  follow_up_date: dateString,
  follow_up_reason: z.string().max(1000).optional().nullable(),
  admin_notes: z.string().max(10_000).optional().nullable(),

  // Profile/public fields
  bio: z.string().max(2000).optional().nullable(),
  video_url: optionalUrl,
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
  temp_password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  full_name: z.string().min(1, 'Full name is required').max(100, 'Full name must be 100 characters or fewer'),
  timezone: z.string().min(1, 'Timezone is required').max(100),
  status: z.enum(PROFILE_STATUS).default('current'),

  // Required training fields
  total_hours: z
    .number()
    .positive('Total hours must be a positive number')
    .max(500, 'Total hours cannot exceed 500')
    .multipleOf(0.5, 'Hours must be in 0.5-hour increments'),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Training end date must be in YYYY-MM-DD format'),
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
  self_assessed_level: z.enum(CEFR_LEVELS).optional().nullable(),
  learning_goals: z.string().max(2000).optional().nullable(),
  interests: z.string().max(1000).optional().nullable(),

  // Notes
  admin_notes: z.string().max(10_000).optional().nullable(),
  teacher_notes: z.string().max(5000).optional().nullable(),

  // Teacher assignments
  assigned_teacher_ids: z.array(uuid).optional().default([]),
})

export type CreateStudentInput = z.infer<typeof CreateStudentSchema>

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
  // Must be a parseable ISO 8601 datetime
  scheduledAt: z
    .string()
    .min(1, 'scheduledAt is required')
    .refine(
      (val) => !isNaN(Date.parse(val)),
      'scheduledAt must be a valid ISO 8601 datetime'
    ),
  rescheduleId: z.string().uuid('Must be a valid ID').optional().nullable(),
})

export type BookClassInput = z.infer<typeof BookClassSchema>
