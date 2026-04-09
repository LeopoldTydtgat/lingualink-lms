import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  studentLowHoursEmailContent,
} from '@/lib/email/templates'

// This route is called by Vercel Cron once per day.
// It finds students whose active training has dropped below 2 hours remaining
// and sends them a low hours warning email — but only once per training package
// to avoid spamming them every day.
//
// To track this we use a column `low_hours_warning_sent` on the trainings table.
// See schema note below — you need to add this column before this cron runs.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const LOW_HOURS_THRESHOLD = 2 // hours

export async function GET(request: Request) {
  // Verify the request is from Vercel Cron
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Find active trainings where hours remaining < threshold
  // and warning hasn't been sent yet for this training
  const { data: trainings, error } = await supabase
    .from('trainings')
    .select(`
      id,
      total_hours,
      hours_consumed,
      student_id,
      students:student_id ( full_name, email )
    `)
    .eq('status', 'active')
    .eq('low_hours_warning_sent', false)

  if (error) {
    console.error('Error fetching trainings for low hours check:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  let sentCount = 0

  for (const training of trainings ?? []) {
    const hoursRemaining = training.total_hours - training.hours_consumed

    // Only send if actually below threshold
    if (hoursRemaining >= LOW_HOURS_THRESHOLD) continue

    const student = Array.isArray(training.students)
      ? training.students[0]
      : training.students

    if (!student) continue

    try {
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online — You have less than 2 hours remaining',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          subject: 'You have less than 2 hours remaining',
          bodyHtml: studentLowHoursEmailContent(hoursRemaining),
        }),
      })

      // Mark warning as sent so we don't email them again for this training
      await supabase
        .from('trainings')
        .update({ low_hours_warning_sent: true })
        .eq('id', training.id)

      sentCount++
    } catch (err) {
      console.error(`Failed to send low hours warning for training ${training.id}:`, err)
    }
  }

  return NextResponse.json({ ok: true, sent: sentCount })
}
