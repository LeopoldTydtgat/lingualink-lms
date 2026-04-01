// src/components/layout/LeftNav.tsx
// 'use client' is required because usePathname() and useRouter() are
// client-side hooks — they read the browser URL and handle navigation.
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

// cn() merges Tailwind classes cleanly — it comes with shadcn/ui

type NavItem = {
  label: string
  href: string
  icon: React.ElementType
  adminOnly?: boolean
}

const navItems: NavItem[] = [
  { label: 'Upcoming Classes',        href: '/dashboard',    icon: LayoutDashboard },
  { label: 'Schedule & Availability', href: '/schedule',     icon: CalendarDays },
  { label: 'Class Reports',           href: '/reports',      icon: FileText },
  { label: 'Students & Trainings',    href: '/students',     icon: Users },
  { label: 'Messages',                href: '/messages',     icon: MessageSquare },
  { label: 'Study Sheet & Exercises', href: '/study-sheets', icon: BookOpen },
  { label: 'Billing & Invoices',      href: '/billing',      icon: Receipt },
  { label: 'My Account',              href: '/account',      icon: UserCircle },
  { label: 'Admin Controls',          href: '/admin',        icon: ShieldCheck, adminOnly: true },
]

type LeftNavProps = {
  userRole: string
}

export default function LeftNav({ userRole }: LeftNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const isAdmin = userRole === 'admin'

  // Hide admin-only items from regular teachers
  const visibleItems = navItems.filter(item => !item.adminOnly || isAdmin)

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="w-60 bg-white border-r border-brand-grey flex flex-col shrink-0 overflow-y-auto">

      {/* Nav links */}
      <ul className="flex-1 py-4 space-y-1 px-3">
        {visibleItems.map((item) => {
          const Icon = item.icon

          // Highlight the active page in orange.
          // /dashboard only matches exactly. All others match any sub-path too.
          const isActive =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-orange text-white'
                    : 'text-gray-600 hover:bg-brand-grey hover:text-gray-900'
                )}
              >
                <Icon
                  size={18}
                  className={cn(isActive ? 'text-white' : 'text-gray-400')}
                />
                {item.label}

                {/* Unread badge on Messages — hardcoded for now, wired up later */}
                {item.label === 'Messages' && (
                  <span className="ml-auto bg-brand-orange text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
                    3
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>

      {/* Log Out — pinned to the bottom */}
      <div className="p-3 border-t border-brand-grey">
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