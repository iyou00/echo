import type { UiBoundaryCode, UiBoundarySnapshot } from '../types/ipc'

const DEFAULT_BOUNDARY: Record<UiBoundaryCode, Pick<UiBoundarySnapshot, 'scope' | 'retryable' | 'preserved'>> = {
  startup_failed: { scope: 'system', retryable: true, preserved: ['userData'] },
  model_missing: { scope: 'surface', retryable: true, preserved: ['draft', 'currentTrack'] },
  model_invalid: { scope: 'surface', retryable: true, preserved: ['draft', 'currentTrack'] },
  music_empty: { scope: 'surface', retryable: true, preserved: ['draft'] },
  queue_empty: { scope: 'surface', retryable: true, preserved: ['currentTrack'] },
  taste_empty: { scope: 'surface', retryable: true, preserved: ['listeningHistory'] },
  context_empty: { scope: 'surface', retryable: false, preserved: ['conversationHistory'] },
  offline: { scope: 'system', retryable: true, preserved: ['draft', 'currentTrack', 'queue'] },
  no_playable: { scope: 'inline', retryable: true, preserved: ['draft', 'currentTrack', 'queue'] },
  playback_recovering: { scope: 'inline', retryable: true, preserved: ['currentTrack', 'position', 'queue'] },
  mic_denied: { scope: 'inline', retryable: true, preserved: ['draft', 'currentTrack'] },
  tts_fallback: { scope: 'inline', retryable: true, preserved: ['text', 'currentTrack', 'queue'] },
  yinyi_empty: { scope: 'surface', retryable: true, preserved: ['conversationHistory', 'listeningHistory'] },
  yinyi_failed: { scope: 'surface', retryable: true, preserved: ['conversationHistory', 'listeningHistory'] },
  task_failed: { scope: 'inline', retryable: true, preserved: ['userData', 'currentTrack'] },
  import_invalid: { scope: 'inline', retryable: true, preserved: ['existingLibrary', 'tasteProfile'] },
  close_busy: { scope: 'system', retryable: false, preserved: ['runningTasks', 'currentTrack'] },
}

export function createUiBoundary(
  code: UiBoundaryCode,
  patch: Partial<Omit<UiBoundarySnapshot, 'code'>> = {},
): UiBoundarySnapshot {
  return {
    code,
    ...DEFAULT_BOUNDARY[code],
    occurredAt: new Date().toISOString(),
    ...patch,
  }
}
