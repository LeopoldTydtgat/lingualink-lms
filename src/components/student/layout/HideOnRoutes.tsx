// src/components/student/layout/HideOnRoutes.tsx
'use client'

import { usePathname } from 'next/navigation'

export default function HideOnRoutes({
  hideOn,
  children,
}: {
  hideOn: string[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
  if (hideOn.some((p) => pathname === p || pathname.startsWith(p + '/'))) return null
  return <>{children}</>
}
