'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  CalendarDays,
  Clock,
  TrendingUp,
  MessageSquare,
  BookOpen,
  User,
  LogOut,
} from 'lucide-react'

const navItems = [
  { label: 'My Classes',   href: '/student/my-classes',   icon: CalendarDays },
  { label: 'Past Classes', href: '/student/past-classes', icon: Clock },
  { label: 'Progress',     href: '/student/progress',     icon: TrendingUp },
  { label: 'Messages',     href: '/student/messages',     icon: MessageSquare },
  { label: 'Study',        href: '/student/study',        icon: BookOpen },
  { label: 'My Account',   href: '/student/account',      icon: User },
]

export default function StudentLeftNav() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/student/login')
  }

  return (
    <nav
      style={{
        width: '220px',
        minWidth: '220px',
        backgroundColor: '#ffffff',
        borderRight: '1px solid #E0DFDC',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 0',
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1 }}>
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + '/')
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 12px',
                margin: '2px 8px',
                fontSize: '14px',
                fontWeight: isActive ? '600' : '500',
                color: isActive ? '#ffffff' : '#4b5563',
                backgroundColor: isActive ? '#FF8303' : 'transparent',
                textDecoration: 'none',
                borderRadius: '6px',
              }}
            >
              <Icon
                size={16}
                style={{ color: isActive ? '#ffffff' : '#9ca3af' }}
              />
              {item.label}
            </Link>
          )
        })}
      </div>

      <div
        style={{
          borderTop: '1px solid #E0DFDC',
          padding: '8px 8px 0',
        }}
      >
        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            width: '100%',
            fontSize: '14px',
            fontWeight: '500',
            color: '#4b5563',
            background: 'none',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <LogOut size={16} style={{ color: '#9ca3af' }} />
          Log Out
        </button>
      </div>
    </nav>
  )
}
