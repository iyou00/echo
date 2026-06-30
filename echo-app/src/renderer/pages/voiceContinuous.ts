import type { Track } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'

export type VoiceContinuousStatus = 'idle' | 'generating' | 'speaking' | 'done' | 'text-only-done' | 'error'

export const VOICE_CONTINUOUS_TRIGGER_COOLDOWN_MS = 1500

export function shouldTriggerNextVoiceSegment(input: {
  isActive: boolean
  voiceContinuous: boolean
  status: VoiceContinuousStatus
  musicStarted: boolean
  baselinePlaybackKey: string
  current: Track | null | undefined
}): boolean {
  if (!input.isActive || !input.voiceContinuous) return false
  if (input.status !== 'done' && input.status !== 'text-only-done') return false
  const current = input.current
  const stillBaseline = Boolean(input.baselinePlaybackKey && current && trackIdentity(current) === input.baselinePlaybackKey)
  if (!input.musicStarted) return !current || stillBaseline
  if (!current) return true
  return false
}

export function shouldAcceptVoiceContinuousTrigger(
  lastTriggeredAt: number,
  now: number,
  cooldownMs = VOICE_CONTINUOUS_TRIGGER_COOLDOWN_MS,
): boolean {
  return lastTriggeredAt <= 0 || now - lastTriggeredAt >= cooldownMs
}
