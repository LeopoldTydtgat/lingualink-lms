import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    // --- 1. Verify the requesting user is an admin ---
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('account_types, role')
      .eq('id', user.id)
      .single()

    const isAdmin =
      adminProfile?.role === 'admin' ||
      (adminProfile?.account_types ?? []).includes('school_admin')

    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // --- 2. Fetch the current profile to build history log ---
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: current, error: fetchError } = await adminClient
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Teacher not found.' }, { status: 404 })
    }

    // --- 3. Build history log entries for changed fields ---
    // Strip admin_notes from history — too sensitive to log in plain text
    const SKIP_FIELDS = ['admin_notes', 'updated_at', 'created_at']
    const historyEntries = Object.entries(body)
      .filter(([key]) => !SKIP_FIELDS.includes(key))
      .filter(([key, newVal]) => {
        const oldVal = current[key]
        // Compare as strings to catch array and numeric differences
        return JSON.stringify(oldVal) !== JSON.stringify(newVal)
      })
      .map(([key, newVal]) => ({
        teacher_id: id,
        field_name: key,
        old_value: current[key] != null ? String(current[key]) : null,
        new_value: newVal != null ? String(newVal) : null,
        changed_by: user.id,
        changed_at: new Date().toISOString(),
      }))

    // --- 4. Update the profile ---
    const { error: updateError } = await adminClient
      .from('profiles')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (updateError) {
      console.error('Profile update error:', updateError)
      return NextResponse.json({ error: 'Failed to update teacher.' }, { status: 500 })
    }

    // --- 5. Insert history log entries ---
    if (historyEntries.length > 0) {
      const { error: historyError } = await adminClient
        .from('teacher_history_log')
        .insert(historyEntries)

      if (historyError) {
        // Non-fatal — log but don't fail the request
        console.error('History log error:', historyError)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('PATCH teacher error:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}