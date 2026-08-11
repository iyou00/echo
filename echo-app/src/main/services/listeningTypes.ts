import type { Track } from '../../types/ipc'
import type { CompanionResponseMode } from './chat/companionTypes'

export type ListeningDelivery = 'spoken' | 'silent'
export type ListeningDensity = 'silent' | 'micro' | 'brief' | 'full'

export type ListeningMove =
  | 'observe'
  | 'judge'
  | 'propose'
  | 'gentle_question'
  | 'playful_tease'
  | 'callback'
  | 'reversal'
  | 'self_talk'
  | 'shared_moment'
  | 'self_silence'
  | 'quiet_company'

export type ListeningSentenceForm =
  | 'observation'
  | 'judgment'
  | 'proposal'
  | 'question'
  | 'tease'
  | 'callback'
  | 'reversal'
  | 'self_talk'
  | 'shared'
  | 'leave_space'
  | 'silence'

export type ListeningTopicSource = 'conversation' | 'active_event' | 'weather' | 'music_transition' | 'session' | 'none'

export interface ListeningSessionRecord {
  id: number
  status: 'active' | 'ended'
  startedAt: string
  lastActiveAt: string
  endedAt?: string | null
  segmentCount: number
  companionMode: CompanionResponseMode | null
  consumedEventKeys: string[]
}

export interface ListeningSegmentRecord {
  id: number
  sessionId: number
  trackKey: string
  track: Track | null
  text: string
  delivery: ListeningDelivery
  density: ListeningDensity
  move: ListeningMove
  sentenceForm: ListeningSentenceForm
  topicSource: ListeningTopicSource
  signature: string
  generatedAt: string
}

export interface ListeningPlan {
  sessionId: number
  segmentIndex: number
  delivery: ListeningDelivery
  density: ListeningDensity
  move: ListeningMove
  sentenceForm: ListeningSentenceForm
  topicSource: ListeningTopicSource
  minChars: number
  maxChars: number
  maxSentences: number
  checkpoint: boolean
  reason: string
}
