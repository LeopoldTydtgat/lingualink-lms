import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import StudentLeftNav from '@/components/student/layout/StudentLeftNav'
import StudentTopHeader from '@/components/student/layout/StudentTopHeader'
import StudentRightPanel from '@/components/student/layout/StudentRightPanel'

export default async function StudentDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/student/login')
  }

  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, email, photo_url, is_active')
    .eq('auth_user_id', user.id)
    .single()

  if (!student) {
    redirect('/student/login')
  }

  if (!student.is_active) {
    redirect('/student/login')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <StudentTopHeader
        studentName={student.full_name}
        photoUrl={student.photo_url ?? null}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <StudentLeftNav />
        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            backgroundColor: '#f9fafb',
            padding: '32px',
          }}
        >
          {children}
        </main>
        <StudentRightPanel studentId={student.id} />
      </div>
    </div>
  )
}