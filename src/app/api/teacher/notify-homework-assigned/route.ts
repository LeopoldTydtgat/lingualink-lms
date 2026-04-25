import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import resend from '@/lib/email/client'
import { buildEmailTemplate, studentHomeworkAssignedEmailContent } from '@/lib/email/templates'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { studentId, teacherName, sheetTitles } = await request.json()
  if (!studentId || !teacherName || !Array.isArray(sheetTitles) || sheetTitles.length === 0) {
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
        subject: 'Lingualink Online — New study sheets assigned',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          subject: 'New study sheets assigned',
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
