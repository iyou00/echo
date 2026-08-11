export type CompanionPreferenceDimension = 'warmth' | 'playfulness' | 'directness' | 'initiative' | 'verbosity'

export interface CompanionPreferenceTrait {
  value: number
  confidence: number
  evidenceCount: number
  explicitEvidenceCount?: number
  updatedAt: string
}

export interface CompanionProfile {
  schemaVersion: 1
  warmth: CompanionPreferenceTrait
  playfulness: CompanionPreferenceTrait
  directness: CompanionPreferenceTrait
  initiative: CompanionPreferenceTrait
  verbosity: CompanionPreferenceTrait
  updatedAt: string
}

export type CompanionResponseMode =
  | 'warm_care'
  | 'playful_tease'
  | 'practical'
  | 'quiet_company'
  | 'celebrate'
  | 'clarify'
  | 'serious_care'

export interface CompanionResponseStrategy {
  mode: CompanionResponseMode
  warmth: number
  playfulness: number
  directness: number
  initiative: 'reply_only' | 'suggest_action' | 'play_music'
  verbosity: 'short' | 'normal'
  vulnerability: 'low' | 'medium' | 'high'
  reasonCodes: string[]
}

export interface CompanionPreferenceSignal {
  dimension: CompanionPreferenceDimension
  direction: 'more' | 'less'
  confidence: number
  explicit: boolean
  evidence: string
}

const DEFAULT_COMPANION_VALUES = {
  warmth: 0.72,
  playfulness: 0.42,
  directness: 0.56,
  initiative: 0.58,
  verbosity: 0.46,
} as const

export function createDefaultCompanionProfile(now = new Date().toISOString()): CompanionProfile {
  const trait = (value: number) => ({ value, confidence: 0.2, evidenceCount: 0, explicitEvidenceCount: 0, updatedAt: now })
  return {
    schemaVersion: 1,
    warmth: trait(DEFAULT_COMPANION_VALUES.warmth),
    playfulness: trait(DEFAULT_COMPANION_VALUES.playfulness),
    directness: trait(DEFAULT_COMPANION_VALUES.directness),
    initiative: trait(DEFAULT_COMPANION_VALUES.initiative),
    verbosity: trait(DEFAULT_COMPANION_VALUES.verbosity),
    updatedAt: now,
  }
}
