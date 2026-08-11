import { applyMemorySignal } from './memoryPolicy'

const VAGUE_PROFILE_CORRECTION_PATTERN = /^(?:这段|这个|这里)?(?:画像|理解|感觉|你写的|写得|说得)?(?:不准|不准确|不对|不太对|错了|有问题|怪怪的|不对劲)$/
const ACTIONABLE_PROFILE_CORRECTION_PATTERN = /不喜欢|不爱听|不想听|少推|别推|少来|不要|别总|别老|别把我|不要把我|不是|并不是|更喜欢|更想听|想听|喜欢|多来|换成|偏|更偏|阶段|最近|只是|刚好|纠正|情绪|氛围|旋律|人声|节奏|歌词|编曲|声音|嗓音|唱腔|感觉|味道|方向|歌|歌曲|音乐|歌手|艺人|流派/
const GENERIC_PROFILE_CORRECTION_TEXT = /^(?:我|你|echo|这段|这个|这里|画像|理解|感觉|写得|说得|有点|很|太|不|不太|不是|并不是|错了|不准|不准确|不对|怪怪的|有问题|感觉不对|理解错了|这段理解不准|这段不准|这段不对)$/

function compactCorrectionText(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。！？?！,.、；;:"“”'‘’《》（）()]/g, '').trim().toLowerCase()
}

export function isActionableProfileCorrection(content: string): boolean {
  const compact = compactCorrectionText(content)
  if (!compact) return false
  if (VAGUE_PROFILE_CORRECTION_PATTERN.test(compact)) return false
  if (/^(?:这段|这个|这里).*(?:不准|不准确|不对|不太对|错了|有问题|怪怪的|不对劲)$/.test(compact) && compact.length <= 10) return false
  if (GENERIC_PROFILE_CORRECTION_TEXT.test(compact)) return false
  if (!ACTIONABLE_PROFILE_CORRECTION_PATTERN.test(content)) return false
  const concrete = compact
    .replace(/^(我|你|echo)/i, '')
    .replace(/(不喜欢|不爱听|不想听|少推|别推|少来|不要|别总|别老|别把我|不要把我|不是|并不是|更喜欢|更想听|想听|喜欢|多来|换成|偏|更偏|阶段|最近|只是|刚好|纠正|的|地|得|这类|这种|那类|那种|一点|一些|方向|感觉|音乐|歌曲|歌|艺人|歌手|流派)/g, '')
    .trim()
  return concrete.length >= 2 || /《[^》]{1,40}》|\s\/\s/.test(content)
}

export async function correctProfileMemory(note: string): Promise<{ ok: boolean; message: string }> {
  const content = note.trim()
  if (!content) return { ok: false, message: '先写一句你想纠正的地方。' }
  if (content.length > 300) return { ok: false, message: '纠正内容控制在 300 字以内。' }
  if (!isActionableProfileCorrection(content)) {
    return { ok: false, message: '告诉我具体哪里不准，比如少推哪类声音，或别把你写成什么样。' }
  }

  await applyMemorySignal('correct_assumption', {
    target: content,
    strength: 0.3,
    note: content,
  }, {
    source: 'profile_correction',
    refreshReason: 'profile_correction',
  })

  return { ok: true, message: '我记下了。后面的推荐和回声会先按这个修正，重新生成画像时也会用上。' }
}
