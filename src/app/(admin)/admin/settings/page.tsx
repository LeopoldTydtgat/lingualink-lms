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
  const { data: rows, error: settingsError } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', SETTING_KEYS)

  // A read error must throw to the retryable error boundary, never fall
  // through: an errored null is indistinguishable from "nothing saved yet",
  // so SettingsClient would render its hard-coded DEFAULTS as though they
  // were the stored values — and an admin who then hits Save would persist
  // those defaults over the real policy. Zero rows is a legitimate empty
  // read and still falls through to the defaults below.
  if (settingsError) {
    console.error('[admin/settings] settings lookup failed:', settingsError)
    throw new Error('Failed to load settings')
  }

  // Convert array of rows to a plain object
  const initialSettings: Record<string, string> = {}
  if (rows) {
    for (const row of rows) {
      initialSettings[row.key] = row.value
    }
  }

  return <SettingsClient initialSettings={initialSettings} />
}
