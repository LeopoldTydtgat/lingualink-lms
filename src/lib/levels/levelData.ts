// Single source of truth for the teacher's CEFR level assessment, stored as
// public.reports.level_data (jsonb).
//
// The teacher report form is the single writer of level_data. The teacher
// student-detail and admin report-detail pages read it and render the
// per-skill LevelTracks; both student surfaces read it and render the overall
// level only. Independent copies of these skill keys and labels used to live
// in each of those surfaces, and had already drifted; every reader now
// imports from here instead.
//
// Nothing enforces the stored shape at the DB or the validation layer -
// SubmitReportSchema types level_data as z.record(z.string(), z.string()), and
// live rows are known to hold {} (an empty jsonb object) as well as jsonb null,
// neither of which is SQL NULL. So every function here takes `unknown` and
// validates before reading.

/** Canonical skill keys, in the order every surface renders them. */
export const SKILL_KEYS = [
  'grammar',
  'expression',
  'comprehension',
  'vocabulary',
  'accent',
  'overall_spoken',
  'overall_written',
] as const

export type SkillKey = (typeof SKILL_KEYS)[number]

/** Short labels - charts, chart legends, "not yet assessed" lines. */
export const SKILL_LABELS: Record<SkillKey, string> = {
  grammar: 'Grammar',
  expression: 'Expression',
  comprehension: 'Comprehension',
  vocabulary: 'Vocabulary',
  accent: 'Accent',
  overall_spoken: 'Spoken',
  overall_written: 'Written',
}

/**
 * Long labels - the teacher report form's input rows ONLY. Deliberately kept
 * distinct from SKILL_LABELS: these name the thing being graded on an input
 * control, the short ones fit a chart axis. Changing either must not change the
 * other.
 */
export const SKILL_FORM_LABELS: Record<SkillKey, string> = {
  grammar: 'Grammar',
  expression: 'Expression',
  comprehension: 'Comprehension',
  vocabulary: 'Vocabulary',
  accent: 'Accent',
  overall_spoken: 'Overall Spoken Level',
  overall_written: 'Overall Written Level',
}

/** The only values the form writes, low to high. */
export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const

export type CefrLevel = (typeof CEFR_LEVELS)[number]

export const CEFR_TO_NUM: Record<CefrLevel, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
}

/** The raw jsonb value as it arrives from the reports table. */
export type LevelData = Record<string, string>

export function isCefrLevel(value: unknown): value is CefrLevel {
  return typeof value === 'string' && (CEFR_LEVELS as readonly string[]).includes(value)
}

/**
 * The one place a stored value is judged usable. A skill counts only when the
 * container is a plain object and the value is a non-empty string naming a
 * recognised CEFR level. jsonb null, JS null/undefined, {}, arrays, non-string
 * values, empty strings and unrecognised level strings all read as absent.
 */
function readSkill(levelData: unknown, key: SkillKey): CefrLevel | null {
  if (levelData === null || typeof levelData !== 'object' || Array.isArray(levelData)) {
    return null
  }
  const raw = (levelData as Record<string, unknown>)[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return isCefrLevel(trimmed) ? trimmed : null
}

/**
 * True only when at least one canonical skill carries a usable CEFR value.
 * Every surface gates its chart on this, so a report can never render a chart
 * on one portal and an empty state on another.
 */
export function hasUsableLevelData(levelData: unknown): boolean {
  return SKILL_KEYS.some((key) => readSkill(levelData, key) !== null)
}

/**
 * Short labels of the skills a report left ungraded, in canonical order.
 * LevelTracks lists these beneath its rows so a partial assessment reads as
 * partial rather than as a differently shaped set of tracks.
 */
export function listUnassessedSkillLabels(levelData: unknown): string[] {
  return SKILL_KEYS.filter((key) => readSkill(levelData, key) === null).map(
    (key) => SKILL_LABELS[key]
  )
}

/**
 * The derived overall CEFR level: the equal-weight average of ALL SEVEN skills,
 * rounded to the nearest whole level, ties rounding DOWN. Client decision,
 * settled 19 Aug 2026 against the Cambridge English Scale model (equal skill
 * weighting, no per-skill minimum) - do not reopen the rule.
 *
 * Returns null unless every canonical skill carries a usable CEFR value:
 * a headline computed from a partial grading would overstate the level, and
 * LevelTracks plus its "not assessed" line already present partial data
 * honestly. Legacy reports with partial grading therefore show no headline.
 *
 * Ties-down note: with 7 skills the sum is an integer and sum/7 can never
 * land on exactly .5, so the tie branch is unreachable today. It is
 * implemented anyway (Math.ceil(avg - 0.5), which rounds an exact .5 down
 * where Math.round would round it up) so a future change to SKILL_KEYS
 * cannot silently flip the rule.
 */
export function computeOverallLevel(levelData: unknown): CefrLevel | null {
  let sum = 0
  for (const key of SKILL_KEYS) {
    const level = readSkill(levelData, key)
    if (level === null) return null
    sum += CEFR_TO_NUM[level]
  }
  const avg = sum / SKILL_KEYS.length
  const rounded = Math.ceil(avg - 0.5)
  // Each skill is 1..CEFR_LEVELS.length, so avg and therefore rounded are
  // always within that range; the index below cannot go out of bounds.
  return CEFR_LEVELS[rounded - 1]
}
