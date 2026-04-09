'use client'

import Link from 'next/link'
import Image from 'next/image'
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
        borderRight: 'none',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        height: '100vh',
      }}
    >
      {/* Logo area - matches the height of the orange header on the right */}
      <div
        style={{
          height: '72px', background: 'linear-gradient(to right, #ffffff, #fff3e8)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px', justifyContent: 'center',
          
          flexShrink: 0,
        }}
      >
        <Link href="/student/my-classes" style={{ display: 'flex' }}>
          <img src="/lingualink-logo-clean.svg" alt="Lingualink Online" style={{ height: '56px', width: 'auto' }} />
        </Link>
      </div>

      <div style={{ flex: 1, padding: '12px 0', overflowY: 'auto', borderRight: '1px solid #E0DFDC', borderTop: 'none' }}>
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
          borderTop: '1px solid #E0DFDC', borderRight: '1px solid #E0DFDC',
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







