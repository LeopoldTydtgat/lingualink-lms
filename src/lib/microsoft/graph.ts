import { Client } from '@microsoft/microsoft-graph-client'
import { ClientSecretCredential } from '@azure/identity'

// ── Organiser account ────────────────────────────────────────────────────────
// All Teams meetings are created under this account.
// Meeting links are tied to the lesson slot, not the teacher —
// so if a teacher swap occurs, the student's join link never changes.
// To switch to a shared mailbox later, change this one value only.
const ORGANISER_UPN = 'Admin@LingualinkOnline.onmicrosoft.com'

// ── Build an authenticated Graph client ──────────────────────────────────────
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
// Uses the Calendar Events endpoint (/users/{UPN}/events with isOnlineMeeting)
// instead of /onlineMeetings — this works with Microsoft 365 Business Basic.
// The Teams join URL is returned in onlineMeeting.joinUrl on the event object.
// meetingId here is the calendar event ID — used for updates and cancellations.
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

  const event = await client
    .api(`/users/${ORGANISER_UPN}/events`)
    .post({
      subject,
      start: {
        dateTime: start.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'UTC',
      },
      // This is what tells Graph to create a Teams meeting link
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    })

  const joinUrl = event?.onlineMeeting?.joinUrl

  if (!joinUrl) {
    throw new Error(
      'Teams meeting created but no join URL was returned. Check that the organiser account has a valid Teams licence.'
    )
  }

  return {
    joinUrl,
    meetingId: event.id,  // Calendar event ID — used for updates/cancellations
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
    .api(`/users/${ORGANISER_UPN}/events/${meetingId}`)
    .patch({
      start: {
        dateTime: start.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'UTC',
      },
    })
}

// ── Cancel a Teams meeting ───────────────────────────────────────────────────
// Called when a class is cancelled.
// Deletes the calendar event — the Teams meeting link becomes inactive.
export async function cancelTeamsMeeting(meetingId: string): Promise<void> {
  const client = getGraphClient()

  await client
    .api(`/users/${ORGANISER_UPN}/events/${meetingId}`)
    .delete()
}
