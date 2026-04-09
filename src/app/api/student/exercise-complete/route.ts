import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  // Verify the user is authenticated
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await req.json()
  const { studentId, sheetId, assignmentId, score } = body

  if (!studentId || !sheetId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  // Verify this student belongs to the authenticated user (prevent spoofing)
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('id', studentId)
    .eq('auth_user_id', user.id)
    .single()

  if (!student) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Insert the completion record
  const { error } = await supabase.from('exercise_completions').insert({
    student_id: studentId,
    sheet_id: sheetId,
    assignment_id: assignmentId ?? null,
    completed_at: new Date().toISOString(),
    score: score ?? null,
  })

  if (error) {
    console.error('exercise_completions insert error:', error)
    return NextResponse.json({ error: 'Failed to save completion' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
