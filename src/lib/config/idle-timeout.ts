export const IDLE_TIMEOUT_MS = 60 * 60 * 1000        // 60 min total
export const WARNING_BEFORE_MS = 5 * 60 * 1000       // warn 5 min before logout (so modal at 55 min)
export const CLASS_SUPPRESSION_MS = 30 * 60 * 1000   // suppress if class within 30 min or in progress
export const ACTIVITY_THROTTLE_MS = 30 * 1000        // localStorage write at most once per 30s
export const LAST_ACTIVITY_KEY = 'lingualink_last_activity'
export const MAX_HIDDEN_MS = 4 * 60 * 60 * 1000  // 4 hours total hidden time before forced logout
