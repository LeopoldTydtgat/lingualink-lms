'use client'

import { useState, useEffect, useRef } from 'react'
import Link, { useLinkStatus } from 'next/link'
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
  Loader2,
  Activity,
  ChevronDown,
} from 'lucide-react'
import type { RightPanelStats } from './layout'
import IdleTimeoutWatcher from '@/components/IdleTimeoutWatcher'
import { getUnreadAdminMessagesCount } from './admin/messages/actions'

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

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
  exact?: boolean
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    ],
  },
  {
    label: 'People',
    items: [
      { href: '/admin/teachers', label: 'Teachers', icon: Users },
      { href: '/admin/students', label: 'Students', icon: GraduationCap },
      { href: '/admin/companies', label: 'Companies', icon: Building2 },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/admin/classes', label: 'Classes', icon: CalendarDays },
      { href: '/admin/reports', label: 'Reports', icon: FileText },
      { href: '/admin/messages', label: 'Messages', icon: MessageSquare },
      { href: '/admin/support', label: 'Support', icon: Headphones },
      { href: '/admin/billing', label: 'Billing', icon: CreditCard },
    ],
  },
  {
    label: 'Content',
    items: [
      { href: '/admin/library', label: 'Library', icon: BookOpen },
      { href: '/admin/announcements', label: 'Announcements', icon: Megaphone },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/admin/tasks', label: 'Tasks', icon: CheckSquare },
      { href: '/admin/exports', label: 'Exports', icon: Download },
      { href: '/admin/settings', label: 'Settings', icon: Settings },
    ],
  },
]

// Rendered INSIDE the <Link> so useLinkStatus() reports that link's pending
// state. While the clicked route loads, dim the row and swap the icon for a
// spinner. Active styling (orange + colours) is passed in and preserved.
function AdminNavContent({
  Icon,
  label,
  active,
  showBadge,
  badgeCount,
}: {
  Icon: React.ElementType
  label: string
  active: boolean
  showBadge: boolean
  badgeCount: number
}) {
  const { pending } = useLinkStatus()
  return (
    <span
      className="flex items-center gap-3 w-full transition-opacity"
      style={{ opacity: pending ? 0.55 : 1 }}
    >
      {pending ? (
        <Loader2 size={18} className="animate-spin" style={{ color: active ? '#FF8303' : '#9ca3af' }} />
      ) : (
        <Icon size={18} style={active ? { color: '#FF8303' } : { color: '#9ca3af' }} />
      )}
      <span className="flex-1">{label}</span>
      {showBadge && (
        <span
          style={{
            backgroundColor: '#FF8303',
            color: '#ffffff',
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
    </span>
  )
}

// Module scope, not the component body: a component declared inside AdminLayoutClient
// is a new type on every render, so every Realtime unread-count change would unmount
// and remount the whole nav — resetting scroll and killing in-flight link spinners.
// Everything it used to close over now arrives as a prop.
function NavLink({
  item,
  active,
  unreadMessages,
  unreadSupport,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  unreadMessages: number
  unreadSupport: number
  onNavigate: () => void
}) {
  const Icon = item.icon
  const showBadge =
        (item.href === '/admin/messages' && unreadMessages > 0) ||
        (item.href === '/admin/support' && unreadSupport > 0)

      const badgeCount =
        item.href === '/admin/messages' ? unreadMessages : unreadSupport
  return (
    <Link
      href={item.href}
      prefetch={false}
      onClick={onNavigate}
      className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${active ? '' : 'text-gray-600 hover:bg-brand-grey hover:text-gray-900'}`}
      style={
        active
          ? {
              clipPath: 'polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)',
              backgroundColor: '#FFF0E0',
              color: '#FF8303',
              borderLeft: '3px solid #FF8303',
            }
          : { borderLeft: '3px solid transparent' }
      }
    >
      <AdminNavContent
        Icon={Icon}
        label={item.label}
        active={active}
        showBadge={showBadge}
        badgeCount={badgeCount}
      />
    </Link>
  )
}

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
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)

  const supabaseRef = useRef(createClient())
  const messagesRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesRefetchInFlightRef = useRef(false)

  const adminPanelRef = useRef<HTMLElement>(null)
  const profileMenuRef = useRef<HTMLDivElement>(null)

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

    // authenticated has zero column grants on messages.admin_read_at, so Realtime UPDATE
    // payloads never carry it — refetch the true count via the admin-client server action
    // instead of inspecting payload.new.admin_read_at. Debounced so a mark-all-read burst
    // of UPDATEs collapses into a single refetch.
    const refetchUnreadMessages = () => {
      if (messagesRefetchTimerRef.current) clearTimeout(messagesRefetchTimerRef.current)
      messagesRefetchTimerRef.current = setTimeout(async () => {
        if (messagesRefetchInFlightRef.current) return
        messagesRefetchInFlightRef.current = true
        try {
          const count = await getUnreadAdminMessagesCount()
          setLiveUnreadMessages(count)
        } catch {
          // Badge just skips this update; next INSERT/UPDATE or navigation will resync.
        } finally {
          messagesRefetchInFlightRef.current = false
        }
      }, 300)
    }

    const channel = supabase
      .channel('admin-nav-unread')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
      }, (payload) => {
        if (payload.new.sender_type === 'student' || payload.new.receiver_type === 'student') {
          refetchUnreadMessages()
        }
      })
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      }, (payload) => {
        if (
          payload.new.sender_type !== 'admin' &&
          (payload.new.sender_type === 'student' || payload.new.receiver_type === 'student')
        ) {
          setLiveUnreadMessages(prev => prev + 1)
        }
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

    return () => {
      supabase.removeChannel(channel)
      if (messagesRefetchTimerRef.current) clearTimeout(messagesRefetchTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!profileMenuOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileMenuOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [profileMenuOpen])

  // A failed sign-out must never look like a successful one. Previously a rejected
  // signOut() left the handler as an unhandled rejection: no navigation, no message,
  // and an admin who believes they are logged out while the session is still live —
  // the worst case being a shared machine. So the failure is stated explicitly.
  // The flag is cleared only in the catch, not a finally: on success the browser is
  // already navigating away and the button must stay disabled until it does.
  const handleLogout = async () => {
    setLoggingOut(true)
    setLogoutError(null)
    try {
      const { error } = await supabaseRef.current.auth.signOut()
      if (error) throw error
      // Login route lives on the teacher portal — must be a full nav, not router.push
      const teacherUrl = process.env.NEXT_PUBLIC_TEACHER_URL
      window.location.href = teacherUrl ? `${teacherUrl}/login` : '/login'
    } catch {
      setLogoutError('Could not log out — you are still signed in. Check your connection and try again.')
      setLoggingOut(false)
    }
  }

  // One element reused by both sidebar footers below (desktop and mobile). React
  // elements are immutable descriptors, so sharing one across trees is safe even
  // when both are mounted at once.
  const logoutErrorCard = logoutError && (
    <div
      className="mb-2 rounded-lg px-3 py-2"
      style={{ borderLeft: '3px solid #FD5602', backgroundColor: '#FFEEE6' }}
    >
      <p className="text-xs leading-relaxed" style={{ color: '#FD5602', margin: 0 }}>{logoutError}</p>
    </div>
  )

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  // Single source for both sidebars (desktop column + mobile overlay): grouped nav
  // plus the footer. A plain JSX element, like logoutErrorCard above — sharing one
  // immutable descriptor across both trees keeps them in lockstep without a new
  // component type per render.
  const sidebarInner = (
    <>
      <nav className="flex-1 px-3 pt-4 overflow-y-auto thin-scroll">
        {navGroups.map((group, groupIndex) => (
          <div key={group.label} style={{ marginTop: groupIndex === 0 ? 0 : '18px' }}>
            <p
              style={{
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#9ca3af',
                padding: '0 12px',
                marginBottom: '4px',
              }}
            >
              {group.label}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isActive(item.href, item.exact)}
                  unreadMessages={liveUnreadMessages}
                  unreadSupport={liveUnreadSupport}
                  onNavigate={() => setSidebarOpen(false)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-3 py-4 space-y-1" style={{ borderTop: '1px solid #E0DFDC' }}>
        {logoutErrorCard}
        {/* "Back to Teacher Portal" wrapped onto two lines in a 224px column —
            shortened to "Teacher Portal" so the arrow + label stay on one line. */}
        <Link
          href="/dashboard"
          prefetch={false}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 transition-colors hover:bg-brand-grey hover:text-gray-900 whitespace-nowrap"
        >
          <ArrowLeft size={18} style={{ color: '#9ca3af', flexShrink: 0 }} />
          Teacher Portal
        </Link>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 transition-colors hover:bg-red-50 hover:text-red-600 whitespace-nowrap"
          style={{ cursor: loggingOut ? 'not-allowed' : 'pointer', opacity: loggingOut ? 0.6 : 1 }}
        >
          <LogOut size={18} style={{ color: '#9ca3af', flexShrink: 0 }} />
          {loggingOut ? 'Logging out…' : 'Log Out'}
        </button>
      </div>
    </>
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

      {/* Full-width header across the top — admin chrome: orange, 72px, no
          bottom border. zIndex 40 matches TopHeader so the header paints
          above page-content stickies (which stay <= 20). */}
      <header
        className="flex items-center justify-between px-6 flex-shrink-0 w-full"
        style={{
          background: 'linear-gradient(90deg, #ffffff 0%, #ffffff 160px, #FFF0E0 45%, #FFB942 75%, #FF8303 100%)',
          borderBottom: 'none',
          height: '72px',
          zIndex: 40,
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
          <button className="lg:hidden mr-2" style={{ color: '#ffffff' }} onClick={() => setSidebarOpen(true)}>
            <Menu size={22} />
          </button>
          <div className="relative" ref={profileMenuRef}>
            <button
              type="button"
              onClick={() => setProfileMenuOpen((open) => !open)}
              className="flex items-center gap-2"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
            >
              {profile.photo_url ? (
                <img
                  src={profile.photo_url}
                  alt={profile.full_name}
                  className="w-9 h-9 rounded-full object-cover"
                  style={{ border: '2px solid #ffffff' }}
                />
              ) : (
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2"
                  style={{ backgroundColor: '#ffffff', borderColor: '#ffffff', color: '#FF8303' }}
                >
                  {profile.full_name?.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="hidden sm:flex flex-col items-start leading-tight">
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#ffffff' }}>
                  {profile.full_name?.split(' ')[0]}
                </span>
                <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)' }}>
                  Administrator
                </span>
              </span>
              <ChevronDown size={16} style={{ color: '#ffffff' }} />
            </button>

            {profileMenuOpen && (
              <div
                className="absolute right-0 mt-2"
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #E0DFDC',
                  borderRadius: '10px',
                  boxShadow: '0 1px 2px 0 rgba(17,24,39,0.08)',
                  zIndex: 50,
                  minWidth: '160px',
                  overflow: 'hidden',
                }}
              >
                <Link
                  href="/admin/settings"
                  prefetch={false}
                  onClick={() => setProfileMenuOpen(false)}
                  className="block px-4 py-2.5 hover:bg-gray-50"
                  style={{ fontSize: '14px', color: '#4b5563' }}
                >
                  Settings
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false)
                    handleLogout()
                  }}
                  disabled={loggingOut}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50"
                  style={{ fontSize: '14px', color: '#4b5563', cursor: loggingOut ? 'not-allowed' : 'pointer', opacity: loggingOut ? 0.6 : 1 }}
                >
                  {loggingOut ? 'Logging out…' : 'Log Out'}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Below header: sidebar + content */}
      <div className="flex flex-1 min-h-0">

        {/* Desktop sidebar */}
        <aside
          className="hidden lg:flex flex-col w-56 flex-shrink-0"
          style={{ backgroundColor: '#F1EFEC', borderRight: '1px solid #E0DFDC' }}
        >
          {sidebarInner}
        </aside>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="fixed inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
            <aside
              className="relative flex flex-col w-56 z-50"
              style={{ backgroundColor: '#F1EFEC', borderRight: '1px solid #E0DFDC' }}
            >
              {sidebarInner}
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto thin-scroll">
          <div className="max-w-[1600px] mx-auto">
            {children}
          </div>
        </main>

        {/* Right panel — the dashboard renders these same five stats as full-width
            cards, so the rail would be pure duplication there. The Create Teacher
            form is a single full-width scrolling form, so the rail is hidden there
            too. */}
        {pathname !== '/admin' && pathname !== '/admin/teachers/new' && (
          <aside ref={adminPanelRef} onWheel={handleAdminPanelWheel} className="hidden xl:flex flex-col w-56 flex-shrink-0 border-l border-gray-200 p-4 overflow-y-auto thin-scroll" style={{ backgroundColor: '#F7F8FA' }}>
            <div className="flex items-center gap-2 mb-3">
              <Activity size={14} color="#FF8303" style={{ flexShrink: 0 }} />
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">At a Glance</p>
            </div>
            <div className="space-y-3">
              {panelWidgets.map((w) => (
                <Link key={w.label} href={w.href} prefetch={false}>
                  <div className="bg-white rounded-xl p-3 shadow-sm border border-gray-100 hover:shadow-md hover:border-orange-200 transition-all">
                    <p className="text-xs text-gray-500">{w.label}</p>
                    <p className="text-xl font-bold mt-0.5" style={{ color: w.alert ? '#dc2626' : '#111827', fontVariantNumeric: 'tabular-nums' }}>
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
              <div className="bg-white rounded-xl p-3 shadow-sm border border-gray-100 mt-4">
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
        )}
      </div>

      <IdleTimeoutWatcher
        nextLessonStartIso={protectedLesson?.scheduled_at ?? null}
        nextLessonDurationMinutes={protectedLesson?.duration_minutes ?? null}
        loginPath="/login"
      />
    </div>
  )
}
