'use client'

import { useState, useEffect } from 'react'
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

interface StudentLeftNavProps {
  unreadMessageCount?: number
  userId?: string
}

export default function StudentLeftNav({ unreadMessageCount = 0, userId }: StudentLeftNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const [liveUnreadCount, setLiveUnreadCount] = useState(unreadMessageCount)

  useEffect(() => {
    setLiveUnreadCount(unreadMessageCount)
  }, [unreadMessageCount])

  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`student-nav-unread-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.${userId}`,
      }, () => {
        setLiveUnreadCount(prev => prev + 1)
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.${userId}`,
      }, (payload) => {
        if (payload.new.read_at && !payload.old.read_at) {
          setLiveUnreadCount(prev => Math.max(0, prev - 1))
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId, supabase])

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
        <Link href="/student/my-classes" prefetch={false} style={{ display: 'flex' }}>
          <img src="/lingualink-logo-clean.svg" alt="Lingualink Online" style={{ height: '56px', width: 'auto' }} />
        </Link>
      </div>

      <div className="thin-scroll" style={{ flex: 1, padding: '12px 0', overflowY: 'auto', borderRight: '1px solid #E0DFDC', borderTop: 'none' }}>
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + '/')
          const Icon = item.icon

          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
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
                clipPath: isActive ? 'polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)' : undefined,
              }}
            >
              <Icon
                size={16}
                style={{ color: isActive ? '#ffffff' : '#9ca3af' }}
              />
              {item.label}
              {item.label === 'Messages' && liveUnreadCount > 0 && (
                <span
                  style={{
                    marginLeft: 'auto',
                    backgroundColor: isActive ? '#ffffff' : '#FF8303',
                    color: isActive ? '#FF8303' : '#ffffff',
                    fontSize: '10px',
                    fontWeight: 700,
                    minWidth: '18px',
                    height: '18px',
                    borderRadius: '9999px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 4px',
                  }}
                >
                  {liveUnreadCount > 9 ? '9+' : liveUnreadCount}
                </span>
              )}
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
