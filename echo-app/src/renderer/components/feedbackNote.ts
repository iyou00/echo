export const FEEDBACK_NOTE_MS = 3200

export function favoriteNote(favorited: boolean): string {
  return favorited ? '帮你收好了，想听随时来。' : '好，已经从收藏里拿掉了。'
}

export function feedbackFallbackNote(): string {
  return '记下了。'
}
