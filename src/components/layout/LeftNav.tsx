'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  CalendarDays,
  FileText,
  Users,
  MessageSquare,
  BookOpen,
  Receipt,
  UserCircle,
  LogOut,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type NavItem = {
  label: string
  href: string
  icon: React.ElementType
  adminOnly?: boolean
  matchPaths?: string[]
}

const navItems: NavItem[] = [
  { label: 'Upcoming Classes',        href: '/upcoming-classes', icon: LayoutDashboard, matchPaths: ['/upcoming-classes', '/dashboard'] },
  { label: 'Schedule & Availability', href: '/schedule',         icon: CalendarDays },
  { label: 'Class Reports',           href: '/reports',          icon: FileText },
  { label: 'Students & Trainings',    href: '/students',         icon: Users },
  { label: 'Messages',                href: '/messages',         icon: MessageSquare },
  { label: 'Study Sheet & Exercises', href: '/study-sheets',     icon: BookOpen },
  { label: 'Billing & Invoices',      href: '/billing',          icon: Receipt },
  { label: 'My Account',              href: '/account',          icon: UserCircle },
  { label: 'Admin Controls',          href: '/admin',            icon: ShieldCheck, adminOnly: true },
]

type LeftNavProps = {
  userRole: string
  unreadMessageCount?: number
}

export default function LeftNav({ userRole, unreadMessageCount = 0 }: LeftNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const isAdmin = userRole === 'admin'
  const visibleItems = navItems.filter(item => !item.adminOnly || isAdmin)

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function isActive(item: NavItem): boolean {
    if (item.matchPaths) {
      return item.matchPaths.some(p => pathname === p || pathname.startsWith(p + '/'))
    }
    return pathname === item.href || pathname.startsWith(item.href + '/')
  }

  return (
    <nav className="w-60 bg-white flex flex-col shrink-0 h-screen overflow-y-auto">
      {/* Logo area — gradient matches header, no dividing line */}
      <div
        className="flex items-center justify-center px-4 shrink-0"
        style={{ height: '72px', background: 'linear-gradient(to right, #ffffff, #fff3e8)' }}
      >
        <Link href="/upcoming-classes" prefetch={false}>
          <img src="/lingualink-logo-clean.svg" alt="Lingualink Online" style={{ height: '56px', width: 'auto' }} />
        </Link>
      </div>

      <ul className="flex-1 py-4 space-y-1 px-3 border-r border-brand-grey">
        {visibleItems.map((item) => {
          const Icon = item.icon
          const active = isActive(item)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={false}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-brand-orange text-white'
                    : 'text-gray-600 hover:bg-brand-grey hover:text-gray-900'
                )}
              >
                <Icon
                  size={18}
                  className={cn(active ? 'text-white' : 'text-gray-400')}
                />
                {item.label}

                {item.label === 'Messages' && unreadMessageCount > 0 && (
                  <span
                    className="ml-auto text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center"
                    style={{ backgroundColor: active ? 'rgba(255,255,255,0.35)' : '#FF8303', fontSize: '10px' }}
                  >
                    {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>

      <div className="p-3 border-t border-r border-brand-grey">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          <LogOut size={18} className="text-gray-400" />
          Log Out
        </button>
      </div>
    </nav>
  )
}
