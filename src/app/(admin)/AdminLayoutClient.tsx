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
  X,
} from 'lucide-react'

interface Profile {
  id: string
  full_name: string
  role: string
  photo_url: string | null
}

interface AdminLayoutClientProps {
  profile: Profile
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
        <Icon
          size={18}
          style={active ? { color: '#ffffff' } : { color: '#9ca3af' }}
        />
        {item.label}
      </Link>
    )
  }

  const Sidebar = () => (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="px-4 py-5 border-b border-gray-700">
        <span className="text-white font-bold text-lg">Admin Portal</span>
        <p className="text-gray-400 text-xs mt-0.5">Lingualink Online</p>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => (
          <NavLink key={item.href} item={item} />
        ))}
      </nav>

      {/* Bottom actions */}
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

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col w-56 flex-shrink-0 bg-gray-900">
        <Sidebar />
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative flex flex-col w-56 bg-gray-900 z-50">
            <Sidebar />
          </aside>
        </div>
      )}

      {/* Main content column */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top header */}
        <header
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{ backgroundColor: '#FF8303' }}
        >
          <div className="flex items-center gap-3">
            {/* Mobile menu button */}
            <button
              className="lg:hidden text-white"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={22} />
            </button>
            <span className="text-white font-bold text-base">
              Lingualink Online — Admin
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-white text-sm hidden sm:block">
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
          {/* Main scrollable content */}
          <main className="flex-1 overflow-y-auto p-6">{children}</main>

          {/* Right panel */}
          <aside className="hidden xl:flex flex-col w-56 flex-shrink-0 bg-white border-l border-gray-200 p-4 overflow-y-auto">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
              At a Glance
            </h3>

            {/* Placeholder widgets — wired up in Step 3 (Dashboard) */}
            <div className="space-y-3">
              <div className="rounded-lg p-3 bg-gray-50 border border-gray-200">
                <p className="text-xs text-gray-500">Classes Today</p>
                <p className="text-xl font-bold text-gray-800">—</p>
              </div>
              <div className="rounded-lg p-3 bg-gray-50 border border-gray-200">
                <p className="text-xs text-gray-500">Pending Reports</p>
                <p className="text-xl font-bold text-gray-800">—</p>
              </div>
              <div className="rounded-lg p-3 bg-gray-50 border border-gray-200">
                <p className="text-xs text-gray-500">Flagged Reports</p>
                <p className="text-xl font-bold text-gray-800">—</p>
              </div>
              <div className="rounded-lg p-3 bg-gray-50 border border-gray-200">
                <p className="text-xs text-gray-500">Low Hours Students</p>
                <p className="text-xl font-bold text-gray-800">—</p>
              </div>
              <div className="rounded-lg p-3 bg-gray-50 border border-gray-200">
                <p className="text-xs text-gray-500">Invoices to Review</p>
                <p className="text-xl font-bold text-gray-800">—</p>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-gray-200">
              <p className="text-xs text-gray-400">
                Right panel widgets are wired up in Dashboard step.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}