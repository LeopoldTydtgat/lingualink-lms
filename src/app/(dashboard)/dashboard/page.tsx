// src/app/(dashboard)/dashboard/page.tsx
// Redirects to the real Upcoming Classes page.
import { redirect } from 'next/navigation'

export default function DashboardPage() {
  redirect('/upcoming-classes')
}
