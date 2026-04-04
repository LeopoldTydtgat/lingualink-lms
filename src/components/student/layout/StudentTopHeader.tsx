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
  // Show only the first name in the greeting
  const firstName = studentName.split(' ')[0]

  return (
    <header
      style={{
        backgroundColor: '#FF8303',
        height: '56px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        flexShrink: 0,
      }}
    >
      {/* Logo — replace text with <Image> when client supplies logo files */}
      <div
        style={{
          color: '#ffffff',
          fontWeight: '700',
          fontSize: '17px',
          letterSpacing: '-0.3px',
        }}
      >
        Lingualink Online
      </div>

      {/* Greeting + profile photo (links to My Account) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ color: '#ffffff', fontSize: '14px', fontWeight: '500' }}>
          Hello {firstName}!
        </span>
        <Link href="/student/account" style={{ display: 'flex' }}>
          {photoUrl ? (
            <Image
              src={photoUrl}
              alt={studentName}
              width={32}
              height={32}
              style={{
                borderRadius: '50%',
                border: '2px solid rgba(255,255,255,0.8)',
                cursor: 'pointer',
              }}
            />
          ) : (
            // Placeholder avatar when no photo is uploaded
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor: 'rgba(255,255,255,0.25)',
                border: '2px solid rgba(255,255,255,0.8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <User size={15} color="white" />
            </div>
          )}
        </Link>
      </div>
    </header>
  )
}
