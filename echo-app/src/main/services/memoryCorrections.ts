import type { ActiveEvent } from '../db/events'
import { loadRecentEvents } from '../db/events'

const CORRECTION_MEANING_TERMS = /喜欢|不喜欢|不对|不好听|不是|错|纠正|更|少|多|别|不要|想听|播放|推荐|情绪|氛围|旋律|人声|节奏|歌词|编曲|声音|嗓音|唱腔|感觉|味道|方向/

export function isBareTrackLabelCorrection(content: string): boolean {
  const clean = content.replace(/\s+/g, ' ').trim()
  if (!/^[^:：]{1,120}$/.test(clean)) return false
  if (!/\s\/\s/.test(clean)) return false
  return !CORRECTION_MEANING_TERMS.test(clean)
}

export function isTrustedCorrectionEvent(event: ActiveEvent): boolean {
  const content = event.content.trim()
  if (!content) return false
  return !isBareTrackLabelCorrection(content)
}

export function loadTrustedCorrections(limit = 8): ActiveEvent[] {
  const scanLimit = Math.max(limit * 4, limit)
  return loadRecentEvents('correction', scanLimit)
    .filter(isTrustedCorrectionEvent)
    .slice(0, limit)
}
