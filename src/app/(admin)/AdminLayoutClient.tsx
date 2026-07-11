'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  Building2,
  CalendarDays,
  FileText,
  MessageSquare,
  Headphones,
  CreditCard,
  BookOpen,
  Megaphone,
  CheckSquare,
  Download,
  Settings,
  ArrowLeft,
  LogOut,
  Menu,
} from 'lucide-react'
import type { RightPanelStats } from './layout'
import IdleTimeoutWatcher from '@/components/IdleTimeoutWatcher'

interface Profile {
  id: string
  full_name: string
  role: string
  photo_url: string | null
}

interface ProtectedLesson {
  scheduled_at: string
  duration_minutes: number | null
}

interface AdminLayoutClientProps {
  profile: Profile
  rightPanelStats: RightPanelStats
  unreadMessagesCount: number
  unreadSupportCount: number
  protectedLesson: ProtectedLesson | null
  children: React.ReactNode
}

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/admin/teachers', label: 'Teachers', icon: Users },
  { href: '/admin/students', label: 'Students', icon: GraduationCap },
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/classes', label: 'Classes', icon: CalendarDays },
  { href: '/admin/reports', label: 'Reports', icon: FileText },
  { href: '/admin/messages', label: 'Messages', icon: MessageSquare },
  { href: '/admin/support', label: 'Support', icon: Headphones },
  { href: '/admin/billing', label: 'Billing', icon: CreditCard },
  { href: '/admin/library', label: 'Library', icon: BookOpen },
  { href: '/admin/announcements', label: 'Announcements', icon: Megaphone },
  { href: '/admin/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/admin/exports', label: 'Exports', icon: Download },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
]

export default function AdminLayoutClient({
  profile,
  rightPanelStats,
  unreadMessagesCount,
  unreadSupportCount,
  protectedLesson,
  children,
}: AdminLayoutClientProps) {
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [liveUnreadMessages, setLiveUnreadMessages] = useState(unreadMessagesCount)
  const [liveUnreadSupport, setLiveUnreadSupport] = useState(unreadSupportCount)

  const supabaseRef = useRef(createClient())

  const adminPanelRef = useRef<HTMLElement>(null)

  const handleAdminPanelWheel = (e: React.WheelEvent<HTMLElement>) => {
    const panel = adminPanelRef.current
    if (!panel) return
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight
    const atTop = panel.scrollTop === 0
    if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return
    document.querySelector('main')?.scrollBy({ top: e.deltaY })
  }

  useEffect(() => {
    const supabase = supabaseRef.current
    const channel = supabase
      .channel('admin-nav-unread')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
      }, (payload) => {
        if (payload.new.read_at && !payload.old.read_at) {
          setLiveUnreadMessages(prev => Math.max(0, prev - 1))
        }
      })
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      }, () => {
        setLiveUnreadMessages(prev => prev + 1)
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'support_messages',
      }, (payload) => {
        if (payload.new.read_at && !payload.old.read_at) {
          setLiveUnreadSupport(prev => Math.max(0, prev - 1))
        }
      })
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'support_messages',
      }, (payload) => {
        if (payload.new.sender_role === 'user') {
          setLiveUnreadSupport(prev => prev + 1)
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  const handleLogout = async () => {
    await supabaseRef.current.auth.signOut()
    // Login route lives on the teacher portal — must be a full nav, not router.push
    const teacherUrl = process.env.NEXT_PUBLIC_TEACHER_URL
    window.location.href = teacherUrl ? `${teacherUrl}/login` : '/login'
  }

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  const NavLink = ({ item }: { item: (typeof navItems)[0] }) => {
    const active = isActive(item.href, item.exact)
    const Icon = item.icon
    const showBadge =
          (item.href === '/admin/messages' && liveUnreadMessages > 0) ||
          (item.href === '/admin/support' && liveUnreadSupport > 0)

        const badgeCount =
          item.href === '/admin/messages' ? liveUnreadMessages : liveUnreadSupport
    return (
      <Link
        href={item.href}
        prefetch={false}
        onClick={() => setSidebarOpen(false)}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
        style={
          active
            ? { backgroundColor: '#FF8303', color: '#ffffff', clipPath: 'polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)' }
            : { color: '#9ca3af' }
        }
      >
        <Icon size={18} style={active ? { color: '#ffffff' } : { color: '#9ca3af' }} />
        <span className="flex-1">{item.label}</span>
        {showBadge && (
          <span
            style={{
              backgroundColor: active ? '#ffffff' : '#FF8303',
              color: active ? '#FF8303' : '#ffffff',
              fontSize: '11px',
              minWidth: '18px',
              height: '18px',
              borderRadius: '9999px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingLeft: '4px',
              paddingRight: '4px',
              fontWeight: 600,
              lineHeight: 1,
            }}
          >
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </Link>
    )
  }

  const Sidebar = () => (
    <div className="flex flex-col h-full">
      <div
        style={{
          height: '72px',
          background: 'linear-gradient(to right, #ffffff, #fff3e8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          borderBottom: '1px solid rgba(255,131,3,0.15)',
        }}
      >
        <Link href="/admin" prefetch={false}>
          <img
            src="/lingualink-logo-clean.svg"
            alt="Lingualink Online"
            style={{ height: '56px', width: 'auto' }}
          />
        </Link>
      </div>
      <nav className="flex-1 px-3 pt-6 space-y-1 overflow-y-auto thin-scroll">
        {navItems.map((item) => (
          <NavLink key={item.href} item={item} />
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-gray-700 space-y-1">
        <Link
          href="/dashboard"
          prefetch={false}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
          style={{ color: '#9ca3af' }}
        >
          <ArrowLeft size={18} style={{ color: '#9ca3af' }} />
          Back to Teacher Portal
        </Link>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
          style={{ color: '#9ca3af' }}
        >
          <LogOut size={18} style={{ color: '#9ca3af' }} />
          Log Out
        </button>
      </div>
    </div>
  )

  const panelWidgets = [
    { label: 'Classes Today', value: rightPanelStats.classesTodayCount, href: rightPanelStats.classesTodayCount === null ? '/admin/settings' : '/admin/classes', alert: false },
    { label: 'Pending Reports', value: rightPanelStats.pendingCount, href: '/admin/reports?filter=pending', alert: false },
    { label: 'Flagged Reports', value: rightPanelStats.flaggedCount, href: '/admin/reports?filter=flagged', alert: rightPanelStats.flaggedCount > 0 },
    { label: 'Low Hours Students', value: rightPanelStats.lowHoursCount, href: '/admin/students?filter=low_hours', alert: false },
    { label: 'Invoices to Review', value: rightPanelStats.invoicesToReviewCount, href: '/admin/billing', alert: false },
  ]

  return (
    <div className="flex flex-col h-screen overflow-hidden">

      {/* Full-width header across the top */}
      <header
        className="flex items-center justify-between px-6 flex-shrink-0 w-full"
        style={{
          background: 'linear-gradient(to right, #ffffff 0%, #fff3e8 18%, #FF8303 32%)',
          height: '72px',
          zIndex: 10,
        }}
      >
        <Link href="/admin" prefetch={false}>
          <img
            src="/lingualink-logo-clean.svg"
            alt="Lingualink Online"
            style={{ height: '56px', width: 'auto' }}
          />
        </Link>
        <div className="flex items-center gap-3">
          <button className="lg:hidden text-white mr-2" onClick={() => setSidebarOpen(true)}>
            <Menu size={22} />
          </button>
          <span className="text-white text-sm font-medium hidden sm:block">
            Hello {profile.full_name?.split(' ')[0]}!
          </span>
          <Link href="/admin/settings" prefetch={false}>
            {profile.photo_url ? (
              <img
                src={profile.photo_url}
                alt={profile.full_name}
                className="w-8 h-8 rounded-full object-cover border-2 border-white/50"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white text-sm font-bold">
                {profile.full_name?.charAt(0).toUpperCase()}
              </div>
            )}
          </Link>
        </div>
      </header>

      {/* Below header: sidebar + content */}
      <div className="flex flex-1 min-h-0">

        {/* Desktop sidebar */}
        <aside className="hidden lg:flex flex-col w-56 flex-shrink-0 bg-gray-900">
          <nav className="flex-1 px-3 pt-4 space-y-1 overflow-y-auto admin-sidebar-scroll">
            {navItems.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </nav>
          <div className="px-3 py-4 border-t border-gray-700 space-y-1">
            <Link
              href="/dashboard"
              prefetch={false}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{ color: '#9ca3af' }}
            >
              <ArrowLeft size={18} style={{ color: '#9ca3af' }} />
              Back to Teacher Portal
            </Link>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{ color: '#9ca3af' }}
            >
              <LogOut size={18} style={{ color: '#9ca3af' }} />
              Log Out
            </button>
          </div>
        </aside>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="fixed inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
            <aside className="relative flex flex-col w-56 bg-gray-900 z-50">
              <nav className="flex-1 px-3 pt-4 space-y-1 overflow-y-auto admin-sidebar-scroll">
                {navItems.map((item) => (
                  <NavLink key={item.href} item={item} />
                ))}
              </nav>
              <div className="px-3 py-4 border-t border-gray-700 space-y-1">
                <Link
                  href="/dashboard"
                  prefetch={false}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium"
                  style={{ color: '#9ca3af' }}
                >
                  <ArrowLeft size={18} style={{ color: '#9ca3af' }} />
                  Back to Teacher Portal
                </Link>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium"
                  style={{ color: '#9ca3af' }}
                >
                  <LogOut size={18} style={{ color: '#9ca3af' }} />
                  Log Out
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto thin-scroll">
          <div className="max-w-6xl mx-auto">
            {children}
          </div>
        </main>

        {/* Right panel */}
        <aside ref={adminPanelRef} onWheel={handleAdminPanelWheel} className="hidden xl:flex flex-col w-56 flex-shrink-0 border-l border-gray-200 p-4 overflow-y-auto thin-scroll" style={{ backgroundColor: '#FFFCF8' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <div style={{ width: '3px', height: '14px', backgroundColor: '#FF8303', borderRadius: '2px', flexShrink: 0 }} />
            <p style={{ fontSize: '11px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>At a Glance</p>
          </div>
          <div className="space-y-3">
            {panelWidgets.map((w) => (
              <Link key={w.label} href={w.href} prefetch={false}>
                <div className="rounded-lg p-3 bg-gray-50 border border-gray-200 hover:border-orange-200 transition-colors">
                  <p className="text-xs text-gray-500">{w.label}</p>
                  <p className="text-xl font-bold mt-0.5" style={{ color: w.alert ? '#dc2626' : '#111827' }}>
                    {w.value === null ? (
                      <span className="text-sm font-medium" style={{ color: '#9ca3af' }}>Set timezone</span>
                    ) : (
                      w.value
                    )}
                  </p>
                </div>
              </Link>
            ))}
          </div>
          {rightPanelStats.activeAnnouncementText && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Announcement
              </p>
              <p className="text-xs text-gray-600 leading-relaxed line-clamp-4">
                {rightPanelStats.activeAnnouncementText}
              </p>
              <Link href="/admin/announcements" prefetch={false} className="text-xs mt-1 inline-block hover:underline" style={{ color: '#FF8303' }}>
                Manage
              </Link>
            </div>
          )}
        </aside>
      </div>

      <IdleTimeoutWatcher
        nextLessonStartIso={protectedLesson?.scheduled_at ?? null}
        nextLessonDurationMinutes={protectedLesson?.duration_minutes ?? null}
        loginPath="/login"
      />
    </div>
  )
}
