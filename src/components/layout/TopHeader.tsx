// src/components/layout/TopHeader.tsx
// Displays the logo, teacher greeting, and profile photo across the top.

import Link from 'next/link'
import Image from 'next/image'
import { UserCircle } from 'lucide-react'

type TopHeaderProps = {
  teacherName: string
  teacherPhotoUrl: string | null
}

export default function TopHeader({ teacherName, teacherPhotoUrl }: TopHeaderProps) {
  // Extract first name only for the greeting
  const firstName = teacherName.split(' ')[0]

  return (
    <header className="h-16 bg-white border-b border-brand-grey flex items-center justify-between px-6 shrink-0 z-10">

      {/* Left side: Logo placeholder — replace with real logo when Shannon supplies files */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-brand-orange rounded-md flex items-center justify-center">
          <span className="text-white font-bold text-sm">L</span>
        </div>
        <span className="font-bold text-gray-900 text-sm tracking-tight">
          Lingualink Online
        </span>
      </div>

      {/* Right side: Greeting and profile photo */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-600 font-medium">
          Hello {firstName}!
        </span>

        {/* Clicking the photo goes to My Account */}
        <Link href="/account" className="shrink-0">
          {teacherPhotoUrl ? (
            <Image
              src={teacherPhotoUrl}
              alt={`${teacherName}'s profile photo`}
              width={36}
              height={36}
              className="rounded-full object-cover border-2 border-brand-grey hover:border-brand-orange transition-colors"
            />
          ) : (
            // Shown when no photo has been uploaded yet
            <div className="w-9 h-9 rounded-full bg-brand-grey flex items-center justify-center border-2 border-brand-grey hover:border-brand-orange transition-colors">
              <UserCircle size={20} className="text-gray-400" />
            </div>
          )}
        </Link>
      </div>

    </header>
  )
}