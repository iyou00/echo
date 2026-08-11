import { getDb } from './index'
import { parseJson } from './json'
import type {
  CompanionPreferenceSignal,
  CompanionProfile,
  CompanionResponseStrategy,
} from '../services/chat/companionTypes'
import { createDefaultCompanionProfile } from '../services/chat/companionTypes'
import { applySignalsToCompanionProfile, decayImplicitCompanionProfile } from '../services/chat/companionStrategy'

const DIMENSIONS = ['warmth', 'playfulness', 'directness', 'initiative', 'verbosity'] as const

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizeProfile(raw: CompanionProfile | null | undefined): CompanionProfile {
  const fallback = createDefaultCompanionProfile()
  if (!raw || raw.schemaVersion !== 1) return fallback
  for (const dimension of DIMENSIONS) {
    const current = raw[dimension]
    if (!current || !Number.isFinite(current.value) || !Number.isFinite(current.confidence)) {
      raw[dimension] = fallback[dimension]
      continue
    }
    current.value = clamp(current.value)
    current.confidence = clamp(current.confidence)
    current.evidenceCount = Math.max(0, Math.floor(current.evidenceCount || 0))
    current.explicitEvidenceCount = Math.max(0, Math.floor(current.explicitEvidenceCount || 0))
  }
  return raw
}

export function getCompanionProfile(): CompanionProfile {
  const row = getDb()
    .prepare('SELECT profile_json FROM companion_profiles WHERE user_id = current_user_id()')
    .get() as { profile_json?: string } | undefined
  return decayImplicitCompanionProfile(normalizeProfile(parseJson<CompanionProfile | null>(row?.profile_json, null, 'companion_profiles.profile_json')))
}

export function saveCompanionProfile(profile: CompanionProfile): CompanionProfile {
  const normalized = normalizeProfile(profile)
  normalized.updatedAt = new Date().toISOString()
  getDb().prepare(`
    INSERT INTO companion_profiles (user_id, profile_json, updated_at)
    VALUES (current_user_id(), ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      profile_json = excluded.profile_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(normalized))
  return normalized
}

export function applyCompanionPreferenceSignals(signals: CompanionPreferenceSignal[]): CompanionProfile {
  if (signals.length === 0) return getCompanionProfile()
  const profile = getCompanionProfile()
  const now = new Date().toISOString()
  const insert = getDb().prepare(`
    INSERT INTO companion_signal_events (user_id, dimension, direction, confidence, explicit, evidence)
    VALUES (current_user_id(), ?, ?, ?, ?, ?)
  `)

  for (const signal of signals) {
    const confidence = clamp(signal.confidence)
    insert.run(signal.dimension, signal.direction, confidence, signal.explicit ? 1 : 0, signal.evidence.slice(0, 160))
  }
  return saveCompanionProfile(applySignalsToCompanionProfile(profile, signals, now))
}

export function loadLatestAssistantResponseStrategy(): CompanionResponseStrategy | null {
  const row = getDb().prepare(`
    SELECT meta_json
    FROM conversations
    WHERE user_id = current_user_id() AND role = 'assistant'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as { meta_json?: string | null } | undefined
  const meta = parseJson<{ responseStrategy?: CompanionResponseStrategy }>(row?.meta_json, {}, 'conversations.response_strategy')
  return meta.responseStrategy ?? null
}
