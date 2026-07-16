// src/components/layout/TopHeader.tsx
import Link from 'next/link'
import Image from 'next/image'
import { UserCircle, CalendarDays, ChevronDown } from 'lucide-react'
import NotificationsBell from './NotificationsBell'

type AnnouncementItem = {
  id: string
  title: string
  message: string
  is_dismissable: boolean
}

type TopHeaderProps = {
  teacherName: string
  teacherPhotoUrl: string | null
  announcements: AnnouncementItem[]
}

export default function TopHeader({ teacherName, teacherPhotoUrl, announcements }: TopHeaderProps) {
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
          className="hover:bg-gray-100 rounded-lg p-2"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <CalendarDays size={20} color="#4b5563" />
        </Link>

        {/* Notifications bell — client island */}
        <NotificationsBell announcements={announcements} />

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
