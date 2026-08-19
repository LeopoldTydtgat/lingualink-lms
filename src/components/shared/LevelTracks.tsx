'use client'

import {
  CEFR_LEVELS,
  SKILL_KEYS,
  SKILL_LABELS,
  listUnassessedSkillLabels,
} from '@/lib/levels/levelData'

// Read-only display of a report's level assessment: one horizontal A1..C2 track
// per canonical skill, filled up to the graded level. It replaced a radar chart
// on the teacher student-detail and admin report-detail pages - a radar shows a
// shape, and a shape is hard to read for "is grammar behind vocabulary", which
// is the actual question a teacher asks. Tracks line the skills up vertically so
// the comparison is immediate, and every value shown is one a teacher entered.
//
// No percentage is displayed and none can be: reports.level_data stores one
// CEFR string per skill and nothing finer, so any percent would be the level
// index restated as a fraction, not progress toward the next level.
//
// Deliberately NOT the LevelTrack control in ReportFormClient.tsx: that one is
// the live editable grading input and carries hover state. This one is pure
// display with no hooks, so it is safe inside the teacher student-detail
// General Info tab, which is invoked as a plain function call and would turn any
// hook here into a conditional hook in its parent. Always render this as
// <LevelTracks ... />, never call it as a function.
//
// Ungraded skills render an empty track plus a "Not assessed" label rather than
// being dropped, so a partial assessment reads as partial in place.

export default function LevelTracks({ levelData }: { levelData: unknown }) {
  const unassessed = listUnassessedSkillLabels(levelData)
  const values = (levelData ?? {}) as Record<string, unknown>

  return (
    <div className="flex flex-col">
      {SKILL_KEYS.map((key, rowIndex) => {
        const raw = values[key]
        const level = typeof raw === 'string' ? raw.trim() : ''
        const selectedIndex = (CEFR_LEVELS as readonly string[]).indexOf(level)

        return (
          <div
            key={key}
            className="flex items-center gap-4"
            style={{
              paddingTop: '10px',
              paddingBottom: '10px',
              borderBottom: rowIndex === SKILL_KEYS.length - 1 ? 'none' : '1px solid #f8f9fa',
            }}
          >
            <p className="w-40 flex-shrink-0 text-sm font-medium text-gray-700">
              {SKILL_LABELS[key]}
            </p>
            <div className="flex flex-1" style={{ maxWidth: `${CEFR_LEVELS.length * 72}px` }}>
              {CEFR_LEVELS.map((step, i) => {
                const isFilled = selectedIndex >= 0 && i <= selectedIndex
                const isSelected = i === selectedIndex
                return (
                  <div
                    key={step}
                    style={{
                      position: 'relative',
                      zIndex: isSelected ? 1 : 0,
                      flex: 1,
                      maxWidth: '72px',
                      height: '32px',
                      marginLeft: i === 0 ? 0 : '-1px',
                      border: '1px solid',
                      borderColor: isSelected ? '#FF8303' : isFilled ? '#FFD9A8' : '#d1d5db',
                      backgroundColor: isFilled ? '#FFF3E0' : 'white',
                      color: isFilled ? '#FF8303' : '#9CA3AF',
                      fontWeight: isSelected ? 700 : 600,
                      borderTopLeftRadius: i === 0 ? '8px' : 0,
                      borderBottomLeftRadius: i === 0 ? '8px' : 0,
                      borderTopRightRadius: i === CEFR_LEVELS.length - 1 ? '8px' : 0,
                      borderBottomRightRadius: i === CEFR_LEVELS.length - 1 ? '8px' : 0,
                    }}
                    className="flex items-center justify-center text-xs"
                  >
                    {step}
                  </div>
                )
              })}
            </div>
            {selectedIndex < 0 && (
              <span className="text-xs text-gray-400">Not assessed</span>
            )}
          </div>
        )
      })}

      {unassessed.length > 0 && (
        <p className="text-xs mt-3" style={{ color: '#9ca3af' }}>
          Not yet assessed: {unassessed.join(', ')}
        </p>
      )}
    </div>
  )
}
