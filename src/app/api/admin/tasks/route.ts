import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // Verify admin/staff role
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const allowedRoles = ['school_admin', 'staff', 'hr_admin']
  const hasAccess = profile?.account_types?.some((r: string) => allowedRoles.includes(r))
  if (!hasAccess) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const assignee = searchParams.get('assignee')       // profile id
  const status = searchParams.get('status')           // 'open' | 'completed'
  const priority = searchParams.get('priority')       // 'low' | 'medium' | 'high'
  const linkedType = searchParams.get('linkedType')   // 'teacher' | 'student'
  const linkedId = searchParams.get('linkedId')       // uuid — used when fetching from detail pages

  let query = supabase
    .from('admin_tasks')
    .select(`
      id,
      title,
      linked_entity_type,
      linked_entity_id,
      assigned_to,
      due_date,
      priority,
      follow_up_reason,
      notes,
      status,
      completed_at,
      created_by,
      created_at
    `)
    .order('created_at', { ascending: false })

  if (assignee) query = query.eq('assigned_to', assignee)
  if (status) query = query.eq('status', status)
  if (priority) query = query.eq('priority', priority)
  if (linkedType) query = query.eq('linked_entity_type', linkedType)
  if (linkedId) query = query.eq('linked_entity_id', linkedId)

  const { data: tasks, error } = await query

  if (error) {
    console.error('Tasks GET error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Resolve assigned_to and created_by names in one batch query
  const profileIds = Array.from(new Set([
    ...tasks.map((t: any) => t.assigned_to).filter(Boolean),
    ...tasks.map((t: any) => t.created_by).filter(Boolean),
  ]))

  let profileMap: Record<string, string> = {}
  if (profileIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', profileIds)

    if (profiles) {
      profiles.forEach((p: any) => { profileMap[p.id] = p.full_name })
    }
  }

  // Resolve linked entity names — teachers are in profiles, students in students table
  const teacherLinkedIds = tasks
    .filter((t: any) => t.linked_entity_type === 'teacher' && t.linked_entity_id)
    .map((t: any) => t.linked_entity_id)

  const studentLinkedIds = tasks
    .filter((t: any) => t.linked_entity_type === 'student' && t.linked_entity_id)
    .map((t: any) => t.linked_entity_id)

  let teacherNameMap: Record<string, string> = {}
  let studentNameMap: Record<string, string> = {}

  if (teacherLinkedIds.length > 0) {
    const { data: tProfiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', teacherLinkedIds)
    if (tProfiles) tProfiles.forEach((p: any) => { teacherNameMap[p.id] = p.full_name })
  }

  if (studentLinkedIds.length > 0) {
    const { data: sStudents } = await supabase
      .from('students')
      .select('id, full_name')
      .in('id', studentLinkedIds)
    if (sStudents) sStudents.forEach((s: any) => { studentNameMap[s.id] = s.full_name })
  }

  const enriched = tasks.map((t: any) => {
    let linkedName: string | null = null
    if (t.linked_entity_type === 'teacher') linkedName = teacherNameMap[t.linked_entity_id] ?? null
    if (t.linked_entity_type === 'student') linkedName = studentNameMap[t.linked_entity_id] ?? null

    return {
      ...t,
      assigned_to_name: profileMap[t.assigned_to] ?? null,
      created_by_name: profileMap[t.created_by] ?? null,
      linked_entity_name: linkedName,
    }
  })

  return NextResponse.json({ tasks: enriched })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const allowedRoles = ['school_admin', 'staff', 'hr_admin']
  const hasAccess = profile?.account_types?.some((r: string) => allowedRoles.includes(r))
  if (!hasAccess) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json()
  const {
    title,
    linked_entity_type,
    linked_entity_id,
    assigned_to,
    due_date,
    priority,
    follow_up_reason,
    notes,
  } = body

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }
  if (!priority) {
    return NextResponse.json({ error: 'Priority is required' }, { status: 400 })
  }
  if (!follow_up_reason) {
    return NextResponse.json({ error: 'Follow-up reason is required' }, { status: 400 })
  }

  const { data: task, error } = await supabase
    .from('admin_tasks')
    .insert({
      title: title.trim(),
      linked_entity_type: linked_entity_type || null,
      linked_entity_id: linked_entity_id || null,
      assigned_to: assigned_to || user.id,
      due_date: due_date || null,
      priority,
      follow_up_reason,
      notes: notes?.trim() || null,
      status: 'open',
      created_by: user.id,
    })
    .select()
    .single()

  if (error) {
    console.error('Task POST error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ task }, { status: 201 })
}
