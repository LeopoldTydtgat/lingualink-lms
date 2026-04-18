import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  await supabase.from('profiles').select('id').limit(1)
  return NextResponse.json({ ok: true }, { status: 200 })
}
