import type { CompanionResponseBrief } from './companionResponse'
import {
  createDefaultCompanionProfile,
  type CompanionPreferenceDimension,
  type CompanionPreferenceSignal,
  type CompanionProfile,
  type CompanionResponseMode,
  type CompanionResponseStrategy,
} from './companionTypes'

const DIMENSIONS = new Set<CompanionPreferenceDimension>(['warmth', 'playfulness', 'directness', 'initiative', 'verbosity'])
const MODES = new Set<CompanionResponseMode>(['warm_care', 'playful_tease', 'practical', 'quiet_company', 'celebrate', 'clarify', 'serious_care'])
const SERIOUS_PATTERN = /想死|不想活|活不下|撑不下去|自杀|伤害自己|胸痛|胸闷|呼吸困难|喘不上气|晕倒|昏倒|高烧|急诊|连续失眠|几天没睡|整夜没睡/i
const VULNERABLE_PATTERN = /被骂|挨骂|失业|分手|离婚|去世|生病|难过|伤心|想哭|崩溃|低落|压抑|焦虑/i
const NO_TEASING_PATTERN = /别(?:调侃|损|骂|挖苦|阴阳)|不要(?:调侃|损|骂|挖苦|阴阳)|不喜欢(?:被)?(?:调侃|损|骂|挖苦|阴阳)/i

function clamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function compactCompanionProfile(profile: CompanionProfile): Record<string, unknown> {
  const compact: Record<string, unknown> = {}
  for (const dimension of DIMENSIONS) {
    const trait = profile[dimension]
    compact[dimension] = {
      value: Number(trait.value.toFixed(2)),
      confidence: Number(trait.confidence.toFixed(2)),
      evidenceCount: trait.evidenceCount,
    }
  }
  return compact
}

function cloneCompanionProfile(profile: CompanionProfile): CompanionProfile {
  return {
    ...profile,
    warmth: { ...profile.warmth },
    playfulness: { ...profile.playfulness },
    directness: { ...profile.directness },
    initiative: { ...profile.initiative },
    verbosity: { ...profile.verbosity },
  }
}

export function applySignalsToCompanionProfile(
  profile: CompanionProfile,
  signals: CompanionPreferenceSignal[],
  now = new Date().toISOString(),
): CompanionProfile {
  const next = cloneCompanionProfile(profile)
  for (const signal of signals) {
    const trait = next[signal.dimension]
    const confidence = clamp(signal.confidence, 0.5)
    const target = signal.direction === 'more' ? 0.88 : 0.12
    const alpha = (signal.explicit ? 0.5 : 0.14) * confidence
    trait.value = clamp(trait.value * (1 - alpha) + target * alpha, trait.value)
    trait.confidence = clamp(trait.confidence + (signal.explicit ? 0.32 : 0.08) * confidence, trait.confidence)
    trait.evidenceCount += 1
    trait.explicitEvidenceCount = (trait.explicitEvidenceCount ?? 0) + (signal.explicit ? 1 : 0)
    trait.updatedAt = now
  }
  next.updatedAt = now
  return next
}

export function decayImplicitCompanionProfile(profile: CompanionProfile, now = new Date()): CompanionProfile {
  const next = cloneCompanionProfile(profile)
  const defaults = createDefaultCompanionProfile(now.toISOString())
  for (const dimension of DIMENSIONS) {
    const trait = next[dimension]
    if ((trait.explicitEvidenceCount ?? 0) > 0) continue
    const ageDays = Math.max(0, (now.getTime() - new Date(trait.updatedAt).getTime()) / 86400000)
    if (!Number.isFinite(ageDays) || ageDays <= 30) continue
    const decay = Math.min(0.45, ((ageDays - 30) / 180) * 0.3)
    trait.value = trait.value * (1 - decay) + defaults[dimension].value * decay
    trait.confidence = Math.max(0.2, trait.confidence * (1 - decay))
  }
  return next
}

export function extractExplicitCompanionSignals(text: string): CompanionPreferenceSignal[] {
  const signals: CompanionPreferenceSignal[] = []
  const add = (dimension: CompanionPreferenceDimension, direction: 'more' | 'less', evidence: string) => {
    if (!signals.some((signal) => signal.dimension === dimension && signal.direction === direction)) {
      signals.push({ dimension, direction, confidence: 0.98, explicit: true, evidence })
    }
  }
  if (/可以(?:调侃|损|骂|吐槽)我|多(?:调侃|损|吐槽)|像朋友一样(?:调侃|损|骂)/i.test(text)) add('playfulness', 'more', text)
  if (/别一味安慰|别只会安慰|少灌鸡汤/i.test(text)) {
    add('warmth', 'less', text)
    add('directness', 'more', text)
  }
  const noTeasing = NO_TEASING_PATTERN.test(text)
  if (noTeasing) add('playfulness', 'less', text)
  if (/温柔点|安慰我|哄哄我|多关心我/i.test(text)) add('warmth', 'more', text)
  if (/别(?:安慰|哄)|不要(?:安慰|哄)|少安慰/i.test(text)) add('warmth', 'less', text)
  if (/直接点|直说|有话直说|别绕弯/i.test(text)) add('directness', 'more', text)
  if (/委婉点|别太直接|说轻一点/i.test(text)) add('directness', 'less', text)
  if (/少说点|简短点|别说太多/i.test(text)) add('verbosity', 'less', text)
  if (/多陪我聊|多说一点|说详细点/i.test(text)) add('verbosity', 'more', text)
  if (/别主动推荐歌|别老推歌|不想听歌就别推/i.test(text)) add('initiative', 'less', text)
  if (/可以主动推荐|多给我推荐歌|有合适的就放/i.test(text)) add('initiative', 'more', text)
  const noComfort = /别(?:安慰|哄)|不要(?:安慰|哄)|少安慰/i.test(text)
  return signals.filter((signal) => {
    if (noTeasing && signal.dimension === 'playfulness' && signal.direction === 'more') return false
    if (noComfort && signal.dimension === 'warmth' && signal.direction === 'more') return false
    return true
  })
}

export function inferCompanionReactionSignals(
  text: string,
  previous: CompanionResponseStrategy | null | undefined,
): CompanionPreferenceSignal[] {
  if (!previous) return []
  const positive = /(?:你|刚才|上次).{0,8}(?:这样说|这种说法|这个语气|这种语气).{0,6}(?:挺好|很好|不错|喜欢|舒服)|就(?:这样|这么)和我说/i.exec(text)
  const negative = /不喜欢你.{0,8}(?:这样说|这种说法|这个语气|这种语气)|(?:你|刚才|上次).{0,8}(?:这样说|这种说法|这个语气|这种语气).{0,6}(?:不舒服|不喜欢|不好)|别再这么说/i.exec(text)
  const match = positive ?? negative
  if (!match) return []

  let dimension: CompanionPreferenceDimension
  let positiveDirection: 'more' | 'less' = 'more'
  if (previous.mode === 'playful_tease') dimension = 'playfulness'
  else if (previous.mode === 'quiet_company') {
    dimension = 'initiative'
    positiveDirection = 'less'
  } else if (previous.mode === 'practical' || previous.mode === 'clarify') dimension = 'directness'
  else dimension = 'warmth'
  return [{
    dimension,
    direction: positive ? positiveDirection : positiveDirection === 'more' ? 'less' : 'more',
    confidence: 0.82,
    explicit: false,
    evidence: match[0].slice(0, 160),
  }]
}

export function normalizeCompanionSignals(raw: unknown, sourceText: string): CompanionPreferenceSignal[] {
  const parsed = Array.isArray(raw) ? raw : []
  const normalized: CompanionPreferenceSignal[] = []
  for (const item of parsed.slice(0, 5)) {
    const value = objectValue(item)
    const dimension = typeof value.dimension === 'string' && DIMENSIONS.has(value.dimension as CompanionPreferenceDimension)
      ? value.dimension as CompanionPreferenceDimension
      : null
    const direction = value.direction === 'more' || value.direction === 'less' ? value.direction : null
    const evidence = typeof value.evidence === 'string' ? value.evidence.trim().slice(0, 160) : ''
    if (!dimension || !direction || !evidence || !sourceText.includes(evidence)) continue
    normalized.push({
      dimension,
      direction,
      confidence: clamp(value.confidence, 0.5),
      explicit: value.explicit === true,
      evidence,
    })
  }
  for (const signal of extractExplicitCompanionSignals(sourceText)) {
    if (!normalized.some((item) => item.dimension === signal.dimension && item.direction === signal.direction)) normalized.push(signal)
  }
  return normalized.slice(0, 5)
}

export function createFallbackResponseStrategy(input: {
  userText: string
  wantsMusic: boolean
  profile?: CompanionProfile | null
  brief?: CompanionResponseBrief | null
}): CompanionResponseStrategy {
  const profile = input.profile ?? createDefaultCompanionProfile()
  const serious = SERIOUS_PATTERN.test(input.userText) || input.brief?.tone === 'serious_care'
  const repeatedFatigue = input.brief?.tone === 'playful_concern'
  const teasingBlocked = NO_TEASING_PATTERN.test(input.userText)
    || (profile.playfulness.confidence >= 0.5 && profile.playfulness.value < 0.28)
  const playful = repeatedFatigue && !teasingBlocked && !serious
  const vulnerable = serious ? 'high' : VULNERABLE_PATTERN.test(input.userText) ? 'medium' : 'low'
  return {
    mode: serious ? 'serious_care' : playful ? 'playful_tease' : vulnerable === 'medium' ? 'warm_care' : 'practical',
    warmth: serious ? 0.95 : Math.max(profile.warmth.value, vulnerable === 'medium' ? 0.72 : 0.55),
    playfulness: serious || teasingBlocked ? 0 : playful ? Math.max(0.58, profile.playfulness.value) : Math.min(0.35, profile.playfulness.value),
    directness: serious ? Math.max(0.65, profile.directness.value) : profile.directness.value,
    initiative: input.wantsMusic ? 'play_music' : profile.initiative.value >= 0.66 ? 'suggest_action' : 'reply_only',
    verbosity: profile.verbosity.value >= 0.6 ? 'normal' : 'short',
    vulnerability: vulnerable,
    reasonCodes: serious ? ['safety_risk'] : repeatedFatigue ? ['repeated_fatigue'] : vulnerable === 'medium' ? ['current_vulnerability'] : ['current_request'],
  }
}

export function normalizeCompanionResponseStrategy(raw: unknown, input: {
  userText: string
  wantsMusic: boolean
  profile?: CompanionProfile | null
  brief?: CompanionResponseBrief | null
}): CompanionResponseStrategy {
  const fallback = createFallbackResponseStrategy(input)
  const value = objectValue(raw)
  const strategy: CompanionResponseStrategy = {
    mode: typeof value.mode === 'string' && MODES.has(value.mode as CompanionResponseMode) ? value.mode as CompanionResponseMode : fallback.mode,
    warmth: clamp(value.warmth, fallback.warmth),
    playfulness: clamp(value.playfulness, fallback.playfulness),
    directness: clamp(value.directness, fallback.directness),
    initiative: value.initiative === 'reply_only' || value.initiative === 'suggest_action' || value.initiative === 'play_music'
      ? value.initiative
      : fallback.initiative,
    verbosity: value.verbosity === 'short' || value.verbosity === 'normal' ? value.verbosity : fallback.verbosity,
    vulnerability: value.vulnerability === 'low' || value.vulnerability === 'medium' || value.vulnerability === 'high'
      ? value.vulnerability
      : fallback.vulnerability,
    reasonCodes: Array.isArray(value.reasonCodes)
      ? value.reasonCodes.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5)
      : fallback.reasonCodes,
  }

  const profile = input.profile ?? createDefaultCompanionProfile()
  const serious = SERIOUS_PATTERN.test(input.userText) || strategy.vulnerability === 'high' || input.brief?.tone === 'serious_care'
  const teasingBlocked = NO_TEASING_PATTERN.test(input.userText)
    || (profile.playfulness.confidence >= 0.5 && profile.playfulness.value < 0.28)
  if (serious) {
    strategy.mode = 'serious_care'
    strategy.vulnerability = 'high'
    strategy.warmth = Math.max(0.85, strategy.warmth)
    strategy.playfulness = 0
    strategy.directness = Math.max(0.65, strategy.directness)
    strategy.reasonCodes = Array.from(new Set([...strategy.reasonCodes, 'safety_risk']))
  } else if (teasingBlocked || strategy.vulnerability === 'medium') {
    if (strategy.mode === 'playful_tease') strategy.mode = 'warm_care'
    strategy.playfulness = Math.min(strategy.playfulness, teasingBlocked ? 0.05 : 0.22)
  }
  if (input.wantsMusic) strategy.initiative = 'play_music'
  return strategy
}

export const companionStrategyTestHelpers = {
  normalizeCompanionResponseStrategy,
  normalizeCompanionSignals,
}
