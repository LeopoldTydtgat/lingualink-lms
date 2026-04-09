'use client'
import TaskForm from '@/components/admin/TaskForm'
import { useSearchParams } from 'next/navigation'

export default function NewTaskPage() {
  const searchParams = useSearchParams()
  const linkedType = searchParams.get('linkedType') as 'teacher' | 'student' | undefined
  const linkedId = searchParams.get('linkedId') ?? undefined
  const linkedName = searchParams.get('linkedName') ?? undefined
  return <TaskForm mode="create" prefillLinkedType={linkedType} prefillLinkedId={linkedId} prefillLinkedName={linkedName} />
}
