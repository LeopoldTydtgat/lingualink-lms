import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { verifyCronAuth } from '@/lib/cron-auth'

export async function GET(request: Request) {
  const authFail = verifyCronAuth(request)
  if (authFail) return authFail

  const supabase = await createClient()
  await supabase.from('profiles').select('id').limit(1)
  return NextResponse.json({ ok: true }, { status: 200 })
}
