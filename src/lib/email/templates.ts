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
  
  // ─── Individual email content builders ────────────────────────────────────────
  
  export function newMessageEmailContent(senderName: string): string {
    return `
      <p style="margin:0 0 16px;font-size:15px;color:#111827;line-height:1.6;">
        You have a new message from <strong style="color:#FF8303;">${senderName}</strong>
        on the Lingualink Online portal.
      </p>
      <p style="margin:0 0 24px;font-size:15px;color:#111827;line-height:1.6;">
        Log in to your portal to read and reply to the message.
      </p>
      
        href="https://teachers.lingualinkonline.com/messages"
        style="display:inline-block;background-color:#FF8303;color:#FFFFFF;font-size:15px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;"
      >
        Go to Messages
      </a>
    `
  }