import type { Track } from '../../../types/ipc'
import type { TrackFeedback } from '../../db/feedback'

export type MemorySignalSource =
  | 'playback'
  | 'favorite'
  | 'explicit_feedback'
  | 'chat'
  | 'taste_question'
  | 'profile_correction'

export interface MemoryPolicyInput {
  kind: string
  payload: Record<string, unknown>
  source: MemorySignalSource
  track?: Track
  feedback?: TrackFeedback | null
}

export interface MemoryPolicyDecision {
  apply: boolean
  kind: string
  payload: Record<string, unknown>
  refreshReason: string
  note: string
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function withPolicy(
  input: MemoryPolicyInput,
  apply: boolean,
  payload: Record<string, unknown>,
  refreshReason: string,
  note: string,
): MemoryPolicyDecision {
  return {
    apply,
    kind: input.kind,
    payload: {
      ...input.payload,
      ...payload,
      memoryPolicy: {
        source: input.source,
        note,
      },
    },
    refreshReason,
    note,
  }
}

export function decideMemorySignal(input: MemoryPolicyInput): MemoryPolicyDecision {
  const completionRate = num(input.payload.completionRate, num(input.payload.strength, 0))
  const feedback = input.feedback

  if (input.kind === 'played') {
    const playCount = feedback?.playCount ?? 0
    const strength = playCount >= 3 ? 0.04 : 0.02
    return withPolicy(
      input,
      completionRate >= 0.8,
      { strength },
      playCount >= 3 ? 'played_repeated' : 'played',
      playCount >= 3 ? '连续完整听完，进入中期偏好。' : '完整听完，作为弱正向信号。',
    )
  }

  if (input.source === 'explicit_feedback') {
    const positive = input.kind === 'like_artist' || input.kind === 'like_genre' || input.kind === 'reinforce_vibe'
    return withPolicy(
      input,
      true,
      { strength: positive ? Math.max(num(input.payload.strength, 0), 0.08) : 0.04 },
      positive ? 'explicit_like' : 'explicit_miss',
      positive ? '用户明确要求多来一点。' : '用户明确反馈方向不合适。',
    )
  }

  if (input.kind === 'skipped') {
    const skipCount = feedback?.skipCount ?? 0
    return withPolicy(
      input,
      skipCount >= 2,
      { strength: skipCount >= 4 ? 0.035 : 0.015 },
      skipCount >= 4 ? 'skipped_repeated' : 'skipped',
      skipCount >= 2 ? '重复跳过，降低相近方向。' : '单次跳过只记录事实，暂缓写入画像。',
    )
  }

  if (input.kind === 'looped') {
    const loopCount = feedback?.loopCount ?? 0
    return withPolicy(
      input,
      true,
      { strength: loopCount >= 2 ? 0.075 : 0.055 },
      'looped',
      '循环播放是强偏好信号。',
    )
  }

  if (input.kind === 'favorited') {
    return withPolicy(
      input,
      true,
      { strength: 0.09 },
      'favorited',
      '收藏是明确长期偏好。',
    )
  }

  if (input.kind === 'unfavorited') {
    return withPolicy(
      input,
      false,
      { strength: 0 },
      'unfavorited',
      '取消收藏撤销显式偏好，保留历史事实。',
    )
  }

  if (input.kind === 'correct_assumption' || input.source === 'profile_correction') {
    return withPolicy(
      input,
      true,
      { strength: Math.max(num(input.payload.strength, 0), 0.25) },
      'profile_correction',
      '用户明确修正 Echo 的理解。',
    )
  }

  if (input.source === 'chat') {
    return withPolicy(
      input,
      true,
      { strength: Math.min(num(input.payload.strength, 0.08), 0.12) },
      'chat_signal',
      '聊天表达是弱信号，等待后续播放或收藏确认。',
    )
  }

  return withPolicy(input, true, {}, 'memory_signal', '默认记忆信号。')
}

export function memoryPolicySummary(): string {
  return [
    'Memory Policy v1:',
    '- 收藏、循环、明确反馈是强信号。',
    '- 完整听完是弱正向信号，重复后增强。',
    '- 单次跳过只记录事实，重复跳过后进入画像。',
    '- 聊天表达是弱信号，需要后续行为确认。',
    '- 取消收藏撤销显式偏好，保留历史事实。',
    '- 用户主动纠正画像时，作为明确 correction 记录。',
  ].join('\n')
}
