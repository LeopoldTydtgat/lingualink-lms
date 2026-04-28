import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'LinguaLink Online - Student Portal',
  description: 'Student portal for LinguaLink Online',
}

export default function StudentAuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
