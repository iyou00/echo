export const YINYI_ARRIVAL_MS = 2000

export type YinyiArrivalInput = {
  page: string
  unread: boolean
  latestDate: string
  alreadyShownFor: string
}

/**
 * 到达仪式只对"这一封还没看过、且本次会话没有为它播过"的风信触发。
 * 刻意不看 lastViewedYinyiAt 之外的历史——仪式是欢迎，不是补作业。
 */
export function shouldShowYinyiArrival({ page, unread, latestDate, alreadyShownFor }: YinyiArrivalInput): boolean {
  if (page !== 'yinyi') return false
  if (!unread) return false
  if (!latestDate) return false
  return alreadyShownFor !== latestDate
}

export function yinyiArrivalDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : YINYI_ARRIVAL_MS
}
