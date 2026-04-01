// src/components/layout/RightPanel.tsx
// 'use client' is required because the countdown timer updates every second
// using setInterval, which only works in the browser.
'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Video, ArrowRight, BookOpen, Bell } from 'lucide-react'

type RightPanelProps = {
  teacherId: string | null
}

// Converts a number of seconds into HH:MM:SS format
function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return '00:00:00'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}

export default function RightPanel({ teacherId }: RightPanelProps) {
  const [secondsUntilNextClass, setSecondsUntilNextClass] = useState<number | null>(null)
  const [showJoinButton, setShowJoinButton] = useState(false)

  useEffect(() => {
    // Placeholder: 2 hours until next class
    // This will be replaced with real Supabase data when we build
    // the Upcoming Classes page
    const placeholderSeconds = 2 * 60 * 60
    setSecondsUntilNextClass(placeholderSeconds)

    const timer = setInterval(() => {
      setSecondsUntilNextClass(prev => {
        if (prev === null || prev <= 0) {
          clearInterval(timer)
          return 0
        }
        const next = prev - 1
        // Show the Join button when 15 minutes or less remain
        setShowJoinButton(next <= 15 * 60)
        return next
      })
    }, 1000)

    // Stop the timer when this component is removed from the page
    return () => clearInterval(timer)
  }, [teacherId])

  return (
    <aside className="w-72 bg-white border-l border-brand-grey flex flex-col shrink-0 overflow-y-auto">
      <div className="p-4 space-y-4">

        {/* ── NEXT CLASS ── */}
        <section className="bg-gray-50 rounded-xl p-4 border border-brand-grey">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Next Class
          </p>
          {secondsUntilNextClass !== null ? (
            <>
              <p className="text-2xl font-bold text-gray-900 font-mono tracking-tight">
                {formatCountdown(secondsUntilNextClass)}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">hours : mins : secs</p>
            </>
          ) : (
            <p className="text-sm text-gray-500">No upcoming classes</p>
          )}

          {/* Only appears 15 minutes before class */}
          {showJoinButton && (
            <Button
              className="mt-3 w-full bg-gray-900 hover:bg-gray-700 text-white text-sm font-semibold"
              size="sm"
            >
              <Video size={14} className="mr-2" />
              Join Class
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full text-sm border-brand-grey hover:border-brand-orange hover:text-brand-orange"
          >
            <BookOpen size={14} className="mr-2" />
            See Training
          </Button>
        </section>

        {/* ── BILLING SUMMARY ── */}
        <section className="bg-gray-50 rounded-xl p-4 border border-brand-grey">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Billing
          </p>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Current month</span>
              <span className="font-semibold text-gray-900">€ —</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Projected</span>
              <span className="font-semibold text-gray-900">€ —</span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full text-sm border-brand-grey hover:border-brand-orange hover:text-brand-orange"
          >
            Billing & Invoices
            <ArrowRight size={14} className="ml-2" />
          </Button>
        </section>

        {/* ── WHAT'S NEW ── */}
        <section className="bg-gray-50 rounded-xl p-4 border border-brand-grey">
          <div className="flex items-center gap-2 mb-2">
            <Bell size={14} className="text-gray-400" />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              What&apos;s New
            </p>
          </div>
          <p className="text-sm text-gray-400 italic">No new notifications</p>
        </section>

        {/* ── HELP ── */}
        <section className="bg-brand-orange-light rounded-xl p-4 border border-orange-100">
          <p className="text-xs font-semibold text-brand-orange uppercase tracking-wider mb-1">
            Help & Support
          </p>
          <p className="text-sm text-gray-600 mb-2">
            Questions? Contact admin or browse the FAQs.
          </p>
          <Button
            size="sm"
            className="w-full bg-brand-orange hover:bg-orange-600 text-white text-sm"
          >
            Chat with Admin
          </Button>
        </section>

      </div>
    </aside>
  )
}