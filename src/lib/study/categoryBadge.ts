import type { CSSProperties } from 'react'

// Study-sheet category pill styling, shared by the teacher and student
// study-sheet detail pages.
//
// Keyed on the CANONICAL stored casing — the values persisted in
// study_sheets.category are lowercase ('vocabulary' / 'grammar'). The previous
// inline copies keyed on capitalised strings, so every real sheet fell through
// to the default branch and rendered the wrong (default) colour. Callers render
// the label under a `capitalize` class (matching the list card at
// StudySheetsClient.tsx:381), so the pill text still reads "Vocabulary".
//
// Palette note: 'grammar' and the default are the neutral grey pill rather than
// a blue tint. The teacher detail page palette forbids blue, and this module
// renders there; vocabulary keeps its warm (intended) colour.
export function categoryBadgeStyle(category: string | null): CSSProperties {
  if (category === 'vocabulary') return { backgroundColor: '#fff7ed', color: '#c2410c' }
  if (category === 'grammar') return { backgroundColor: '#f3f4f6', color: '#4b5563' }
  return { backgroundColor: '#f3f4f6', color: '#4b5563' }
}
