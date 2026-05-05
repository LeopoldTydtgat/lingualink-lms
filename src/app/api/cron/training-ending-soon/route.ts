import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import resend from '@/lib/email/client'
import {
  buildEmailTemplate,
  studentTrainingEndingSoonEmailContent,
} from '@/lib/email/templates'
import { verifyCronAuth } from '@/lib/cron-auth'

// Called by Vercel Cron once per day.
// Finds active trainings whose end_date falls within the next 14 days
// and sends the student a single warning email (guarded by training_ending_soon_sent).
//
// Run this SQL before deploying:
// ALTER TABLE trainings ADD COLUMN IF NOT EXISTS training_ending_soon_sent boolean NOT NULL DEFAULT false;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const today = new Date()
  const in14Days = new Date(today)
  in14Days.setDate(today.getDate() + 14)

  // Format as YYYY-MM-DD without toISOString() to avoid timezone drift
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const in14DaysStr = `${in14Days.getFullYear()}-${pad(in14Days.getMonth() + 1)}-${pad(in14Days.getDate())}`

  const { data: trainings, error } = await supabase
    .from('trainings')
    .select(`
      id,
      end_date,
      student_id,
      students:student_id ( full_name, email )
    `)
    .not('status', 'in', '("completed","cancelled")')
    .gte('end_date', todayStr)
    .lte('end_date', in14DaysStr)
    .eq('training_ending_soon_sent', false)

  if (error) {
    console.error('Error fetching trainings for ending-soon check:', error)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  let sentCount = 0

  for (const training of trainings ?? []) {
    const student = Array.isArray(training.students)
      ? training.students[0]
      : training.students

    if (!student) continue

    // Format end_date as a readable string (end_date is a plain date, e.g. "2026-05-10")
    const [year, month, day] = (training.end_date as string).split('-').map(Number)
    const endDateFormatted = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(year, month - 1, day))

    try {
      await resend.emails.send({
        from: 'Lingualink Online <no-reply@lingualinkonline.com>',
        to: student.email,
        subject: 'Lingualink Online — Your training is ending soon',
        html: buildEmailTemplate({
          recipientName: student.full_name,
          recipientFallback: 'Student',
          subject: 'Your training is ending soon',
          bodyHtml: studentTrainingEndingSoonEmailContent(endDateFormatted),
          contactEmail: 'support@lingualinkonline.com',
        }),
      })

      await supabase
        .from('trainings')
        .update({ training_ending_soon_sent: true })
        .eq('id', training.id)

      sentCount++
    } catch (err) {
      console.error(`Failed to send training-ending-soon email for training ${training.id}:`, err)
    }
  }

  return NextResponse.json({ ok: true, sent: sentCount })
}
