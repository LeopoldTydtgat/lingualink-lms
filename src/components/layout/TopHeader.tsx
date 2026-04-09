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
      className="flex items-center justify-end px-6 shrink-0 z-10"
      style={{ background: 'linear-gradient(to right, #fff3e8, #FF8303 40%)', height: '72px' }}
    >
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium" style={{ color: '#ffffff' }}>
          Hello {firstName}!
        </span>
        <Link href="/account" className="shrink-0">
          {teacherPhotoUrl ? (
            <Image
              src={teacherPhotoUrl}
              alt={`${teacherName} profile photo`}
              width={36}
              height={36}
              className="rounded-full object-cover border-2 border-white hover:border-orange-100 transition-colors"
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


