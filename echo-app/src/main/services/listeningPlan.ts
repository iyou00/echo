import type { CompanionProfile, CompanionResponseMode } from './chat/companionTypes'
import type {
  ListeningDensity,
  ListeningMove,
  ListeningPlan,
  ListeningSegmentRecord,
  ListeningSentenceForm,
  ListeningSessionRecord,
  ListeningTopicSource,
} from './listeningTypes'

const MOVE_FORMS: Record<ListeningMove, ListeningSentenceForm> = {
  observe: 'observation',
  judge: 'judgment',
  propose: 'proposal',
  gentle_question: 'question',
  playful_tease: 'tease',
  callback: 'callback',
  reversal: 'reversal',
  self_talk: 'self_talk',
  shared_moment: 'shared',
  self_silence: 'leave_space',
  quiet_company: 'silence',
}

const SERIOUS_MOVES: ListeningMove[] = ['observe', 'propose', 'self_silence']
const CONTEXT_MOVES: ListeningMove[] = ['callback', 'observe', 'judge', 'propose', 'gentle_question', 'reversal', 'shared_moment', 'self_talk']
const SESSION_MOVES: ListeningMove[] = ['self_talk', 'judge', 'reversal', 'shared_moment', 'self_silence', 'observe', 'propose']

function elapsedMinutes(session: ListeningSessionRecord, now: Date): number {
  const startedAt = new Date(session.startedAt).getTime()
  if (!Number.isFinite(startedAt)) return 0
  return Math.max(0, (now.getTime() - startedAt) / 60000)
}

function densityLimits(density: ListeningDensity, verbose: boolean): Pick<ListeningPlan, 'minChars' | 'maxChars' | 'maxSentences'> {
  if (density === 'silent') return { minChars: 0, maxChars: 0, maxSentences: 0 }
  if (density === 'micro') return { minChars: 16, maxChars: verbose ? 68 : 56, maxSentences: 2 }
  if (density === 'brief') return { minChars: 40, maxChars: verbose ? 120 : 100, maxSentences: 3 }
  return { minChars: 75, maxChars: verbose ? 180 : 150, maxSentences: 5 }
}

function chooseDensity(input: {
  automatic: boolean
  segmentIndex: number
  elapsed: number
  hasFreshContext: boolean
  emotionContext: boolean
  serious: boolean
  verbose: boolean
}): { density: ListeningDensity; checkpoint: boolean; reason: string } {
  if (input.segmentIndex === 0) return { density: 'full', checkpoint: true, reason: 'session_opening' }
  if (!input.automatic) return { density: 'brief', checkpoint: true, reason: 'manual_request' }
  if (input.hasFreshContext && input.emotionContext) return { density: 'full', checkpoint: true, reason: 'fresh_emotion_context' }
  if (input.hasFreshContext) return { density: 'brief', checkpoint: true, reason: 'fresh_conversation_context' }

  const checkpointEvery = input.verbose ? 3 : 4
  if (input.segmentIndex % checkpointEvery === 0) {
    return { density: 'brief', checkpoint: true, reason: 'session_checkpoint' }
  }
  const silenceEvery = input.verbose ? 5 : 4
  if (!input.serious && input.elapsed >= 20 && input.segmentIndex >= 6 && input.segmentIndex % silenceEvery === 2) {
    return { density: 'silent', checkpoint: false, reason: 'long_session_breathing_room' }
  }
  return { density: 'micro', checkpoint: false, reason: 'automatic_continuation' }
}

function chooseMove(input: {
  segmentIndex: number
  density: ListeningDensity
  hasFreshContext: boolean
  serious: boolean
  playfulAllowed: boolean
  recentSegments: ListeningSegmentRecord[]
}): ListeningMove {
  if (input.density === 'silent') return 'quiet_company'
  let pool = input.serious ? SERIOUS_MOVES : input.hasFreshContext ? CONTEXT_MOVES : SESSION_MOVES
  if (input.playfulAllowed && input.hasFreshContext) {
    pool = [...pool.slice(0, 2), 'playful_tease', ...pool.slice(2)]
  }
  if (input.density === 'micro') {
    pool = pool.filter((move) => move !== 'gentle_question' && move !== 'callback')
  }
  const recent = new Set(input.recentSegments.slice(0, 3).map((segment) => segment.move))
  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(input.segmentIndex + offset) % pool.length]
    if (!recent.has(candidate)) return candidate
  }
  return pool[input.segmentIndex % pool.length] ?? 'observe'
}

function chooseTopicSource(input: {
  segmentIndex: number
  hasFreshConversation: boolean
  hasActiveContext: boolean
  hasWeather: boolean
  density: ListeningDensity
}): ListeningTopicSource {
  if (input.density === 'silent') return 'none'
  if (input.hasFreshConversation) return 'conversation'
  if (input.hasActiveContext) return 'active_event'
  if (input.segmentIndex === 0 && input.hasWeather) return 'weather'
  return input.segmentIndex > 0 ? 'music_transition' : 'session'
}

export function buildListeningPlan(input: {
  session: ListeningSessionRecord
  recentSegments: ListeningSegmentRecord[]
  automatic: boolean
  hasFreshConversation: boolean
  hasActiveContext: boolean
  emotionContext: boolean
  hasWeather: boolean
  companionProfile: CompanionProfile
  companionMode?: CompanionResponseMode | null
  now?: Date
}): ListeningPlan {
  const now = input.now ?? new Date()
  const segmentIndex = input.session.segmentCount
  const hasFreshContext = input.hasFreshConversation || input.hasActiveContext
  const serious = input.companionMode === 'serious_care'
  const verbose = input.companionProfile.verbosity.confidence >= 0.45
    && input.companionProfile.verbosity.value >= 0.64
  const playfulAllowed = input.companionMode === 'playful_tease'
    && input.companionProfile.playfulness.value >= 0.38
  const densityChoice = chooseDensity({
    automatic: input.automatic,
    segmentIndex,
    elapsed: elapsedMinutes(input.session, now),
    hasFreshContext,
    emotionContext: input.emotionContext,
    serious,
    verbose,
  })
  const move = chooseMove({
    segmentIndex,
    density: densityChoice.density,
    hasFreshContext,
    serious,
    playfulAllowed,
    recentSegments: input.recentSegments,
  })
  const topicSource = chooseTopicSource({
    segmentIndex,
    hasFreshConversation: input.hasFreshConversation,
    hasActiveContext: input.hasActiveContext,
    hasWeather: input.hasWeather,
    density: densityChoice.density,
  })

  return {
    sessionId: input.session.id,
    segmentIndex,
    delivery: densityChoice.density === 'silent' ? 'silent' : 'spoken',
    density: densityChoice.density,
    move,
    sentenceForm: MOVE_FORMS[move],
    topicSource,
    ...densityLimits(densityChoice.density, verbose),
    checkpoint: densityChoice.checkpoint,
    reason: densityChoice.reason,
  }
}

export function formatListeningPlan(plan: ListeningPlan): string {
  return `delivery: ${plan.delivery}\ndensity: ${plan.density}\nlength: ${plan.minChars}-${plan.maxChars}\nmaxSentences: ${plan.maxSentences}\nmove: ${plan.move}\nsentenceForm: ${plan.sentenceForm}\ntopicSource: ${plan.topicSource}\ncheckpoint: ${plan.checkpoint ? 'true' : 'false'}\nreason: ${plan.reason}`
}

export const listeningPlanTestHelpers = {
  elapsedMinutes,
  chooseDensity,
  chooseMove,
}
