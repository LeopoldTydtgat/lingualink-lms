export const IDLE_TIMEOUT_MS = 120 * 60 * 1000       // 120 min total
export const WARNING_BEFORE_MS = 10 * 60 * 1000      // warn 10 min before logout (so modal at 110 min)
export const CLASS_SUPPRESSION_MS = 30 * 60 * 1000   // suppress if class within 30 min or in progress
export const ACTIVITY_THROTTLE_MS = 30 * 1000        // localStorage write at most once per 30s
export const LAST_ACTIVITY_KEY = 'lingualink_last_activity'
export const MAX_HIDDEN_MS = 8 * 60 * 60 * 1000  // 8 hours total hidden time before forced logout
