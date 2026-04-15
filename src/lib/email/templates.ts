// Builds a branded HTML email — all styles are inline because
// most email clients strip <style> blocks and ignore class names

// Email logo embedded as base64 so it renders in all email clients without depending on a public URL
const LOGO_BASE64 = 'data:image/png;base64,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'

interface EmailTemplateOptions {
  recipientName: string
  subject: string
  bodyHtml: string
  contactEmail: string
}

export function buildEmailTemplate({ recipientName, bodyHtml, contactEmail }: EmailTemplateOptions): string {
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
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:#FF8303;padding:12px 0;">
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;font-size:15px;color:#111827;">
                Dear ${recipientName},
              </p>
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #E5E7EB;text-align:center;">
              <img src="${LOGO_BASE64}" alt="Lingualink Online" width="140" style="display:block;margin:0 auto 12px;" />
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

// ─── Shared helper ────────────────────────────────────────────────────────────

// Formats a UTC timestamp into a readable local-style string for emails.
// We use explicit date parts to avoid any toISOString / toLocaleTimeString issues.
function formatClassTime(isoString: string, timezone: string): string {
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
    return formatter.format(date)
  } catch {
    return isoString
  }
}

// ─── Teacher email content builders ──────────────────────────────────────────

export function newMessageEmailContent(senderName: string): string {
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      You have a new message from <strong style="color:#FF8303;">${senderName}</strong>
      on the Lingualink Online portal.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
      Log in to your portal to read and reply to the message.
    </p>
    <a
      href="https://teachers.lingualinkonline.com/messages"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Go to Messages
    </a>
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
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone)

  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${studentName}</strong> is in ${timeLabel}.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Date &amp; Time:</strong> ${formattedTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Duration:</strong> ${durationMinutes} minutes</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Student:</strong> ${studentName}</td></tr>
    </table>
    ${teamsJoinUrl ? `
    <a
      href="${teamsJoinUrl}"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Join Class on Teams
    </a>
    ` : ''}
  `
}

export function teacherNewBookingEmailContent(
  studentName: string,
  scheduledAt: string,
  durationMinutes: number,
  teacherTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      A new class has been booked with <strong style="color:#FF8303;">${studentName}</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Date &amp; Time:</strong> ${formattedTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Duration:</strong> ${durationMinutes} minutes</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Student:</strong> ${studentName}</td></tr>
    </table>
    <a
      href="https://teachers.lingualinkonline.com/upcoming-classes"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      View Upcoming Classes
    </a>
  `
}

export function teacherCancellationEmailContent(
  studentName: string,
  scheduledAt: string,
  teacherTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, teacherTimezone)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${studentName}</strong> has been cancelled.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Cancelled class:</strong> ${formattedTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Student:</strong> ${studentName}</td></tr>
    </table>
  `
}

// ─── Student email content builders ──────────────────────────────────────────

export function studentBookingConfirmationEmailContent(
  teacherName: string,
  scheduledAt: string,
  durationMinutes: number,
  teamsJoinUrl: string | null,
  studentTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class has been confirmed. Here are your details:
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Teacher:</strong> ${teacherName}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Date &amp; Time:</strong> ${formattedTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Duration:</strong> ${durationMinutes} minutes</td></tr>
    </table>
    ${teamsJoinUrl ? `
    <p style="margin:0 0 12px;font-size:14px;color:#6B7280;line-height:1.6;">
      Your Teams link will be ready to use 15 minutes before your class starts.
    </p>
    <a
      href="${teamsJoinUrl}"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Join Class on Teams
    </a>
    ` : ''}
  `
}

export function studentCancellationByStudentEmailContent(
  teacherName: string,
  scheduledAt: string,
  hoursRefunded: number | null,
  studentTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone)
  const refundLine = hoursRefunded
    ? `<tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Hours returned:</strong> ${hoursRefunded}h added back to your balance</td></tr>`
    : `<tr><td style="font-size:14px;color:#DC2626;padding:4px 0;"><strong>Note:</strong> No hours refunded — cancellation within 24 hours of class</td></tr>`
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class has been cancelled as requested.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Teacher:</strong> ${teacherName}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Cancelled class:</strong> ${formattedTime}</td></tr>
      ${refundLine}
    </table>
    <a
      href="https://students.lingualinkonline.com/student/my-classes"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Book Another Class
    </a>
  `
}

export function studentCancellationByTeacherEmailContent(
  teacherName: string,
  scheduledAt: string,
  hoursRefunded: number,
  studentTimezone: string
): string {
  const formattedTime = formatClassTime(scheduledAt, studentTimezone)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Unfortunately your class has been cancelled by your teacher. Your hours have been returned to your balance.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Teacher:</strong> ${teacherName}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Cancelled class:</strong> ${formattedTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Hours returned:</strong> ${hoursRefunded}h added back to your balance</td></tr>
    </table>
    <a
      href="https://students.lingualinkonline.com/student/my-classes"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Book a New Class
    </a>
  `
}

export function studentRescheduledEmailContent(
  teacherName: string,
  oldScheduledAt: string,
  newScheduledAt: string,
  durationMinutes: number,
  teamsJoinUrl: string | null,
  studentTimezone: string
): string {
  const oldTime = formatClassTime(oldScheduledAt, studentTimezone)
  const newTime = formatClassTime(newScheduledAt, studentTimezone)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${teacherName}</strong> has been rescheduled.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#6B7280;padding:4px 0;"><strong>Previous time:</strong> ${oldTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>New time:</strong> ${newTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Duration:</strong> ${durationMinutes} minutes</td></tr>
    </table>
    ${teamsJoinUrl ? `
    <a
      href="${teamsJoinUrl}"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Join Class on Teams
    </a>
    ` : ''}
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
  const formattedTime = formatClassTime(scheduledAt, studentTimezone)
  return `
    <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
      Your class with <strong style="color:#FF8303;">${teacherName}</strong> is in ${timeLabel}.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;background-color:#FFF7ED;border-radius:8px;padding:16px 20px;width:100%;">
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Teacher:</strong> ${teacherName}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Date &amp; Time:</strong> ${formattedTime}</td></tr>
      <tr><td style="font-size:14px;color:#111827;padding:4px 0;"><strong>Duration:</strong> ${durationMinutes} minutes</td></tr>
    </table>
    ${teamsJoinUrl ? `
    <a
      href="${teamsJoinUrl}"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Join Class on Teams
    </a>
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
    <a
      href="https://students.lingualinkonline.com/student/study"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Go to My Study
    </a>
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
      To continue booking classes without interruption, please contact us to purchase more hours.
    </p>
    <a
      href="mailto:support@lingualinkonline.com"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Contact Us
    </a>
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
    <a
      href="https://students.lingualinkonline.com/student/messages"
      style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
    >
      Go to Messages
    </a>
  `
}
