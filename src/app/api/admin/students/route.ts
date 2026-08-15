import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { NextRequest, NextResponse } from 'next/server'
import resend from '@/lib/email/client'
import { CreateStudentSchema } from '@/lib/validation/schemas'
import { buildEmailTemplate, buildDetailsTable, buildButton } from '@/lib/email/templates'
import { generateThrowawayPassword, sendAccountInviteEmail } from '@/lib/auth/inviteEmail'

// ─── GET – list students (supports ?minimal=true&search=name) ─────────────────
export async function GET(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    }
  )

  // Gate via the shared canonical rule; `supabase` (the RLS-bound client
  // above) stays for the student list query below.
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const minimal = searchParams.get('minimal') === 'true'
  const search = searchParams.get('search') ?? ''

  let query = supabase
    .from('students')
    .select(minimal ? 'id, full_name' : 'id, full_name, email, status, company_id, photo_url')
    .order('full_name')

  if (search) {
    query = query.ilike('full_name', `%${search}%`)
  }

  if (minimal) query = query.limit(50)

  const { data: students, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ students: students ?? [] })
}

// ─── POST – create student ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    // ── 1. Verify the requesting user is an admin ────────────────────────────
    // Auth runs BEFORE the body is read: an unauthorised caller must get a bare
    // 401 and never a Zod validation message describing the schema.
    const user = await requireAdmin()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── 2. Parse and validate input ──────────────────────────────────────────
    // The parse gets its own catch: malformed JSON is a client error, and
    // letting it reach the outer catch returned a 500 for a bad request.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const parsed = CreateStudentSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json({ error: firstError.message }, { status: 400 })
    }
    const data = parsed.data

    // auth stores emails lowercased and both guard lookups below use .eq, so normalise once and use this everywhere.
    const email = data.email.toLowerCase()

    // ── Cross-role email guard: reject if a teacher already uses this email ──
    const guardClient = createAdminClient()
    const { data: existingTeacher, error: existingTeacherError } = await guardClient
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    // A failed read is not "no teacher holds this email": leaving it
    // undestructured let a lookup error pass the guard entirely. Fail loud.
    if (existingTeacherError) {
      console.error('Cross-role email guard error (student POST):', existingTeacherError)
      return NextResponse.json(
        { error: 'Failed to verify the email address.' },
        { status: 500 }
      )
    }
    if (existingTeacher) {
      return NextResponse.json(
        { error: 'This email is already in use by a teacher account. Each email can only belong to one role.' },
        { status: 409 }
      )
    }

    // ── Same-role email guard: reject if a student already uses this email ───
    // Pre-empts the generic 500 the UNIQUE students.email constraint would
    // otherwise produce at the insert, and surfaces historic orphans (rows with
    // null auth_user_id) as an actionable message. The UNIQUE constraint remains
    // the actual enforcement; this guard is for error quality, and the race
    // window between guard and insert is acceptable because the insert branch
    // still rolls back correctly.
    const { data: existingStudent, error: existingStudentError } = await guardClient
      .from('students')
      .select('id, auth_user_id')
      .eq('email', email)
      .maybeSingle()
    if (existingStudentError) {
      console.error('Student email guard error (student POST):', existingStudentError)
      return NextResponse.json(
        { error: 'Failed to verify the email address.' },
        { status: 500 }
      )
    }
    if (existingStudent && !existingStudent.auth_user_id) {
      return NextResponse.json(
        {
          error:
            'This email belongs to a partially created student account with no login. Delete that student record first, then create the account again.',
        },
        { status: 409 }
      )
    }
    if (existingStudent) {
      return NextResponse.json(
        { error: 'This email is already in use by another student account.' },
        { status: 409 }
      )
    }

    const adminClient = createAdminClient()

    // ── 2a. Validate the submitted teacher assignments ───────────────────────
    // Deduped because the body could repeat an id, which would double-insert
    // the join row below (or trip its (training_id, teacher_id) PK).
    // Lowercased because z.string().uuid() accepts uppercase while Postgres
    // returns lowercase: without normalising, a mixed-case pair survives the
    // dedupe and the allowed-set comparison below can 400 a teacher that is
    // genuinely assignable. Computed once here and used for EVERY downstream
    // consumer — the join-row insert and the notification lookup — so the ids
    // that were validated are exactly the ids that get used.
    const submittedTeacherIds = [
      ...new Set(data.assigned_teacher_ids.map((tid: string) => tid.toLowerCase())),
    ]

    // assigned_teacher_ids is raw client input and training_teachers is the
    // messaging/access junction, so an unvalidated uuid here would hand an
    // arbitrary profile — a student, an archived teacher — a live access edge
    // to this student. The allowed set mirrors the create form's teachers query
    // (src/app/(admin)/admin/students/new/page.tsx:31-36 —
    // role in ('teacher','admin') AND status = 'current'). That filter is the
    // canonical definition of an assignable teacher; this gate must not diverge
    // from it, or the form offers picks the route rejects.
    //
    // Unlike the PATCH gate (src/app/api/admin/students/[id]/route.ts:140-184)
    // there is NO union with ids already on the training: the training does not
    // exist yet, so there is nothing to grandfather in and no archived-profile
    // backfill to honour. Half A only.
    //
    // Placed ahead of the FIRST mutation in this handler — before the auth
    // user, the students row and the training — so a rejected request creates
    // nothing at all and needs no rollback.
    if (submittedTeacherIds.length > 0) {
      const { data: assignable, error: assignableError } = await adminClient
        .from('profiles')
        .select('id')
        .in('id', submittedTeacherIds)
        .in('role', ['teacher', 'admin'])
        .eq('status', 'current')

      // A failed read is neither "none of these are assignable" (which would
      // 400 a legitimate create) nor "all of them are" (which would re-open the
      // hole). Fail loud.
      if (assignableError || !assignable) {
        console.error('Assignable-teacher lookup error (student POST):', assignableError)
        return NextResponse.json(
          { error: 'Failed to verify the selected teachers.' },
          { status: 500 }
        )
      }

      const allowedTeacherIds = new Set<string>(
        (assignable as { id: string }[]).map((p) => p.id)
      )

      if (submittedTeacherIds.some((tid) => !allowedTeacherIds.has(tid))) {
        return NextResponse.json(
          { error: 'One or more selected teachers are not assignable.' },
          { status: 400 }
        )
      }
    }

    // ── 3. Create the Supabase auth user using the service role key ──────────

    // Throwaway password — never returned or logged. The student sets their
    // own password via the invite email sent after all inserts succeed.
    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password: generateThrowawayPassword(),
      email_confirm: true,
    })

    if (createError || !newUser.user) {
      console.error('Auth user creation error:', createError)
      return NextResponse.json(
        { error: createError?.message || 'Failed to create auth user.' },
        { status: 400 }
      )
    }

    const newUserId = newUser.user.id

    // ── 4. Insert the student row ────────────────────────────────────────────
    // .insert(), not .upsert(): the payload carries no id, and PostgREST
    // defaults the conflict target to the primary key, so the upsert could
    // never match an existing row — it bought nothing while leaving a merge
    // path open if a conflict target were ever added. A duplicate email must
    // ERROR here so the auth user created above is rolled back, which the
    // failure branch below already does.
    const { data: studentRow, error: studentError } = await adminClient
      .from('students')
      .insert({
        auth_user_id: newUserId,
        full_name: data.full_name,
        email,
        timezone: data.timezone,
        language_preference: data.language_preference ?? null,
        status: data.status,
        is_private: data.is_private ?? true,
        profile_completed: false,
        company_id: data.company_id ?? null,
        academic_advisor_id: data.academic_advisor_id ?? null,
        customer_number: data.customer_number ?? null,
        date_of_birth: data.date_of_birth ?? null,
        phone: data.phone ?? null,
        native_language: data.native_language ?? null,
        learning_language: data.learning_language ?? null,
        current_fluency_level: data.current_fluency_level ?? null,
        learning_goals: data.learning_goals ?? null,
        interests: data.interests ?? null,
        cancellation_policy: data.cancellation_policy,
        allowed_durations: data.allowed_durations,
        admin_notes: data.admin_notes ?? null,
        teacher_notes: data.teacher_notes ?? null,
      })
      .select('id')
      .single()

    // ── Rollback ordering rule (applies to EVERY failure branch below) ───────
    // Never delete the auth user until the students row is confirmed gone:
    // students.auth_user_id is ON DELETE SET NULL, so a students row that
    // survives a failed delete would be left orphaned with a null auth_user_id
    // while still holding the UNIQUE email, permanently blocking every later
    // create for that address at the students insert.
    if (studentError || !studentRow) {
      console.error('Student row error:', studentError)

      // Nothing to confirm gone on this branch — the students insert is what
      // failed — so the auth user can be removed straight away.
      const { error: authRollbackError } = await adminClient.auth.admin.deleteUser(newUserId)
      if (authRollbackError) {
        console.error('auth user rollback error (student POST):', authRollbackError)
      }

      return NextResponse.json(
        { error: 'Failed to create student record.' },
        { status: 500 }
      )
    }

    const studentId = studentRow.id

    // ── 5. Create the training record ────────────────────────────────────────
    const { data: trainingRow, error: trainingError } = await adminClient
      .from('trainings')
      .insert({
        student_id: studentId,
        package_name: data.package_name,
        package_type: data.package_name,
        total_hours: data.total_hours,
        hours_consumed: 0,
        end_date: data.end_date ?? null,
        status: 'active',
        low_hours_warning_sent: false,
      })
      .select('id')
      .single()

    if (trainingError || !trainingRow) {
      console.error('Training insert error:', trainingError)

      // Deleting the students row also unwinds any trainings row
      // (trainings.student_id → students is ON DELETE CASCADE).
      const { error: studentRollbackError } = await adminClient
        .from('students')
        .delete()
        .eq('id', studentId)

      if (studentRollbackError) {
        // The students row survived and still holds the UNIQUE email. Deleting
        // the auth user now would only orphan it (SET NULL) and lock the email
        // out for good, so leave the pair intact and tell the admin.
        console.error('student rollback error (student POST):', studentRollbackError)
        return NextResponse.json(
          {
            error:
              'Failed to create the training record, and cleanup of the partial student account also failed. Do not retry with this email - the partial account must be removed first.',
          },
          { status: 500 }
        )
      }

      // Students row confirmed gone — safe to remove the auth user. A stranded
      // auth user fails loudly at the next createUser, so a logged failure here
      // does not change the response.
      const { error: authRollbackError } = await adminClient.auth.admin.deleteUser(newUserId)
      if (authRollbackError) {
        console.error('auth user rollback error (student POST):', authRollbackError)
      }

      return NextResponse.json(
        { error: 'Failed to create training record.' },
        { status: 500 }
      )
    }

    const trainingId = trainingRow.id

    // ── 6. Insert training_teachers rows ─────────────────────────────────────
    // Every id reaching this insert already cleared the assignability gate in
    // step 2a.
    if (submittedTeacherIds.length > 0) {
      const ttRows = submittedTeacherIds.map((teacherId: string) => ({
        training_id: trainingId,
        teacher_id: teacherId,
      }))
      const { error: ttError } = await adminClient
        .from('training_teachers')
        .insert(ttRows)

      // A student created with none of their teachers attached is NOT a partial
      // success: training_teachers is the access/messaging junction, so every
      // assigned teacher would be unable to see or message the student, and the
      // notification below would announce an assignment that does not exist.
      // The insert is a single multi-row statement, so one bad row drops them
      // all. Roll the create back and fail loud — every rollback error is logged
      // so a stranded row is traceable, and the auth user is only touched once
      // the students row is confirmed gone (see the rule at step 4).
      if (ttError) {
        console.error('training_teachers insert error:', ttError)

        // One delete unwinds all three rows: trainings.student_id → students and
        // training_teachers.training_id → trainings are both ON DELETE CASCADE.
        const { error: studentRollbackError } = await adminClient
          .from('students')
          .delete()
          .eq('id', studentId)

        if (studentRollbackError) {
          // Same as step 5: the surviving students row still holds the UNIQUE
          // email, so the auth user stays put rather than orphaning it.
          console.error('student rollback error (student POST):', studentRollbackError)
          return NextResponse.json(
            {
              error:
                'Failed to assign teachers to the new student, and cleanup of the partial student account also failed. Do not retry with this email - the partial account must be removed first.',
            },
            { status: 500 }
          )
        }

        const { error: authRollbackError } = await adminClient.auth.admin.deleteUser(newUserId)
        if (authRollbackError) {
          console.error('auth user rollback error (student POST):', authRollbackError)
        }

        return NextResponse.json(
          { error: 'Failed to assign teachers to the new student. The student was not created.' },
          { status: 500 }
        )
      }
    }

    // ── 6a. Notify assigned teachers ─────────────────────────────────────────
    if (submittedTeacherIds.length > 0) {
      const { data: teacherProfiles } = await adminClient
        .from('profiles')
        .select('id, full_name, email')
        .in('id', submittedTeacherIds)

      if (teacherProfiles && teacherProfiles.length > 0) {
        const endDateLabel = data.end_date
          ? new Intl.DateTimeFormat('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(data.end_date))
          : 'No end date'

        const teacherEmailBody = `
          <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
            A new student has been assigned to you on the Lingualink Online portal.
          </p>
          ${buildDetailsTable('Student details', [
            { label: 'Student', value: data.full_name },
            { label: 'Package', value: data.package_name },
            { label: 'End Date', value: endDateLabel },
          ])}
          ${buildButton(`${process.env.NEXT_PUBLIC_TEACHER_URL}/students`, 'View Student Profile')}
        `

        try {
          await Promise.allSettled(
            teacherProfiles.map((teacher: { id: string; full_name: string; email: string }) =>
              resend.emails.send({
                from: 'Lingualink Online <no-reply@lingualinkonline.com>',
                to: teacher.email,
                subject: 'Lingualink Online - You have been assigned a new student',
                html: buildEmailTemplate({
                  recipientName: teacher.full_name,
                  recipientFallback: 'Teacher',
                  subject: 'Lingualink Online - You have been assigned a new student',
                  bodyHtml: teacherEmailBody,
                  contactEmail: 'teachers@lingualinkonline.com',
                }),
              })
            )
          )
        } catch (emailErr) {
          console.error('Teacher assignment email error:', emailErr)
        }
      }
    }

    // ── 7. Send the account invite email (best-effort) ──────────────────────
    // Never rolls anything back and never fails the request — the admin is
    // told via inviteEmailSent so they can point the student at
    // "Forgot password" if the email did not go out.
    const { sent: inviteEmailSent } = await sendAccountInviteEmail(
      adminClient,
      email,
      data.full_name,
      'student'
    )

    return NextResponse.json({ success: true, id: studentId, inviteEmailSent })
  } catch (err) {
    console.error('Create student error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
