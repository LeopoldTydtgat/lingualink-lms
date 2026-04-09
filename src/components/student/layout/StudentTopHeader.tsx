import Link from 'next/link'
import Image from 'next/image'
import { User } from 'lucide-react'

interface StudentTopHeaderProps {
  studentName: string
  photoUrl: string | null
}

export default function StudentTopHeader({
  studentName,
  photoUrl,
}: StudentTopHeaderProps) {
  const firstName = studentName.split(' ')[0]

  return (
    <header
      className="flex items-center justify-between px-6 shrink-0 z-10"
      style={{ backgroundColor: '#FF8303', height: '72px', borderBottom: '3px solid #FF8303' }}
    >
      <Image
        src="/lingualink-logo.svg"
        alt="Lingualink Online"
        width={220}
        height={126}
        style={{ height: '52px', width: 'auto' }}
        priority
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ color: '#ffffff', fontSize: '14px', fontWeight: '500' }}>
          Hello {firstName}!
        </span>
        <Link href="/student/account" style={{ display: 'flex' }}>
          {photoUrl ? (
            <Image
              src={photoUrl}
              alt={studentName}
              width={36}
              height={36}
              style={{
                borderRadius: '50%',
                border: '2px solid rgba(255,255,255,0.6)',
                cursor: 'pointer',
              }}
            />
          ) : (
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                backgroundColor: 'rgba(255,255,255,0.25)',
                border: '2px solid rgba(255,255,255,0.6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <User size={18} color="white" />
            </div>
          )}
        </Link>
      </div>
    </header>
  )
}
