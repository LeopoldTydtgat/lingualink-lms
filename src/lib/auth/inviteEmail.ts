import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import { buildEmailTemplate } from '@/lib/email/templates'

/**
 * Invite-email flow for admin-created accounts.
 *
 * The admin no longer chooses a temporary password: the auth user is created
 * with a random throwaway password (never shown, returned, or logged) and the
 * new user receives a branded email with a recovery link to set their own
 * password.
 *
 * Server-only: uses the service-role admin client. Never import from
 * client components.
 */

// Regenerate until all three character classes are present: the portal's
// password policy (src/lib/passwordValidation.ts) requires upper + lower +
// digit, and raw base64url output occasionally lacks one class, which would
// fail auth.admin.createUser if the Supabase policy mirrors the client rule.
export function generateThrowawayPassword(): string {
  for (;;) {
    const password = randomBytes(24).toString('base64url')
    if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password)) {
      return password
    }
  }
}

/**
 * Sends the "set up your account" invite email. Best-effort: catches and logs
 * every failure and reports it via { sent } — never throws, so account
 * creation can never be rolled back or failed by an email problem.
 *
 * The link for BOTH portals points at the teacher-domain /reset-password
 * page: it is the only page that consumes ?token_hash=...&type=recovery
 * (verifyOtp) and it forwards students to /student/reset-password on the
 * shared domain-scoped recovery session — the same route the forgot-password
 * emails take. The student reset page ignores query params entirely, so a
 * student invite must NOT link there directly.
 */
export async function sendAccountInviteEmail(
  adminClient: SupabaseClient,
  email: string,
  recipientName: string,
  portal: 'teacher' | 'student'
): Promise<{ sent: boolean }> {
  try {
    const { data, error } = await adminClient.auth.admin.generateLink({
      type: 'recovery',
      email,
    })

    const hashedToken = data?.properties?.hashed_token
    if (error || !hashedToken) {
      console.error('Invite email: generateLink failed:', error)
      return { sent: false }
    }

    const inviteUrl = `${process.env.NEXT_PUBLIC_TEACHER_URL}/reset-password?token_hash=${encodeURIComponent(hashedToken)}&type=recovery`

    const loginUrl =
      portal === 'teacher'
        ? `${process.env.NEXT_PUBLIC_TEACHER_URL}/login`
        : `${process.env.NEXT_PUBLIC_STUDENT_URL}/student/login`

    const contactEmail =
      portal === 'teacher'
        ? 'teachers@lingualinkonline.com'
        : 'support@lingualinkonline.com'

    const subject = 'Lingualink Online - Welcome! Set up your account'

    const bodyHtml = `
      <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
        Welcome to Lingualink Online! An account has been created for you.
      </p>
      <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
        Click the button below to set your password and log in to your portal.
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td>
            <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${inviteUrl}" style="height:46px;v-text-anchor:middle;width:240px;" arcsize="13%" stroke="f" fillcolor="#FF8303"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Set My Password</center></v:roundrect><![endif]-->
            <!--[if !mso]><!-->
            <a href="${inviteUrl}" style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;">Set My Password</a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:13px;color:#6B7280;line-height:1.6;">
        This link expires after a limited time. If it has expired, use &quot;Forgot password&quot; on the
        <a href="${loginUrl}" style="color:#6B7280;text-decoration:underline;">login page</a> to request a new one.
      </p>
    `

    const { error: sendError } = await resend.emails.send({
      from: 'Lingualink Online <no-reply@lingualinkonline.com>',
      to: email,
      subject,
      html: buildEmailTemplate({
        recipientName,
        recipientFallback: portal === 'teacher' ? 'Teacher' : 'Student',
        subject,
        bodyHtml,
        contactEmail,
      }),
    })

    if (sendError) {
      console.error('Invite email: Resend send failed:', sendError)
      return { sent: false }
    }

    return { sent: true }
  } catch (err) {
    console.error('Invite email error:', err)
    return { sent: false }
  }
}
