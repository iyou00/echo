import { countUserConversations, loadUserConversationsForDate } from '../../db/conversations'
import { getAllImportedTracks } from '../../db/playlists'
import { getSettings } from '../../db/settings'
import { getTasteProfile } from '../../db/taste'
import { hasListeningEvidenceForDate } from '../../db/tracks'
import { isOnboardingComplete } from '../../../shared/onboardingPolicy'

export interface ProductReadiness {
  firstUseDate: string
  onboardingCompleted: boolean
  llmConfigured: boolean
  musicLibraryReady: boolean
  profileReady: boolean
  memoryReady: boolean
}

export interface ScheduledTaskReadiness {
  ready: boolean
  reason?: string
}

export interface DailyEvidence {
  userConversation: boolean
  listening: boolean
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function firstUseDate(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? localIsoDate(new Date()) : localIsoDate(parsed)
}

export function getProductReadiness(): ProductReadiness {
  const settings = getSettings()
  const musicLibraryReady = getAllImportedTracks().length > 0
  const profileReady = Boolean(getTasteProfile())
  const conversationReady = countUserConversations() > 0
  return {
    firstUseDate: firstUseDate(settings.meta.firstUsedAt),
    onboardingCompleted: isOnboardingComplete(settings, profileReady),
    llmConfigured: Boolean(settings.llm.baseUrl.trim() && settings.llm.apiKey.trim() && settings.llm.model.trim()),
    musicLibraryReady,
    profileReady,
    memoryReady: profileReady || musicLibraryReady || conversationReady,
  }
}

export function hasDailyEvidence(date: string): boolean {
  const evidence = getDailyEvidence(date)
  return evidence.userConversation || evidence.listening
}

export function getDailyEvidence(date: string): DailyEvidence {
  return {
    userConversation: loadUserConversationsForDate(date, 1).length > 0,
    listening: hasListeningEvidenceForDate(date),
  }
}

export function evaluateYinyiReadiness(
  readiness: ProductReadiness,
  date: string,
  evidence: DailyEvidence,
): ScheduledTaskReadiness {
  if (!readiness.onboardingCompleted) {
    return { ready: false, reason: 'Echo 还在首次设置中，暂不运行风信任务。' }
  }
  if (date < readiness.firstUseDate) {
    return { ready: false, reason: '日期早于首次使用时间。' }
  }
  if (!evidence.userConversation && !evidence.listening) {
    return { ready: false, reason: '当天没有可写入风信的对话或听歌记录。' }
  }
  if (!readiness.llmConfigured) {
    return { ready: false, reason: '模型尚未配置，保留这一天等待后续补写。' }
  }
  return { ready: true }
}

export function yinyiReadiness(date: string): ScheduledTaskReadiness {
  return evaluateYinyiReadiness(getProductReadiness(), date, getDailyEvidence(date))
}

export function evaluateTasteStructuredReadiness(readiness: ProductReadiness): ScheduledTaskReadiness {
  if (!readiness.onboardingCompleted) return { ready: false, reason: 'Echo 还在首次设置中，暂不刷新结构画像。' }
  return readiness.profileReady
    ? { ready: true }
    : { ready: false, reason: '还没有画像，跳过结构刷新。' }
}

export function tasteStructuredReadiness(): ScheduledTaskReadiness {
  return evaluateTasteStructuredReadiness(getProductReadiness())
}

export function evaluateTastePortraitReadiness(readiness: ProductReadiness): ScheduledTaskReadiness {
  if (!readiness.onboardingCompleted) return { ready: false, reason: 'Echo 还在首次设置中，暂不刷新画像文案。' }
  if (!readiness.profileReady) return { ready: false, reason: '还没有画像，跳过文案刷新。' }
  if (!readiness.llmConfigured) return { ready: false, reason: '模型尚未配置，跳过画像文案刷新。' }
  return { ready: true }
}

export function tastePortraitReadiness(): ScheduledTaskReadiness {
  return evaluateTastePortraitReadiness(getProductReadiness())
}

export function evaluateCarePingReadiness(readiness: ProductReadiness): ScheduledTaskReadiness {
  if (!readiness.onboardingCompleted) return { ready: false, reason: 'Echo 还在首次设置中。' }
  if (!readiness.llmConfigured) return { ready: false, reason: '模型尚未配置。' }
  if (!readiness.memoryReady) return { ready: false, reason: 'Echo 还没有足够的相处线索。' }
  return { ready: true }
}

export function carePingReadiness(): ScheduledTaskReadiness {
  return evaluateCarePingReadiness(getProductReadiness())
}
