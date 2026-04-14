// Builds a branded HTML email — all styles are inline because
// most email clients strip <style> blocks and ignore class names

interface EmailTemplateOptions {
  recipientName: string
  subject: string
  bodyHtml: string
}

export function buildEmailTemplate({ recipientName, bodyHtml }: EmailTemplateOptions): string {
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

          <!-- Logo -->
          <tr>
            <td align="center" style="padding:24px 40px 0;background-color:#FFFFFF;">
              <img src="${process.env.NEXT_PUBLIC_SITE_URL}/lingualink-logo-clean.svg" alt="Lingualink Online" height="56" style="display:block;" />
            </td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="background-color:#FF8303;padding:28px 40px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:-0.3px;">
                Lingualink Online
              </p>
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
            <td style="padding:24px 40px;border-top:1px solid #E5E7EB;">
              <p style="margin:0;font-size:13px;color:#6B7280;">
                If you have any questions, contact us at
                <a href="mailto:info@lingualinkonline.com" style="color:#FF8303;text-decoration:none;">
                  info@lingualinkonline.com
                </a>
              </p>
              <p style="margin:8px 0 0;font-size:13px;color:#9CA3AF;">
                Lingualink Online &mdash; www.lingualinkonline.com
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
      href="mailto:info@lingualinkonline.com"
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
