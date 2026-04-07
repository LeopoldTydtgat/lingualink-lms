import { Client } from '@microsoft/microsoft-graph-client'
import { ClientSecretCredential } from '@azure/identity'

// ── Organiser account ────────────────────────────────────────────────────────
// All Teams meetings are created under this account.
// Meeting links are tied to the lesson slot, not the teacher —
// so if a teacher swap occurs, the student's join link never changes.
const ORGANISER_UPN = 'Admin@LingualinkOnline.onmicrosoft.com'

// ── Build an authenticated Graph client ─────────────────────────────────────
function getGraphClient(): Client {
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!
  )

  return Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken(
          'https://graph.microsoft.com/.default'
        )
        return token.token
      },
    },
  })
}

// ── Create a Teams meeting ───────────────────────────────────────────────────
// Called on every new class booking.
// Returns the join URL (stored in lessons.teams_join_url)
// and the meeting ID (stored in lessons.teams_meeting_id for future updates).
export async function createTeamsMeeting({
  subject,
  startTime,
  durationMinutes,
}: {
  subject: string
  startTime: string       // UTC ISO string
  durationMinutes: number
}): Promise<{ joinUrl: string; meetingId: string }> {
  const client = getGraphClient()

  const start = new Date(startTime)
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000)

  const meeting = await client
    .api(`/users/${ORGANISER_UPN}/onlineMeetings`)
    .post({
      subject,
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
    })

  return {
    joinUrl: meeting.joinWebUrl,
    meetingId: meeting.id,
  }
}

// ── Update an existing Teams meeting ────────────────────────────────────────
// Called when a class is rescheduled.
// The join URL stays the same — only the time changes.
export async function updateTeamsMeeting({
  meetingId,
  startTime,
  durationMinutes,
}: {
  meetingId: string
  startTime: string       // UTC ISO string
  durationMinutes: number
}): Promise<void> {
  const client = getGraphClient()

  const start = new Date(startTime)
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000)

  await client
    .api(`/users/${ORGANISER_UPN}/onlineMeetings/${meetingId}`)
    .patch({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
    })
}

// ── Cancel a Teams meeting ───────────────────────────────────────────────────
// Called when a class is cancelled.
export async function cancelTeamsMeeting(meetingId: string): Promise<void> {
  const client = getGraphClient()

  await client
    .api(`/users/${ORGANISER_UPN}/onlineMeetings/${meetingId}`)
    .delete()
}