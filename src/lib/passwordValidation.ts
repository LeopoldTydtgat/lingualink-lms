export function validatePassword(pw: string): string | null {
  if (pw.length < 8) {
    return 'Password must be at least 8 characters.'
  }
  if (!/[A-Z]/.test(pw)) {
    return 'Password must contain at least one uppercase letter.'
  }
  if (!/[a-z]/.test(pw)) {
    return 'Password must contain at least one lowercase letter.'
  }
  if (!/[0-9]/.test(pw)) {
    return 'Password must contain at least one number.'
  }
  return null
}
