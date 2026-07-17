'use client'

import { useState, useEffect } from 'react'
import Link, { useLinkStatus } from 'next/link'
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
  Loader2,
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

// Rendered INSIDE the <Link> so useLinkStatus() reports that link's pending
// state. While the clicked route loads, dim the row and swap the icon for a
// spinner. `student-nav-icon` stays on the icon so hover-translate still works.
function StudentNavContent({
  Icon,
  label,
  active,
  unreadCount,
}: {
  Icon: React.ElementType
  label: string
  active: boolean
  unreadCount: number
}) {
  const { pending } = useLinkStatus()
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        width: '100%',
        transition: 'opacity .18s ease',
        opacity: pending ? 0.55 : 1,
        // Mirror LeftNav's pending-orange cue. Active rows are white-on-orange, so
        // orange text there would be invisible — restrict the tint to inactive rows;
        // the active spinner already stays white. Inline style, never a Tailwind class.
        color: pending && !active ? '#FF8303' : undefined,
      }}
    >
      {pending ? (
        <Loader2 size={18} className="animate-spin" style={{ color: active ? '#ffffff' : '#9ca3af' }} />
      ) : (
        <Icon
          size={18}
          className={!active ? 'student-nav-icon' : undefined}
          style={{ color: active ? '#ffffff' : '#9ca3af' }}
        />
      )}
      {label}
      {label === 'Messages' && unreadCount > 0 && (
        <span
          style={{
            marginLeft: 'auto',
            backgroundColor: active ? '#ffffff' : '#FF8303',
            color: active ? '#FF8303' : '#ffffff',
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
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </span>
  )
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
      <style>{`
        .student-nav-item { transition: background-color .18s ease; }
        .student-nav-item:hover { background-color: rgba(0,0,0,0.04); }
        .student-nav-icon { transition: transform .18s ease; }
        .student-nav-item:hover .student-nav-icon { transform: translateX(2px); }
        @media (prefers-reduced-motion: reduce) {
          .student-nav-item, .student-nav-icon { transition: none; }
          .student-nav-item:hover .student-nav-icon { transform: none; }
        }
      `}</style>
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
              className={!isActive ? 'student-nav-item' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 12px',
                margin: '2px 8px',
                fontSize: '14px',
                fontWeight: isActive ? '600' : '500',
                color: isActive ? '#ffffff' : '#4b5563',
                backgroundColor: isActive ? '#FF8303' : undefined,
                textDecoration: 'none',
                borderRadius: '6px',
                clipPath: isActive ? 'polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)' : undefined,
              }}
            >
              <StudentNavContent
                Icon={Icon}
                label={item.label}
                active={isActive}
                unreadCount={liveUnreadCount}
              />
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
          <LogOut size={18} style={{ color: '#9ca3af' }} />
          Log Out
        </button>
      </div>
    </nav>
  )
}
