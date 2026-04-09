'use client'
import TaskForm from '@/components/admin/TaskForm'
import { use } from 'react'

export default function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <TaskForm mode="edit" taskId={id} />
}
