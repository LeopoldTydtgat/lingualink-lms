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

  // Validate the session
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/student/login')
  }

  // Look up the student record by their Supabase auth user ID
  const { data: student } = await supabase
    .from('students')
    .select('id, full_name, email, photo_url')
    .eq('auth_user_id', user.id)
    .single()

  // If there's an auth user but no matching student record, send them to login
  if (!student) {
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
