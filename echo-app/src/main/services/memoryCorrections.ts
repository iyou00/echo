import type { ActiveEvent } from '../db/events'
import { loadRecentEvents } from '../db/events'

const CORRECTION_MEANING_TERMS = /喜欢|不喜欢|不对|不好听|不是|错|纠正|更|少|多|别|不要|想听|播放|推荐|情绪|氛围|旋律|人声|节奏|歌词|编曲|声音|嗓音|唱腔|感觉|味道|方向/
const VAGUE_CORRECTION_PATTERN = /^(?:这段|这个|这里)?(?:画像|理解|感觉|你写的|你写得|写得|说得)?(?:不准|不准确|不对|不太对|错了|有问题|怪怪的|不对劲)$/

function compactCorrectionText(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。！？?！,.、；;:"“”'‘’《》（）()]/g, '').trim().toLowerCase()
}

export function isBareTrackLabelCorrection(content: string): boolean {
  const clean = content.replace(/\s+/g, ' ').trim()
  if (!/^[^:：]{1,120}$/.test(clean)) return false
  if (!/\s\/\s/.test(clean)) return false
  return !CORRECTION_MEANING_TERMS.test(clean)
}

export function isVagueCorrection(content: string): boolean {
  const compact = compactCorrectionText(content)
  if (!compact) return true
  if (VAGUE_CORRECTION_PATTERN.test(compact)) return true
  return /^(?:这段|这个|这里).*(?:不准|不准确|不对|不太对|错了|有问题|怪怪的|不对劲)$/.test(compact)
    && compact.length <= 10
}

export function isTrustedCorrectionEvent(event: ActiveEvent): boolean {
  const content = event.content.trim()
  if (!content) return false
  if (isVagueCorrection(content)) return false
  return !isBareTrackLabelCorrection(content)
}

export function loadTrustedCorrections(limit = 8): ActiveEvent[] {
  const scanLimit = Math.max(limit * 4, limit)
  return loadRecentEvents('correction', scanLimit)
    .filter(isTrustedCorrectionEvent)
    .slice(0, limit)
}
