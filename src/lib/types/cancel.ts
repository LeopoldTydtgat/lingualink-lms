export type CancelResult =
  | { success: true; refunded: boolean }
  | { success: false; error: string; code?: 'LESSON_NOT_CANCELLABLE' }
