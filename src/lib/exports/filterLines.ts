// src/lib/exports/filterLines.ts
//
// Shared "applied filters" header lines for the admin XLSX exports. Moved out of
// src/app/api/admin/exports/[type]/route.ts verbatim: a Next.js App Router route
// file may only export route handlers and route config, so a helper shared by two
// routes has to live in a lib module.

import { createClient } from '@/lib/supabase/server'

// Human-readable description of the filters actually applied, written into the
// workbook header block so a saved file is self-describing. IDs resolve to names
// through the cookie client (the route is already admin-gated). A missing row or
// a failed read degrades to the raw id — this must never throw and must never
// block an export.
export async function buildFilterLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  f: {
    fromDate: string | null
    toDate: string | null
    teacherId: string | null
    studentId: string | null
    companyId: string | null
  }
): Promise<string[]> {
  const lines: string[] = []

  if (f.fromDate || f.toDate) {
    lines.push(`Date range: ${f.fromDate || 'start'} to ${f.toDate || 'today'}`)
  }

  if (f.teacherId) {
    let name: string | null = null
    try {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', f.teacherId).maybeSingle()
      name = data?.full_name ?? null
    } catch {
      name = null
    }
    lines.push(`Teacher: ${name ?? f.teacherId}`)
  }

  if (f.studentId) {
    let name: string | null = null
    try {
      const { data } = await supabase.from('students').select('full_name').eq('id', f.studentId).maybeSingle()
      name = data?.full_name ?? null
    } catch {
      name = null
    }
    lines.push(`Student: ${name ?? f.studentId}`)
  }

  if (f.companyId) {
    let name: string | null = null
    try {
      const { data } = await supabase.from('companies').select('name').eq('id', f.companyId).maybeSingle()
      name = data?.name ?? null
    } catch {
      name = null
    }
    lines.push(`Company: ${name ?? f.companyId}`)
  }

  return lines
}
