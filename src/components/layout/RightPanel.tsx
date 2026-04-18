// src/components/layout/RightPanel.tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Video, ArrowRight, BookOpen, Bell } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnnouncementItem {
  id: string
  title: string
  message: string
  is_dismissable: boolean
}

interface NextLesson {
  id: string
  scheduled_at: string
  duration_minutes: number
  teams_join_url: string | null
  student_name: string
}

type RightPanelProps = {
  teacherId: string | null
  announcements?: AnnouncementItem[]
  nextLesson?: NextLesson | null
  billingData?: { currentAmount: number; projectedAmount: number }
  currency?: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return '00:00:00'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  }
  return `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
}

// Format: "Thu 09 Apr, 10:00 – 11:00"
// Uses manual construction — never toLocaleTimeString() to avoid hydration mismatch
function formatClassTime(isoString: string, durationMinutes: number): string {
  const date = new Date(isoString)

  const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]
  const day = String(date.getDate()).padStart(2, '0')
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]

  const startH = String(date.getHours()).padStart(2, '0')
  const startM = String(date.getMinutes()).padStart(2, '0')

  const endDate = new Date(date.getTime() + durationMinutes * 60 * 1000)
  const endH = String(endDate.getHours()).padStart(2, '0')
  const endM = String(endDate.getMinutes()).padStart(2, '0')

  return `${weekday} ${day} ${month}, ${startH}:${startM} – ${endH}:${endM}`
}

// ── Component ─────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' }

export default function RightPanel({
  teacherId,
  announcements = [],
  nextLesson = null,
  billingData,
  currency,
}: RightPanelProps) {
  const currencySymbol = (currency != null ? CURRENCY_SYMBOL[currency] ?? currency : '€')
  const router = useRouter()
  const [secondsUntil, setSecondsUntil] = useState<number | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)

    if (!nextLesson) {
      setSecondsUntil(null)
      return
    }

    const calc = () =>
      Math.max(0, Math.floor((new Date(nextLesson.scheduled_at).getTime() - Date.now()) / 1000))

    setSecondsUntil(calc())

    const timer = setInterval(() => {
      setSecondsUntil(calc())
    }, 1000)

    return () => clearInterval(timer)
  }, [teacherId, nextLesson])

  const isJoinable = mounted && secondsUntil !== null && secondsUntil <= 15 * 60

  return (
    <aside className="w-72 bg-white border-l border-brand-grey flex flex-col shrink-0 overflow-y-auto">
      <div className="p-4 space-y-4">

        {/* ── NEXT CLASS ── */}
        <section className="bg-gray-50 rounded-xl p-4 border border-brand-grey">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Next Class
          </p>

          {!nextLesson ? (
            <p className="text-sm text-gray-500">No upcoming classes</p>
          ) : (
            <>
              {/* Countdown — "Next class in 28m 45s" style */}
              <p className="text-sm font-semibold text-gray-900 leading-snug mb-1">
                {mounted && secondsUntil !== null
                  ? secondsUntil <= 0
                    ? 'Class is starting now'
                    : `Next class in ${formatCountdown(secondsUntil)}`
                  : 'Next class in –'}
              </p>

              {/* Date and time range */}
              <p className="text-xs text-gray-500 mb-0.5">
                {formatClassTime(nextLesson.scheduled_at, nextLesson.duration_minutes)}
              </p>

              {/* Student name */}
              <p className="text-xs text-gray-500 mb-3">
                with {nextLesson.student_name}
              </p>

              {/* See Training button — always visible */}
              <Button
                variant="outline"
                size="sm"
                className="w-full text-sm border-brand-grey hover:border-brand-orange hover:text-brand-orange mb-2"
                onClick={() => router.push('/students')}
              >
                <BookOpen size={14} className="mr-2" />
                See Training
              </Button>

              {/* Join Class — only appears 15 minutes before class */}
              {isJoinable && nextLesson.teams_join_url && (
                <a
                  href={nextLesson.teams_join_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: '#111827' }}
                >
                  <Video size={14} />
                  Join Class
                </a>
              )}
            </>
          )}
        </section>

        {/* ── BILLING SUMMARY ── */}
        <section className="bg-gray-50 rounded-xl p-4 border border-brand-grey">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Billing
          </p>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Current month</span>
              <span className="font-semibold text-gray-900">
                {billingData != null ? `${currencySymbol} ${billingData.currentAmount.toFixed(2)}` : `${currencySymbol} –`}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Projected</span>
              <span className="font-semibold text-gray-900">
                {billingData != null ? `${currencySymbol} ${billingData.projectedAmount.toFixed(2)}` : `${currencySymbol} –`}
              </span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full text-sm border-brand-grey hover:border-brand-orange hover:text-brand-orange"
            onClick={() => router.push('/billing')}
          >
            Billing &amp; Invoices
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
            {announcements.length > 0 && (
              <span
                className="ml-auto text-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: '#FF8303', fontSize: '10px' }}
              >
                {announcements.length > 9 ? '9+' : announcements.length}
              </span>
            )}
          </div>

          {announcements.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No new notifications</p>
          ) : (
            <div className="space-y-3">
              {announcements.map((a, index) => (
                <div key={a.id}>
                  {index > 0 && <div className="h-px bg-gray-200 mb-3" />}
                  <p className="text-xs font-semibold text-gray-800">{a.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{a.message}</p>
                </div>
              ))}
            </div>
          )}
        </section>

      </div>
    </aside>
  )
}

