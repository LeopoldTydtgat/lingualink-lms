// src/components/layout/TopHeader.tsx
import Link from 'next/link'
import Image from 'next/image'
import { UserCircle } from 'lucide-react'

type TopHeaderProps = {
  teacherName: string
  teacherPhotoUrl: string | null
}

export default function TopHeader({ teacherName, teacherPhotoUrl }: TopHeaderProps) {
  const firstName = teacherName.split(' ')[0]

  return (
    <header
      style={{
        background: 'linear-gradient(to right, #fff3e8, #FF8303 40%)',
        height: '72px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 24px',
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <span style={{ color: '#ffffff', fontSize: '14px', fontWeight: '500' }}>
          Hello {firstName}!
        </span>
        <Link href="/account" prefetch={false} style={{ display: 'flex' }}>
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
                border: '2px solid rgba(255,255,255,0.6)',
              }}
            />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center border-2"
              style={{ backgroundColor: 'rgba(255,255,255,0.25)', borderColor: 'rgba(255,255,255,0.6)' }}
            >
              <UserCircle size={20} color="white" />
            </div>
          )}
        </Link>
      </div>
    </header>
  )
}
