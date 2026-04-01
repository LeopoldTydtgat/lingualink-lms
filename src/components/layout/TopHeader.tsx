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
    <header className="h-16 bg-brand-orange flex items-center justify-between px-6 shrink-0 z-10">

      {/* Left side: Logo */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-white rounded-md flex items-center justify-center">
          <span className="text-brand-orange font-bold text-sm">L</span>
        </div>
        <span className="font-bold text-white text-sm tracking-tight">
          Lingualink Online
        </span>
      </div>

      {/* Right side: Greeting and profile photo */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-white font-medium">
          Hello {firstName}!
        </span>

        <Link href="/account" className="shrink-0">
          {teacherPhotoUrl ? (
            <Image
              src={teacherPhotoUrl}
              alt={`${teacherName}'s profile photo`}
              width={36}
              height={36}
              className="rounded-full object-cover border-2 border-orange-300 hover:border-white transition-colors"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-orange-400 flex items-center justify-center border-2 border-orange-300 hover:border-white transition-colors">
              <UserCircle size={20} className="text-white" />
            </div>
          )}
        </Link>
      </div>

    </header>
  )
}