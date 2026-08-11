export const DEFAULT_USER_ID = 1

export function currentUserId(): number {
  return DEFAULT_USER_ID
}

export function currentUserSql(): string {
  return String(currentUserId())
}
