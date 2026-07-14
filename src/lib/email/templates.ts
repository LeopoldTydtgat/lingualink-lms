// Builds a branded HTML email — all styles are inline because
// most email clients strip <style> blocks and ignore class names

// Hosted logo (white wordmark on transparent, sits on the orange header band).
// Hardcoded so the email never depends on a runtime env var to render its header.
const LOGO_URL = 'https://varrxikjrbycpobydlev.supabase.co/storage/v1/object/public/templates/lingualink-logo-onorange.png'

interface EmailTemplateOptions {
  recipientName: string | null | undefined
  recipientFallback?: string
  subject: string
  bodyHtml: string
  contactEmail: string
}

export function buildEmailTemplate({ recipientName, recipientFallback = 'there', bodyHtml, contactEmail }: EmailTemplateOptions): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF;border:1px solid #E5E7EB;max-width:600px;width:100%;">

          <!-- Header: orange band with logo -->
          <tr>
            <td style="background-color:#FF8303;padding:24px;text-align:center;">
              <img src="${LOGO_URL}" alt="Lingualink Online" width="160" style="display:block;margin:0 auto;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;font-size:15px;color:#111827;">
                Dear ${recipientName || recipientFallback},
              </p>
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #E5E7EB;background-color:#F9FAFB;text-align:center;">
              <p style="margin:0;font-size:13px;color:#6B7280;">
                If you have any questions, contact us at
                <a href="mailto:${contactEmail}" style="color:#FF8303;text-decoration:none;">
                  ${contactEmail}
                </a>
              </p>
              <p style="margin:8px 0 0;font-size:13px;color:#9CA3AF;">
                www.lingualinkonline.com
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

// Formats a UTC timestamp into a readable local-style string for emails.
// We use explicit date parts to avoid any toISOString / toLocaleTimeString issues.
// When durationMinutes is provided, the class END time (start + duration, formatted
// in the SAME timezone) is appended as " - HH:MM", e.g. "Friday, 26 June 2026, 08:30
// - 09:00". When it is omitted the output is start-only, exactly as before.
function formatClassTime(isoString: string, timezone: string, durationMinutes?: number): string {
  try {
    const date = new Date(isoString)
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    const start = formatter.format(date)

    if (durationMinutes === undefined) return start

    // Derive the end time via a second Intl formatter in the same timezone rather
    // than doing string math on the start, so an offset/DST change between start and
    // end is reflected correctly.
    const endDate = new Date(date.getTime() + durationMinutes * 60000)
    const endFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    })
    return `${start} - ${endFormatter.format(endDate)}`
  } catch {
    return isoString
  }
}

// Builds an email button that renders correctly in Outlook (via VML) and all
// other clients (via a standard <a> tag). Outlook ignores CSS border-radius on
// anchor tags entirely — VML roundrect is the only reliable fix.
// Width of 300px accommodates the longest button label used in these templates;
// the button is centered via align="center" for Outlook.
export function buildButton(href: string, label: string): string {
  return `
<table cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
  <tr>
    <td>
      <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:300px;" arcsize="13%" stroke="f" fillcolor="#FF8303"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
      <!--[if !mso]><!-->
      <a href="${href}" style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;">${label}</a>
      <!--<![endif]-->
    </td>
  </tr>
</table>
  `.trim()
}

// Builds the bordered, zebra-striped details table shared by the transactional
// emails. Fixed row shape { label, value }; a row's `value` may carry inline
// markup (e.g. a coloured <span>) when that single row needs emphasis.
export function buildDetailsTable(heading: string, rows: { label: string; value: string }[]): string {
  const dataRows = rows
    .map((row, i) => `
      <tr>
        <td style="background-color:${i % 2 === 0 ? '#FFFFFF' : '#F9FAFB'};padding:10px 16px;font-size:14px;color:#111827;"><strong>${row.label}:</strong> ${row.value}</td>
      </tr>`)
    .join('')
  return `
    <table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E5E7EB;margin:0 0 24px;">
      <tr>
        <td style="background-color:#F3F4F6;padding:10px 16px;font-size:12px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">${heading}</td>
      </tr>${dataRows}
    </table>
  `
}

// ─── Teacher email content builders ───────────────────────────────────────────

export function newMessageEmailContent(senderName: string): string {
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      You have a new message from <strong style="color:#FF8303;">${senderName}</strong>
      on the Lingualink Online portal.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
      Log in to your portal to read and reply to the message.
    </p>
    ${buildButton(`${process.env.NEXT_PUBLIC_TEACHER_URL}/messages`, 'Go to Messages')}
  `
}

export function teacherClassReminderEmailContent(
  studentName: string,
  scheduledAt: string,
  durationMinutes: number,
  teamsJoinUrl: string | null,
  teacherTimezone: string,
  hoursUntil: number
): string {
  const timeLabel = hoursUntil <= 1 ? 'less than one hour' : 'less than 24 hours'
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone, durationMinutes)

  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${studentName}</strong> is in ${timeLabel}.
    </p>
    ${buildDetailsTable('Class details', [
      { label: 'Date &amp; Time', value: formattedTime },
      { label: 'Duration', value: `${durationMinutes} minutes` },
      { label: 'Student', value: studentName },
    ])}
    ${teamsJoinUrl ? `
      <p style="margin-top:16px;font-size:14px;color:#374151;line-height:1.5;">
        Join your class on Teams:<br>
        <a href="${teamsJoinUrl}" style="color:#FF8303;word-break:break-all;">${teamsJoinUrl}</a>
      </p>
    ` : ''}
  `
}

export function teacherNewBookingEmailContent(
  studentName: string,
  scheduledAt: string,
  durationMinutes: number,
  teacherTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone, durationMinutes)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      A new class has been booked with <strong style="color:#FF8303;">${studentName}</strong>.
    </p>
    ${buildDetailsTable('Class details', [
      { label: 'Date &amp; Time', value: formattedTime },
      { label: 'Duration', value: `${durationMinutes} minutes` },
      { label: 'Student', value: studentName },
    ])}
    ${buildButton(`${process.env.NEXT_PUBLIC_TEACHER_URL}/upcoming-classes`, 'View Upcoming Classes')}
  `
}

export function teacherCancellationEmailContent(
  studentName: string,
  scheduledAt: string,
  durationMinutes: number,
  teacherTimezone: string,
  cancellationReason?: string
): string {
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone, durationMinutes)
  const rows: { label: string; value: string }[] = [
    { label: 'Cancelled class', value: formattedTime },
    { label: 'Student', value: studentName },
  ]
  if (cancellationReason) {
    rows.push({ label: 'Reason', value: cancellationReason })
  }
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${studentName}</strong> has been cancelled. Your schedule has been updated.
    </p>
    ${buildDetailsTable('Cancellation details', rows)}
    ${buildButton(`${process.env.NEXT_PUBLIC_TEACHER_URL}/upcoming-classes`, 'View My Schedule')}
  `
}

export function teacherReportForfeitedEmailContent(
  studentName: string,
  scheduledAt: string,
  durationMinutes: number,
  teacherTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone, durationMinutes)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      The 12-hour window to submit your class report for your class with <strong style="color:#FF8303;">${studentName}</strong> on ${formattedTime} has now closed.
    </p>
    <p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">
      Because the report was not submitted within the deadline, payment for this class has been forfeited in line with the reporting policy. Please make sure future reports are completed within 12 hours of the class ending.
    </p>
  `
}

export function teacherRescheduledEmailContent(
  studentName: string,
  oldScheduledAt: string | null,
  oldDurationMinutes: number | null,
  newScheduledAt: string,
  durationMinutes: number,
  teacherTimezone: string,
  initiatedBy: 'student' | 'admin'
): string {
  const newTime = formatClassTime(newScheduledAt, teacherTimezone, durationMinutes)
  const rows: { label: string; value: string }[] = []
  if (oldScheduledAt) {
    rows.push({ label: 'Previous time', value: formatClassTime(oldScheduledAt, teacherTimezone, oldDurationMinutes ?? undefined) })
    rows.push({ label: 'New time', value: newTime })
  } else {
    rows.push({ label: 'Class time', value: newTime })
  }
  rows.push({ label: 'Duration', value: `${durationMinutes} minutes` })
  rows.push({ label: 'Student', value: studentName })
  const openingSentence = initiatedBy === 'student'
    ? `Your class with <strong style="color:#FF8303;">${studentName}</strong> has been rescheduled by the student.`
    : `Your class with <strong style="color:#FF8303;">${studentName}</strong> has been rescheduled by Lingualink admin.`
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      ${openingSentence}
    </p>
    ${buildDetailsTable('Class details', rows)}
    ${buildButton(`${process.env.NEXT_PUBLIC_TEACHER_URL}/upcoming-classes`, 'View Upcoming Classes')}
  `
}

// ─── Student email content builders ───────────────────────────────────────────

export function studentBookingConfirmationEmailContent(
  teacherName: string,
  scheduledAt: string,
  durationMinutes: number,
  studentTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone, durationMinutes)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class has been confirmed. Here are your details:
    </p>
    ${buildDetailsTable('Class details', [
      { label: 'Teacher', value: teacherName },
      { label: 'Date &amp; Time', value: formattedTime },
      { label: 'Duration', value: `${durationMinutes} minutes` },
    ])}
    <p style="margin:0 0 24px;font-size:13px;color:#6B7280;line-height:1.6;">
      The Join Class button in your portal activates 10 minutes before the class starts.
    </p>
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/my-classes`, 'View My Classes')}
  `
}

export function studentCancellationByStudentEmailContent(
  teacherName: string,
  scheduledAt: string,
  durationMinutes: number,
  hoursRefunded: number | null,
  studentTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone, durationMinutes)
  const refundRow = hoursRefunded
    ? { label: 'Hours returned', value: `${hoursRefunded}h added back to your balance` }
    : { label: 'Note', value: '<span style="color:#DC2626;">No hours refunded — cancellation within 24 hours of class</span>' }
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class has been cancelled as requested. The details are below.
    </p>
    ${buildDetailsTable('Cancellation details', [
      { label: 'Teacher', value: teacherName },
      { label: 'Cancelled class', value: formattedTime },
      refundRow,
    ])}
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/my-classes`, 'Book Another Class')}
  `
}

export function studentCancellationByTeacherEmailContent(
  teacherName: string,
  scheduledAt: string,
  durationMinutes: number,
  hoursRefunded: number,
  studentTimezone: string,
  teacherMessage: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone, durationMinutes)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Unfortunately your class has been cancelled by your teacher. Your hours have been returned to your balance.
    </p>
    ${buildDetailsTable('Cancellation details', [
      { label: 'Teacher', value: teacherName },
      { label: 'Cancelled class', value: formattedTime },
      { label: 'Hours returned', value: `${hoursRefunded}h added back to your balance` },
    ])}
    ${teacherMessage ? `
    <div style="margin:0 0 24px;padding:16px 20px;background-color:#F9FAFB;border-left:4px solid #FF8303;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Message from your teacher</p>
      <p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">${teacherMessage}</p>
    </div>
    ` : ''}
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/my-classes`, 'Book a New Class')}
  `
}

export function studentRescheduledEmailContent(
  teacherName: string,
  oldScheduledAt: string | null,
  oldDurationMinutes: number | null,
  newScheduledAt: string,
  durationMinutes: number,
  studentTimezone: string,
  initiatedBy: 'student' | 'admin'
): string {
  const newTime = formatClassTime(newScheduledAt, studentTimezone, durationMinutes)
  const rows: { label: string; value: string }[] = []
  if (oldScheduledAt) {
    rows.push({ label: 'Previous time', value: formatClassTime(oldScheduledAt, studentTimezone, oldDurationMinutes ?? undefined) })
    rows.push({ label: 'New time', value: newTime })
  } else {
    rows.push({ label: 'Class time', value: newTime })
  }
  rows.push({ label: 'Duration', value: `${durationMinutes} minutes` })
  const openingSentence = initiatedBy === 'student'
    ? `Your class with <strong style="color:#FF8303;">${teacherName}</strong> has been rescheduled as requested.`
    : `Your class with <strong style="color:#FF8303;">${teacherName}</strong> has been rescheduled by Lingualink admin.`
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      ${openingSentence}
    </p>
    ${buildDetailsTable('Class details', rows)}
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/my-classes`, 'View My Classes')}
  `
}

export function studentClassReminderEmailContent(
  teacherName: string,
  scheduledAt: string,
  durationMinutes: number,
  teamsJoinUrl: string | null,
  studentTimezone: string,
  hoursUntil: number
): string {
  const timeLabel = hoursUntil <= 1 ? 'less than one hour' : 'less than 24 hours'
  const formattedTime = formatClassTime(scheduledAt, studentTimezone, durationMinutes)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${teacherName}</strong> is in ${timeLabel}.
    </p>
    ${buildDetailsTable('Class details', [
      { label: 'Teacher', value: teacherName },
      { label: 'Date &amp; Time', value: formattedTime },
      { label: 'Duration', value: `${durationMinutes} minutes` },
    ])}
    ${teamsJoinUrl ? `
      <p style="margin-top:16px;font-size:14px;color:#374151;line-height:1.5;">
        Join your class on Teams:<br>
        <a href="${teamsJoinUrl}" style="color:#FF8303;word-break:break-all;">${teamsJoinUrl}</a>
      </p>
    ` : ''}
  `
}

export function studentHomeworkAssignedEmailContent(
  teacherName: string,
  sheetTitles: string[]
): string {
  const sheetList = sheetTitles
    .map(t => `<li style="margin:4px 0;font-size:14px;color:#111827;">${t}</li>`)
    .join('')
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your teacher <strong style="color:#FF8303;">${teacherName}</strong> has assigned new exercises for you to complete.
    </p>
    <ul style="margin:0 0 24px;padding-left:20px;">
      ${sheetList}
    </ul>
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/study`, 'Go to My Study')}
  `
}

export function studentLowHoursEmailContent(
  hoursRemaining: number
): string {
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      You have <strong style="color:#FF8303;">${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'}</strong> remaining in your training package.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
      To keep booking classes without interruption, please contact us to arrange more hours.
    </p>
    ${buildButton('mailto:support@lingualinkonline.com', 'Contact Us')}
  `
}

export function studentNewMessageEmailContent(teacherName: string): string {
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      You have a new message from <strong style="color:#FF8303;">${teacherName}</strong>
      on the Lingualink Online portal.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
      Log in to your portal to read and reply.
    </p>
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/messages`, 'Go to Messages')}
  `
}

export function studentTrainingEndingSoonEmailContent(endDate: string): string {
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your current training package ends on <strong style="color:#FF8303;">${endDate}</strong>.
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Any remaining hours must be used before this date - you can book classes directly from your portal.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
      If you would like to continue after your package ends, contact our support team and they will be happy to help you arrange a new one.
    </p>
    ${buildButton('mailto:support@lingualinkonline.com', 'Contact Support')}
  `
}

export function studentCancellationByAdminEmailContent(
  teacherName: string,
  scheduledAt: string,
  durationMinutes: number,
  hoursRefunded: number,
  studentTimezone: string,
  cancellationReason?: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone, durationMinutes)
  const refunded = hoursRefunded > 0
  const openingSentence = refunded
    ? "We're sorry to let you know that your upcoming class has been cancelled. Your hours have been returned to your balance and you are welcome to book a new class at your convenience."
    : "We're sorry to let you know that your upcoming class has been cancelled. Please reach out to us if you have any questions."
  const rows: { label: string; value: string }[] = [
    { label: 'Teacher', value: teacherName },
    { label: 'Cancelled class', value: formattedTime },
  ]
  if (refunded) {
    rows.push({ label: 'Hours returned', value: `${hoursRefunded}h added back to your balance` })
  }
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      ${openingSentence}
    </p>
    ${buildDetailsTable('Cancellation details', rows)}
    ${cancellationReason ? `
    <div style="margin:0 0 24px;padding:16px 20px;background-color:#F9FAFB;border-left:4px solid #FF8303;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Reason for cancellation</p>
      <p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">${cancellationReason}</p>
    </div>
    ` : ''}
    ${buildButton(`${process.env.NEXT_PUBLIC_STUDENT_URL}/student/my-classes`, 'Book a New Class')}
  `
}
