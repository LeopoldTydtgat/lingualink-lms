import 'dotenv/config'
import { config } from 'dotenv'
import { GraphError } from '@microsoft/microsoft-graph-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { cancelTeamsMeeting, ORGANISER_UPN, getGraphClient } from '@/lib/microsoft/graph'

// Load .env.local after dotenv/config loads .env; .env.local values take precedence.
// This project stores dev secrets in .env.local, not .env.
config({ path: '.env.local', override: true })

const CANCEL_STATUSES = [
  'cancelled',
  'cancelled_by_student',
  'cancelled_by_teacher',
  'teacher_cancelled',
]

const executeMode = process.argv.includes('--execute')
const DIVIDER = '='.repeat(60)

async function main(): Promise<void> {
  console.log(DIVIDER)
  console.log(executeMode ? 'EXECUTE MODE' : 'DRY RUN')
  console.log(DIVIDER + '\n')

  const supabase = createAdminClient()

  const { data: rows, error: queryError } = await supabase
    .from('lessons')
    .select('id, teams_meeting_id, teams_join_url, scheduled_at, status')
    .not('teams_meeting_id', 'is', null)
    .in('status', CANCEL_STATUSES)
    .order('scheduled_at', { ascending: true })

  if (queryError) {
    console.error('CRITICAL: Failed to query lessons:', queryError)
    process.exit(1)
  }

  if (!rows || rows.length === 0) {
    console.log('No orphan meetings found.')
    process.exit(0)
  }

  console.log(`Found ${rows.length} row(s) with non-null teams_meeting_id.\n`)

  let deleted = 0
  let alreadyGone = 0
  let dbCleaned = 0
  let errors = 0
  let skipped = 0

  for (const row of rows) {
    // teams_meeting_id is filtered to NOT NULL in the query; this is a runtime guard only
    if (!row.teams_meeting_id) continue

    const shortMeetingId = String(row.teams_meeting_id).slice(0, 20) + '...'

    if (!executeMode) {
      console.log({
        id: row.id,
        status: row.status,
        scheduled_at: row.scheduled_at,
        teams_meeting_id: shortMeetingId,
        'teams_join_url present': row.teams_join_url ? 'yes' : 'no',
      })
      continue
    }

    console.log(`\nProcessing lesson ${row.id}`)
    console.log(`  meeting_id (truncated): ${shortMeetingId}`)

    // GET probe: confirm the event is reachable under the organiser UPN before DELETE.
    // Catches ORGANISER_UPN mismatches and already-deleted events in one step.
    let graphDeleteNeeded = true
    try {
      const client = getGraphClient()
      await client.api(`/users/${ORGANISER_UPN}/events/${row.teams_meeting_id}`).get()
      console.log('  EXISTS - proceeding to DELETE')
    } catch (probeError) {
      if ((probeError as GraphError).statusCode === 404) {
        console.log('  ALREADY-GONE - skipping Graph DELETE, cleaning DB only')
        graphDeleteNeeded = false
        alreadyGone++
      } else {
        console.error('  CRITICAL:', {
          phase: 'probe',
          teams_meeting_id: row.teams_meeting_id,
          lesson_id: row.id,
          error: probeError,
        })
        errors++
        skipped++
        continue
      }
    }

    if (graphDeleteNeeded) {
      try {
        await cancelTeamsMeeting(String(row.teams_meeting_id))
        console.log('  DELETED')
        deleted++
      } catch (deleteError) {
        console.error('  CRITICAL:', {
          phase: 'delete',
          teams_meeting_id: row.teams_meeting_id,
          lesson_id: row.id,
          error: deleteError,
        })
        errors++
        skipped++
        continue
      }
    }

    // Null out both fields. .select('id') makes Supabase return affected rows so
    // we can detect the silent-zero-rows failure mode (update matched nothing).
    const { data: updated, error: updateError } = await supabase
      .from('lessons')
      .update({ teams_meeting_id: null, teams_join_url: null })
      .eq('id', row.id)
      .select('id')

    if (updateError) {
      console.error('  CRITICAL: DB update failed:', {
        lesson_id: row.id,
        error: updateError,
      })
      errors++
      continue
    }

    if (!updated || updated.length === 0) {
      console.error('  CRITICAL: DB update affected 0 rows:', { lesson_id: row.id })
      errors++
      continue
    }

    console.log('  DB cleaned')
    dbCleaned++
  }

  console.log('\n' + DIVIDER)
  console.log('SUMMARY')
  console.log(DIVIDER)
  console.log(`  Total rows found : ${rows.length}`)

  if (executeMode) {
    console.log(`  Deleted (live)   : ${deleted}`)
    console.log(`  Already gone     : ${alreadyGone}`)
    console.log(`  DB cleaned       : ${dbCleaned}`)
    console.log(`  Skipped          : ${skipped}`)
    console.log(`  Errors           : ${errors}`)
  } else {
    console.log('  (Dry run - no changes made)')
  }
}

main().catch((err: unknown) => {
  console.error('Unhandled error in main:', err)
  process.exit(1)
})
