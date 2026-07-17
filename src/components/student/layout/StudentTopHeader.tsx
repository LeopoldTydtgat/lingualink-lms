import Link from 'next/link'
import Image from 'next/image'
import { User, MessageSquare } from 'lucide-react'
import HeaderShortcut from '@/components/layout/HeaderShortcut'

interface StudentTopHeaderProps {
  studentName: string
  photoUrl: string | null
  unreadMessageCount?: number
}

export default function StudentTopHeader({
  studentName,
  photoUrl,
  unreadMessageCount = 0,
}: StudentTopHeaderProps) {
  const firstName = studentName.split(' ')[0]

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
        // Header must stack above page-content sticky elements, mirroring the
        // teacher TopHeader.
        zIndex: 40,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* Messages shortcut — the only header feature that exists student-side.
            Calendar/global-search/notifications shortcuts are intentionally omitted
            (no equivalent student features). */}
        <HeaderShortcut href="/student/messages" ariaLabel="Messages" title="Messages">
          <MessageSquare size={20} color="#4b5563" />
          {unreadMessageCount > 0 && (
            <span style={{ position: 'absolute', top: '2px', right: '2px', minWidth: '15px', height: '15px', borderRadius: '8px', backgroundColor: '#FF8303', color: '#ffffff', fontSize: '10px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
              {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
            </span>
          )}
        </HeaderShortcut>

        {/* Vertical divider */}
        <div style={{ width: '1px', height: '24px', backgroundColor: '#E0DFDC' }} />

        {/* Greeting + profile photo — links to the account page */}
        <Link
          href="/student/account"
          prefetch={false}
          className="hover:bg-gray-50 rounded-lg"
          style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 8px' }}
        >
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>
            Hello {firstName}!
          </span>
          {photoUrl ? (
            <Image
              src={photoUrl}
              alt={`${studentName} profile photo`}
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
              <User size={20} color="#9ca3af" />
            </div>
          )}
        </Link>
      </div>
    </header>
  )
}
