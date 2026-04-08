import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

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

  // Special action: mark complete
  if (body.action === 'complete') {
    const { data: task, error } = await supabase
      .from('admin_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Task complete error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ task })
  }

  // Special action: reopen
  if (body.action === 'reopen') {
    const { data: task, error } = await supabase
      .from('admin_tasks')
      .update({ status: 'open', completed_at: null })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Task reopen error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ task })
  }

  // General field update
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

  const updates: Record<string, any> = {}
  if (title !== undefined) updates.title = title.trim()
  if (linked_entity_type !== undefined) updates.linked_entity_type = linked_entity_type || null
  if (linked_entity_id !== undefined) updates.linked_entity_id = linked_entity_id || null
  if (assigned_to !== undefined) updates.assigned_to = assigned_to
  if (due_date !== undefined) updates.due_date = due_date || null
  if (priority !== undefined) updates.priority = priority
  if (follow_up_reason !== undefined) updates.follow_up_reason = follow_up_reason
  if (notes !== undefined) updates.notes = notes?.trim() || null

  const { data: task, error } = await supabase
    .from('admin_tasks')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('Task PATCH error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ task })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  // Only school_admin can delete tasks
  const hasAccess = profile?.account_types?.includes('school_admin')
  if (!hasAccess) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { error } = await supabase
    .from('admin_tasks')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('Task DELETE error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
