'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { SubmitReportSchema, type SubmitReportInput } from '@/lib/validation/schemas'

export async function reopenReport(reportId: string) {
  const supabase = await createClient()

  // Only admins can reopen reports — check the role first
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, account_types')
    .eq('id', user.id)
    .single()

  // Mirror the admin route's exact admin check
  // (src/app/api/admin/reports/[id]/route.ts):
  //   role === 'admin' || account_types includes 'school_admin'
  const isAdmin =
    profile?.role === 'admin' ||
    (Array.isArray(profile?.account_types) && profile.account_types.includes('school_admin'))

  if (!isAdmin) return { error: 'Not authorised' }

  // Only flagged reports may be reopened — matches the admin route's guard so
  // both admin reopen paths behave identically (NEW270).
  const { data: existing } = await supabase
    .from('reports')
    .select('id, status')
    .eq('id', reportId)
    .single()

  if (!existing) return { error: 'Report not found' }
  if (existing.status !== 'flagged') {
    return { error: 'Only flagged reports can be reopened' }
  }

  const { error } = await supabase
    .from('reports')
    .update({
      status: 'reopened',
      flagged_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', reportId)

  if (error) return { error: error.message }

  // Refresh the reports page so the list updates immediately
  revalidatePath('/reports')
  return { success: true }
}

export async function submitReport(reportId: string, payload: SubmitReportInput) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const parsed = SubmitReportSchema.safeParse(payload)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { error: first?.message ?? 'Invalid report payload' }
  }

  // Auth gate: caller must be the report's teacher or an admin.
  const { data: report, error: fetchErr } = await supabase
    .from('reports')
    .select('id, teacher_id, status')
    .eq('id', reportId)
    .single()

  if (fetchErr || !report) return { error: 'Report not found' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin'
  if (!isAdmin && report.teacher_id !== user.id) {
    return { error: 'Not authorised' }
  }

  // Decide the lesson status from the report payload.
  // did_class_happen=true             -> 'completed'
  // did_class_happen=false, student   -> 'student_no_show'
  // did_class_happen=false, teacher   -> 'teacher_no_show'
  let lessonStatus: 'completed' | 'student_no_show' | 'teacher_no_show'
  if (parsed.data.did_class_happen) {
    lessonStatus = 'completed'
  } else if (parsed.data.no_show_type === 'teacher') {
    lessonStatus = 'teacher_no_show'
  } else {
    lessonStatus = 'student_no_show'
  }

  // RPC writes the report fields and the lesson status atomically.
  // Cancelled lessons are protected by the RPC's WHERE clause.
  const { error: rpcErr } = await supabase.rpc('complete_report_atomic', {
    p_report_id: reportId,
    p_lesson_status: lessonStatus,
    p_report_payload: {
      did_class_happen: parsed.data.did_class_happen,
      no_show_type: parsed.data.no_show_type,
      feedback_text: parsed.data.feedback_text,
      additional_details: parsed.data.additional_details,
      level_data: parsed.data.level_data,
      student_confirmed: parsed.data.student_confirmed,
      impersonation_note: parsed.data.impersonation_note,
    },
  })

  if (rpcErr) return { error: rpcErr.message }

  revalidatePath('/reports')
  revalidatePath(`/reports/${reportId}`)
  return { success: true }
}