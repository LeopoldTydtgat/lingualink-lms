'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Search, Plus, ChevronRight } from 'lucide-react'

type StudySheet = {
  id: string
  title: string
  category: string
  level: string
  difficulty: number
  is_active: boolean
  created_at: string
}

type Props = {
  studySheets: StudySheet[]
  isAdmin: boolean
}

const LEVELS = ['All', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const CATEGORIES = ['All', 'vocabulary', 'grammar']

function DifficultyDots({ count }: { count: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }}>
      {[1, 2, 3].map(n => (
        <span key={n} style={{ color: n <= count ? '#FF8303' : '#e5e7eb', fontSize: '15px', lineHeight: 1 }}>●</span>
      ))}
    </span>
  )
}

export default function StudySheetsClient({ studySheets, isAdmin }: Props) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [selectedLevel, setSelectedLevel] = useState('All')
  const [selectedCategory, setSelectedCategory] = useState('All')

  const filtered = studySheets.filter((sheet) => {
    const matchesSearch = sheet.title.toLowerCase().includes(search.toLowerCase())
    const matchesLevel = selectedLevel === 'All' || sheet.level === selectedLevel
    const matchesCategory = selectedCategory === 'All' || sheet.category === selectedCategory
    return matchesSearch && matchesLevel && matchesCategory
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Study Sheets & Exercises</h1>
          <p className="text-sm text-gray-500 mt-1">{studySheets.length} sheets in library</p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => router.push('/study-sheets/new')}
            style={{ backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Study Sheet
          </Button>
        )}
      </div>

      {/* Search and filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search study sheets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Level filter */}
        <div className="flex gap-1">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => setSelectedLevel(level)}
              className="px-3 py-1.5 rounded-md text-sm border transition-colors"
              style={
                selectedLevel === level
                  ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                  : { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#374151' }
              }
            >
              {level}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <div className="flex gap-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className="px-3 py-1.5 rounded-md text-sm border transition-colors capitalize"
              style={
                selectedCategory === cat
                  ? { backgroundColor: '#FF8303', borderColor: '#FF8303', color: 'white' }
                  : { backgroundColor: 'white', borderColor: '#e5e7eb', color: '#374151' }
              }
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_120px_80px_100px_40px] gap-4 px-6 py-3 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Title</span>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Category</span>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Level</span>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Difficulty</span>
          <span></span>
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-gray-400 text-sm">
            No study sheets found.
          </div>
        ) : (
          filtered.map((sheet) => (
            <div
              key={sheet.id}
              onClick={() => router.push(`/study-sheets/${sheet.id}`)}
              className="grid grid-cols-[1fr_120px_80px_100px_40px] gap-4 px-6 py-4 border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors last:border-0"
            >
              <span className="font-medium text-gray-900 text-sm">{sheet.title}</span>
              <span className="text-sm text-gray-500 capitalize">{sheet.category}</span>
              <span className="text-sm">
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
                >
                  {sheet.level}
                </span>
              </span>
              <DifficultyDots count={sheet.difficulty} />
              <ChevronRight className="w-4 h-4 text-gray-400 self-center" />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
