import { NextRequest, NextResponse } from 'next/server'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  newMessageEmailContent,
  teacherClassReminderEmailContent,
  teacherNewBookingEmailContent,
  teacherCancellationEmailContent,
  studentBookingConfirmationEmailContent,
  studentCancellationByStudentEmailContent,
  studentCancellationByTeacherEmailContent,
  studentRescheduledEmailContent,
  studentClassReminderEmailContent,
  studentHomeworkAssignedEmailContent,
  studentLowHoursEmailContent,
  studentNewMessageEmailContent,
  studentTrainingEndingSoonEmailContent,
  studentCancellationByAdminEmailContent,
} from '@/lib/email/templates'

const FROM = 'Lingualink Online <no-reply@lingualinkonline.com>'
const RECIPIENT_NAME = 'Test User'
const CONTACT_EMAIL = 'support@lingualinkonline.com'

function tomorrowUtcIso(daysAhead: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + daysAhead)
  d.setUTCHours(10, 0, 0, 0)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}T10:00:00.000Z`
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 })
  }

  const to = req.nextUrl.searchParams.get('to')
  if (!to) {
    return NextResponse.json({ error: 'Missing ?to= query param' }, { status: 400 })
  }

  const tomorrow = tomorrowUtcIso(1)
  const dayAfterTomorrow = tomorrowUtcIso(2)

  const emails: { name: string; subject: string; bodyHtml: string }[] = [
    {
      name: '1. newMessageEmailContent',
      subject: 'Lingualink Online — You have a new message',
      bodyHtml: newMessageEmailContent('Marie Dupont'),
    },
    {
      name: '2. teacherClassReminderEmailContent (24h, no Teams)',
      subject: 'Lingualink Online — Your next class is in less than 24 hours',
      bodyHtml: teacherClassReminderEmailContent('Marie Dupont', tomorrow, 60, null, 'Africa/Johannesburg', 24),
    },
    {
      name: '3. teacherClassReminderEmailContent (1h, with Teams)',
      subject: 'Lingualink Online — Your next class is in less than one hour',
      bodyHtml: teacherClassReminderEmailContent(
        'Marie Dupont',
        tomorrow,
        60,
        'https://teams.microsoft.com/l/meetup-join/test',
        'Africa/Johannesburg',
        1,
      ),
    },
    {
      name: '4. teacherNewBookingEmailContent',
      subject: 'Lingualink Online — New class booking: Marie Dupont',
      bodyHtml: teacherNewBookingEmailContent('Marie Dupont', tomorrow, 60, 'Africa/Johannesburg'),
    },
    {
      name: '5. teacherCancellationEmailContent',
      subject: 'Lingualink Online — Class cancelled: Marie Dupont',
      bodyHtml: teacherCancellationEmailContent('Marie Dupont', tomorrow, 'Africa/Johannesburg'),
    },
    {
      name: '6. studentBookingConfirmationEmailContent',
      subject: 'Lingualink Online — Your class has been confirmed',
      bodyHtml: studentBookingConfirmationEmailContent('Sarah Jones', tomorrow, 60, 'Africa/Johannesburg'),
    },
    {
      name: '7. studentCancellationByStudentEmailContent',
      subject: 'Lingualink Online — Class cancellation confirmed',
      bodyHtml: studentCancellationByStudentEmailContent('Sarah Jones', tomorrow, 1, 'Africa/Johannesburg'),
    },
    {
      name: '8. studentCancellationByTeacherEmailContent',
      subject: 'Lingualink Online — Your class has been cancelled by your teacher',
      bodyHtml: studentCancellationByTeacherEmailContent(
        'Sarah Jones',
        tomorrow,
        1,
        'Africa/Johannesburg',
        'I am unwell today and unable to teach. I apologise for the inconvenience.',
      ),
    },
    {
      name: '9. studentRescheduledEmailContent',
      subject: 'Lingualink Online — Your class has been rescheduled',
      bodyHtml: studentRescheduledEmailContent('Sarah Jones', tomorrow, dayAfterTomorrow, 60, 'Africa/Johannesburg'),
    },
    {
      name: '10. studentClassReminderEmailContent (24h, no Teams)',
      subject: 'Lingualink Online — Your class is in less than 24 hours',
      bodyHtml: studentClassReminderEmailContent('Sarah Jones', tomorrow, 60, null, 'Africa/Johannesburg', 24),
    },
    {
      name: '11. studentClassReminderEmailContent (1h, with Teams)',
      subject: 'Lingualink Online — Your class is in less than one hour',
      bodyHtml: studentClassReminderEmailContent(
        'Sarah Jones',
        tomorrow,
        60,
        'https://teams.microsoft.com/l/meetup-join/test',
        'Africa/Johannesburg',
        1,
      ),
    },
    {
      name: '12. studentHomeworkAssignedEmailContent',
      subject: 'Lingualink Online — New exercises assigned',
      bodyHtml: studentHomeworkAssignedEmailContent('Sarah Jones', [
        'Business English — Meetings',
        'Vocabulary — Travel',
      ]),
    },
    {
      name: '13. studentLowHoursEmailContent',
      subject: 'Lingualink Online — Your training hours are running low',
      bodyHtml: studentLowHoursEmailContent(1.5),
    },
    {
      name: '14. studentNewMessageEmailContent',
      subject: 'Lingualink Online — New message from Sarah Jones',
      bodyHtml: studentNewMessageEmailContent('Sarah Jones'),
    },
    {
      name: '15. studentTrainingEndingSoonEmailContent',
      subject: 'Lingualink Online — Your training package is ending soon',
      bodyHtml: studentTrainingEndingSoonEmailContent('30 June 2026'),
    },
    {
      name: '16. studentCancellationByAdminEmailContent',
      subject: 'Lingualink Online — Your class has been cancelled',
      bodyHtml: studentCancellationByAdminEmailContent(
        'Sarah Jones',
        tomorrow,
        1,
        'Africa/Johannesburg',
        'Administrative rescheduling due to a public holiday.',
      ),
    },
  ]

  const results: { name: string; status: 'sent' | 'failed'; error?: string }[] = []

  for (const email of emails) {
    try {
      await resend.emails.send({
        from: FROM,
        to,
        subject: email.subject,
        html: buildEmailTemplate({
          recipientName: RECIPIENT_NAME,
          subject: email.subject,
          bodyHtml: email.bodyHtml,
          contactEmail: CONTACT_EMAIL,
        }),
      })
      results.push({ name: email.name, status: 'sent' })
    } catch (err) {
      results.push({
        name: email.name,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const sent = results.filter(r => r.status === 'sent').length
  const failed = results.filter(r => r.status === 'failed').length

  return NextResponse.json({ to, sent, failed, results })
}
