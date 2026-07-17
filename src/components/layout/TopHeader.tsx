// src/components/layout/TopHeader.tsx
import Link from 'next/link'
import Image from 'next/image'
import { UserCircle, CalendarDays, ChevronDown, MessageSquare } from 'lucide-react'
import NotificationsBell from './NotificationsBell'
import type { WhatsNewItem } from '@/lib/whatsNew'

type TopHeaderProps = {
  teacherName: string
  teacherPhotoUrl: string | null
  whatsNewItems: WhatsNewItem[]
  whatsNewSeenAt: string | null
  unreadMessageCount: number
}

export default function TopHeader({ teacherName, teacherPhotoUrl, whatsNewItems, whatsNewSeenAt, unreadMessageCount }: TopHeaderProps) {
  return (
    <header
      style={{
        background: '#ffffff',
        height: '72px',
        borderBottom: '1px solid #E0DFDC',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 24px',
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* Calendar shortcut */}
        <Link
          href="/schedule"
          prefetch={false}
          aria-label="Schedule"
          title="Schedule"
          className="hover:bg-gray-100 rounded-lg p-2"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <CalendarDays size={20} color="#4b5563" />
        </Link>

        {/* Messages shortcut */}
        <Link
          href="/messages"
          prefetch={false}
          aria-label="Messages"
          title="Messages"
          className="hover:bg-gray-100 rounded-lg p-2"
          style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <MessageSquare size={20} color="#4b5563" />
          {unreadMessageCount > 0 && (
            <span style={{ position: 'absolute', top: '2px', right: '2px', minWidth: '15px', height: '15px', borderRadius: '8px', backgroundColor: '#FF8303', color: '#ffffff', fontSize: '10px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
              {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
            </span>
          )}
        </Link>

        {/* Notifications bell — client island */}
        <NotificationsBell items={whatsNewItems} seenAt={whatsNewSeenAt} />

        {/* Vertical divider */}
        <div style={{ width: '1px', height: '24px', backgroundColor: '#E0DFDC' }} />

        {/* Profile chip */}
        <Link
          href="/account"
          prefetch={false}
          className="hover:bg-gray-50 rounded-lg"
          style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 8px' }}
        >
          {teacherPhotoUrl ? (
            <Image
              src={teacherPhotoUrl}
              alt={`${teacherName} profile photo`}
              width={36}
              height={36}
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                objectFit: 'cover',
                border: '2px solid #E0DFDC',
              }}
            />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center border-2"
              style={{ backgroundColor: '#f3f4f6', borderColor: '#E0DFDC' }}
            >
              <UserCircle size={20} color="#9ca3af" />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>{teacherName}</span>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>Teacher</span>
          </div>
          <ChevronDown size={16} color="#9ca3af" />
        </Link>
      </div>
    </header>
  )
}
