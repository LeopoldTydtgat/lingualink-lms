import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Keys we manage through this endpoint
const ALLOWED_KEYS = [
  'min_available_hours',
  'admin_email',
  'invoice_upload_start',
  'invoice_upload_end',
  'payment_timeline_days',
  'low_balance_threshold',
  'default_cancellation_window',
]

export async function GET() {
  const supabase = await createClient()

  // Confirm the user is an admin before returning settings
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin = Array.isArray(profile?.account_types) &&
    (profile.account_types.includes('school_admin') || profile.account_types.includes('admin'))

  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch all settings rows for our allowed keys
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ALLOWED_KEYS)

  if (error) {
    console.error('Settings GET error:', error)
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 })
  }

  // Convert array of { key, value } rows into a plain object for the client
  const settingsMap: Record<string, string> = {}
  if (data) {
    for (const row of data) {
      settingsMap[row.key] = row.value
    }
  }

  return NextResponse.json({ settings: settingsMap })
}

export async function POST(request: Request) {
  const supabase = await createClient()

  // Admin check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin = Array.isArray(profile?.account_types) &&
    (profile.account_types.includes('school_admin') || profile.account_types.includes('admin'))

  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()

  // Validate — only accept keys from the allowed list
  const updates: { key: string; value: string }[] = []

  for (const key of ALLOWED_KEYS) {
    if (key in body) {
      const raw = body[key]
      // Coerce to string for the key/value store
      updates.push({ key, value: String(raw) })
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })
  }

  // Upsert each setting using the key as the conflict target
  for (const update of updates) {
    const { error } = await supabase
      .from('settings')
      .upsert({ key: update.key, value: update.value }, { onConflict: 'key' })

    if (error) {
      console.error(`Settings upsert error for key "${update.key}":`, error)
      return NextResponse.json(
        { error: `Failed to save setting: ${update.key}` },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ success: true })
}
