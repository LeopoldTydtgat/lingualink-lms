import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkEmailDispatchLimit } from '@/lib/rateLimit'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentHomeworkAssignedEmailContent } from '@/lib/email/templates'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Role check — only teachers/admins may dispatch this email. The teacher's
  // display name must come from the session profile, never from the body.
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .single()

  const isAuthorized =
    profile?.role === 'teacher' ||
    profile?.role === 'admin'

  if (!profile || !isAuthorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Per-user dispatch limit — 20/hour. Caps Resend abuse if a teacher/admin
  // session is compromised and starts looping over students.
  const limit = await checkEmailDispatchLimit(user.id)
  if (limit.blocked) {
    return NextResponse.json(
      { error: 'Too many notifications sent. Please try again later.', retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 },
    )
  }

  const teacherName = profile.full_name

  const { studentId, sheetTitles } = await request.json()
  if (!studentId || !Array.isArray(sheetTitles) || sheetTitles.length === 0) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  try {
    const adminClient = createAdminClient()
    const { data: student } = await adminClient
      .from('students')
      .select('email, full_name')
      .eq('id', studentId)
      .single()

    if (student?.email) {
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online - Your teacher has assigned new exercises',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Lingualink Online - Your teacher has assigned new exercises',
          bodyHtml: studentHomeworkAssignedEmailContent(teacherName, sheetTitles),
          contactEmail: 'support@lingualinkonline.com',
        }),
      })
    }
  } catch {
    // email failure is non-blocking
  }

  return NextResponse.json({ ok: true })
}
