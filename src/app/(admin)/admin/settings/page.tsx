import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Settings } from 'lucide-react'
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
]

export default async function AdminSettingsPage() {
  const supabase = await createClient()

  // Auth check — redirect away if not an admin
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_types')
    .eq('id', user.id)
    .single()

  const isAdmin = Array.isArray(profile?.account_types) &&
    (profile.account_types.includes('school_admin') || profile.account_types.includes('admin'))

  if (!isAdmin) redirect('/dashboard')

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

  return (
    <div className="p-6 max-w-3xl">

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-8">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg"
          style={{ backgroundColor: '#fff3e0' }}
        >
          <Settings className="h-5 w-5" style={{ color: '#FF8303' }} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Platform Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure thresholds, windows, and defaults used across the platform.
          </p>
        </div>
      </div>

      {/* ── Settings form ───────────────────────────────────────────── */}
      <SettingsClient initialSettings={initialSettings} />

    </div>
  )
}
