export type QuickAskGuardInput = {
  hasLlmConfig: boolean
  firstRunOpen: boolean
  onboardingOpen: boolean
  closeDialogOpen: boolean
}

export type ShortcutLikeEvent = {
  ctrlKey: boolean
  metaKey: boolean
  key: string
}

export function isQuickAskShortcut(event: ShortcutLikeEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
}

/** 首启、引导、关闭确认这些"全屏对话"进行中时不抢快捷键 */
export function shouldOpenQuickAsk(input: QuickAskGuardInput): boolean {
  if (!input.hasLlmConfig) return false
  if (input.firstRunOpen || input.onboardingOpen || input.closeDialogOpen) return false
  return true
}
