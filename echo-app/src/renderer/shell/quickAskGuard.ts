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

/** 焦点已在文本输入里时，Ctrl+K 保持浏览器/系统默认，不抢（环境无关，便于测试） */
export function focusIsInTextField(activeElement: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!activeElement) return false
  if (activeElement.isContentEditable) return true
  const tag = (activeElement.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
