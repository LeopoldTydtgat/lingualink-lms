'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

type HeaderShortcutProps = {
  href: string
  ariaLabel: string
  title: string
  children: React.ReactNode
}

export default function HeaderShortcut({ href, ariaLabel, title, children }: HeaderShortcutProps) {
  const pathname = usePathname()
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={ariaLabel}
      title={title}
      className="hover:bg-gray-100 rounded-lg p-2"
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => {
        if (pathname === href) e.preventDefault()
      }}
    >
      {children}
    </Link>
  )
}
