'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  Building2,
  CalendarDays,
  FileText,
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

interface Profile {
  id: string
  full_name: string
  role: string
  photo_url: string | null
}

interface AdminLayoutClientProps {
  profile: Profile
  rightPanelStats: RightPanelStats
  children: React.ReactNode
}

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/admin/teachers', label: 'Teachers', icon: Users },
  { href: '/admin/students', label: 'Students', icon: GraduationCap },
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/classes', label: 'Classes', icon: CalendarDays },
  { href: '/admin/reports', label: 'Reports', icon: FileText },
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
  children,
}: AdminLayoutClientProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  const NavLink = ({ item }: { item: (typeof navItems)[0] }) => {
    const active = isActive(item.href, item.exact)
    const Icon = item.icon
    return (
      <Link
        href={item.href}
        onClick={() => setSidebarOpen(false)}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
        style={
          active
            ? { backgroundColor: '#FF8303', color: '#ffffff' }
            : { color: '#9ca3af' }
        }
      >
        <Icon size={18} style={active ? { color: '#ffffff' } : { color: '#9ca3af' }} />
        {item.label}
      </Link>
    )
  }

  const Sidebar = () => (
    <div className="flex flex-col h-full">
      {/* Logo area — white block, same height as orange header */}
      <div
        style={{
          height: '72px',
          backgroundColor: '#111827',
          borderBottom: '1px solid #374151',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Link href="/admin" prefetch={false}>
          <img
            src="/lingualink-logo-white.svg"
            alt="Lingualink Online"
            style={{ height: '36px', width: 'auto' }}
          />
        </Link>
      </div>

      {/* Black nav area */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => (
          <NavLink key={item.href} item={item} />
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-gray-700 space-y-1">
        <Link
          href="/dashboard"
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
    { label: 'Classes Today', value: rightPanelStats.classesTodayCount, href: '/admin/classes', alert: false },
    { label: 'Pending Reports', value: rightPanelStats.pendingCount, href: '/admin/reports?filter=pending', alert: false },
    { label: 'Flagged Reports', value: rightPanelStats.flaggedCount, href: '/admin/reports?filter=flagged', alert: rightPanelStats.flaggedCount > 0 },
    { label: 'Low Hours Students', value: rightPanelStats.lowHoursCount, href: '/admin/students?filter=low_hours', alert: false },
    { label: 'Invoices to Review', value: rightPanelStats.invoicesToReviewCount, href: '/admin/billing', alert: false },
  ]

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      {/* Desktop sidebar — full height, white logo block on top, black nav below */}
      <aside className="hidden lg:flex flex-col w-56 flex-shrink-0 bg-gray-900">
        <Sidebar />
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="fixed inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <aside className="relative flex flex-col w-56 bg-gray-900 z-50">
            <Sidebar />
          </aside>
        </div>
      )}

      {/* Right side: orange header + content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Orange header — greeting and avatar only, aligns with 72px logo block */}
        <header
          className="flex items-center justify-end px-6 flex-shrink-0"
          style={{ backgroundColor: '#FF8303', height: '72px' }}
        >
          <div className="flex items-center gap-3">
            <button className="lg:hidden text-white mr-2" onClick={() => setSidebarOpen(true)}>
              <Menu size={22} />
            </button>
            <span className="text-white text-sm font-medium hidden sm:block">
              Hello {profile.full_name?.split(' ')[0]}!
            </span>
            <Link href="/admin/settings">
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

        {/* Page content + right panel */}
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 overflow-y-auto">
            <div className="max-w-6xl mx-auto">
              {children}
            </div>
          </main>

          <aside className="hidden xl:flex flex-col w-56 flex-shrink-0 bg-white border-l border-gray-200 p-4 overflow-y-auto">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
              At a Glance
            </h3>
            <div className="space-y-3">
              {panelWidgets.map((w) => (
                <Link key={w.label} href={w.href}>
                  <div className="rounded-lg p-3 bg-gray-50 border border-gray-200 hover:border-orange-200 transition-colors">
                    <p className="text-xs text-gray-500">{w.label}</p>
                    <p className="text-xl font-bold mt-0.5" style={{ color: w.alert ? '#dc2626' : '#111827' }}>
                      {w.value}
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
                <Link href="/admin/announcements" className="text-xs mt-1 inline-block hover:underline" style={{ color: '#FF8303' }}>
                  Manage
                </Link>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}



