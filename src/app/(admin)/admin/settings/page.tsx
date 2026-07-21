import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/requireAdmin'
import { redirect } from 'next/navigation'
import SettingsClient from './SettingsClient'

// Keys we display on this page — must match the API route
const SETTING_KEYS = [
  'min_available_hours',
  'admin_email',
  'invoice_upload_start',
  'invoice_upload_end',
  'payment_timeline_days',
  'low_balance_threshold',
  'default_cancellation_window',
  'export_timezone',
]

export default async function AdminSettingsPage() {
  const supabase = await createClient()

  // Auth check — redirect away if not an admin
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const adminUser = await requireAdmin()
  if (!adminUser) redirect('/dashboard')

  // Fetch current settings from Supabase
  const { data: rows } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', SETTING_KEYS)

  // Convert array of rows to a plain object
  const initialSettings: Record<string, string> = {}
  if (rows) {
    for (const row of rows) {
      initialSettings[row.key] = row.value
    }
  }

  return <SettingsClient initialSettings={initialSettings} />
}
