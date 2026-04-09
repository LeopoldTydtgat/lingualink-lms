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
      style={{
        background: 'linear-gradient(to right, #fff3e8, #FF8303 40%)',
        height: '72px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 24px',
        flexShrink: 0,
      }}
    >
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


