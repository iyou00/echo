import type { ChatHints, Track } from '../../../types/ipc'
import { rememberMusicCorrection } from '../../skills/music/correctionMemory'
import { hasTrackIdentity, trackIdentitySet } from '../../skills/music/identity'
import { searchMusic } from '../../skills/music/search'
import type { MusicEntityConstraint } from '../../skills/music/verifier'
import type { IntentOverride } from '../recommendation'
import { recordFeedback, recordSkippedFeedback } from '../feedback'
import { ensureFavorite } from '../favorites'
import { next as playNext } from '../playback'
import type { ChatIntent } from './intent'
import { setPendingMusicEntityClarification } from './pendingIntents'

export type CurrentTrackFeedbackResult =
  | { handled: false }
  | { handled: true; content: string; tracks: Track[]; hints?: ChatHints }

export function trackLabel(track: Track): string {
  return `${track.artist}的《${track.title}》`
}

function wantsTrackChange(text: string, intent: ChatIntent): boolean {
  return intent.feedbackAction === 'skip'
    || /换一首|换首|换掉|下一首|跳过|切歌|切掉|别放|不听|(?:推荐|来|找|放)(?:一首|首|点|个)?别的|别的(?:歌|一首)/.test(text)
    || (intent.feedbackAction === 'not_right' && intent.wantsMusic && hasReplacementDirection(text, intent))
}

function wantsFreshReplacementSearch(text: string): boolean {
  return /(?:推荐|来|找|放)(?:一首|首|点|个)?别的|别的(?:歌|一首)/.test(text)
}

const REPLACEMENT_DIRECTION_PATTERN = /激情|激昂|高昂|亢奋|振奋|热血|澎湃|炸|爆|带感|节奏|鼓点|动感|有劲|提神|清醒|燃|快一点|快点|快歌|舒缓|安静|放松|慢一点|慢点|粤语|英文|英语|欧美|韩语|日语|华语|民谣|摇滚|说唱|电子|r&b|rnb|爵士/i
const FEEDBACK_WORD_PATTERN = /这首歌|这首|这歌|刚才|当前|现在这首|不好听|没感觉|不喜欢|不对|不太对|不合适|不太合适|别放|不听|腻了|太吵|太慢|太快|错误|错歌|放错|播错/gi
const CHANGE_WORD_PATTERN = /换一首|换首|换掉|下一首|跳过|切歌|切掉|换个|换一个|(?:推荐|来|找|放)(?:一首|首|点|个)?别的|别的(?:歌|一首)/gi
const EXPLICIT_MISS_PATTERN = /不好听|没感觉|不喜欢|不爱听|不想听|不对|不太对|不合适|不太合适|别放|不听|腻了|太吵|太慢|太快|太闹|太炸|太平|太软|太激烈|太激情|太激昂|太高昂|太亢奋|太热血|太澎湃|太燃|太带感|太情绪高昂|情绪太高昂|没劲|不够|差点意思|少了点|错误|错歌|放错|播错|不是.+(?:版|版本|唱|歌手|的)|听着不舒服|不舒服|不行|不准|不贴|不适合/
const ALLOWED_REPLACEMENT_LANGUAGES = new Set(['华语', '粤语', '英语', '韩语', '日语'])
const EXPLICIT_FEEDBACK_NEXT_OPTIONS = { recordCurrentFeedback: false, skippedReason: 'explicit_feedback' } as const
const DIRECTION_PREFIX_PATTERN = /^(?:再|更|稍微|稍|来点|来些|有点|一点|一些|点|给我|帮我)\s*/i
const DIRECTION_SUFFIX_PATTERN = /(?:一点|一些|点|的)+$/i

function hasReplacementDirection(text: string, intent: ChatIntent): boolean {
  const recommendation = intent.recommendationIntent
  if (recommendation.artistQuery || recommendation.seedTitle || recommendation.language || recommendation.energy || recommendation.tempo) return true
  if (recommendation.scenes.length > 0) return true
  if (recommendation.moods.some((mood) => mood !== '陪伴')) return true
  return REPLACEMENT_DIRECTION_PATTERN.test(text)
}

function shouldRecordExplicitMiss(text: string): boolean {
  if (EXPLICIT_MISS_PATTERN.test(text)) return true
  return false
}

function buildReplacementQuery(text: string): string {
  const cleaned = text
    .replace(FEEDBACK_WORD_PATTERN, '')
    .replace(CHANGE_WORD_PATTERN, '')
    .replace(/[，。！？?！,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)了(?=\s|$)/g, ' ')
    .replace(DIRECTION_PREFIX_PATTERN, '')
    .replace(DIRECTION_SUFFIX_PATTERN, '')
    .trim()
  if (!cleaned && /太慢|没劲|太软|太平/.test(text)) return '推荐一首节奏更快更有劲的歌'
  if (!cleaned && /太吵|太炸|太快|太闹/.test(text)) return '推荐一首舒缓一点的歌'
  if (!cleaned) return ''
  return /(?:歌|歌曲|音乐|曲子|单曲)$/.test(cleaned)
    ? `推荐一首${cleaned}`
    : `推荐一首${cleaned}的歌`
}

function replacementIntentOverride(intent: ChatIntent): IntentOverride {
  const recommendation = intent.recommendationIntent
  const language = recommendation.language && ALLOWED_REPLACEMENT_LANGUAGES.has(recommendation.language)
    ? recommendation.language as IntentOverride['language']
    : undefined
  return {
    wantsMusic: true,
    language,
    moods: recommendation.moods.filter((mood) => mood !== '陪伴'),
    scenes: recommendation.scenes,
    energy: recommendation.energy,
    tempo: recommendation.tempo,
    familiarity: recommendation.familiarity,
    targetCount: 1,
    seedTitle: recommendation.seedTitle,
    artistQuery: recommendation.artistQuery,
    intentConfidence: Math.max(0.86, intent.confidence),
    evidence: recommendation.evidence,
    rejectIf: recommendation.rejectIf,
  }
}

function sameTrack(left: Track, right: Track): boolean {
  return hasTrackIdentity(trackIdentitySet([right]), left)
}

function correctionSearchQuery(correction: MusicEntityConstraint): string | null {
  const artist = correction.artistQuery?.trim()
  const title = correction.seedTitle?.trim()
  if (artist && title) return `我要听${artist}的《${title}》`
  if (artist) return `推荐几首${artist}歌曲`
  return null
}

function correctionClarificationContent(correction: MusicEntityConstraint): string {
  const artist = correction.artistQuery?.trim()
  const title = correction.seedTitle?.trim()
  if (artist && title) return `我按${artist}的《${title}》找了一轮，没拿到能确认的版本。你再补一个版本名或完整歌名。`
  if (title) return `我知道这首放错了。你把《${title}》的歌手或版本发我，我按那个重找。`
  return '我知道这首放错了。你把歌手和歌名发我一下，我按那个重找。'
}

function hasSpecificCorrectionTarget(correction: MusicEntityConstraint | undefined): boolean {
  return Boolean(correction?.artistQuery || correction?.seedTitle || correction?.verifiedArtistName || correction?.excludedArtists?.length)
}

function rememberPendingCorrectionClarification(correction: MusicEntityConstraint, sourceText: string): void {
  setPendingMusicEntityClarification({
    artistQuery: correction.artistQuery,
    seedTitle: correction.seedTitle,
    ambiguity: correction.seedTitle && !correction.artistQuery ? 'missing_artist' : 'too_vague',
  }, sourceText)
}

async function searchCorrectedReplacement(
  correction: MusicEntityConstraint | undefined,
  currentTrack: Track,
  signal?: AbortSignal,
): Promise<Track | null> {
  if (!correction) return null
  const query = correctionSearchQuery(correction)
  if (!query) return null
  const tracks = await searchMusic({
    query,
    mode: correction.seedTitle ? 'direct-song' : 'generic',
    targetCount: 1,
    candidatePoolSize: 12,
    ignoreScene: true,
    signal,
  }).catch((error) => {
    if (signal?.aborted) throw error
    return []
  })
  return tracks.find((track) => !sameTrack(track, currentTrack)) ?? null
}

async function searchDirectedReplacement(
  intent: ChatIntent,
  currentTrack: Track,
  text: string,
  signal?: AbortSignal,
): Promise<Track | null> {
  if (!hasReplacementDirection(text, intent)) return null
  const query = buildReplacementQuery(text)
  if (!query) return null
  const tracks = await searchMusic({
    query,
    mode: 'generic',
    targetCount: 1,
    candidatePoolSize: 64,
    ignoreScene: true,
    intentOverride: replacementIntentOverride(intent),
    signal,
  }).catch((error) => {
    if (signal?.aborted) throw error
    console.warn('[chat] directed replacement search failed', error)
    return []
  })
  return tracks.find((track) => !sameTrack(track, currentTrack)) ?? null
}

async function searchGenericReplacement(
  currentTrack: Track,
  signal?: AbortSignal,
): Promise<Track | null> {
  const tracks = await searchMusic({
    query: '推荐一首适合我、并且和当前不同的歌',
    mode: 'generic',
    targetCount: 1,
    candidatePoolSize: 32,
    ignoreScene: true,
    intentOverride: {
      wantsMusic: true,
      familiarity: 'balanced',
      targetCount: 1,
      clearArtistQuery: true,
      clearSeedTitle: true,
    },
    signal,
  }).catch((error) => {
    if (signal?.aborted) throw error
    console.warn('[chat] generic replacement search failed', error)
    return []
  })
  return tracks.find((track) => !sameTrack(track, currentTrack)) ?? null
}

export const trackFeedbackTestHelpers = {
  explicitFeedbackNextOptions: EXPLICIT_FEEDBACK_NEXT_OPTIONS,
  wantsTrackChange,
  buildReplacementQuery,
  shouldRecordExplicitMiss,
}

interface CurrentTrackFeedbackDependencies {
  recordFeedback: typeof recordFeedback
  recordSkippedFeedback?: typeof recordSkippedFeedback
  ensureFavorite: typeof ensureFavorite
  rememberMusicCorrection: typeof rememberMusicCorrection
  searchCorrectedReplacement: typeof searchCorrectedReplacement
  searchDirectedReplacement: typeof searchDirectedReplacement
  searchGenericReplacement: typeof searchGenericReplacement
  playNext: typeof playNext
}

const currentTrackFeedbackDependencies: CurrentTrackFeedbackDependencies = {
  recordFeedback,
  recordSkippedFeedback,
  ensureFavorite,
  rememberMusicCorrection,
  searchCorrectedReplacement,
  searchDirectedReplacement,
  searchGenericReplacement,
  playNext,
}

export async function handleCurrentTrackFeedback(
  intent: ChatIntent,
  currentTrack: Track,
  text: string,
  signal?: AbortSignal,
  dependencies: CurrentTrackFeedbackDependencies = currentTrackFeedbackDependencies,
): Promise<CurrentTrackFeedbackResult> {
  if (intent.feedbackAction === 'more_like_this') {
    await dependencies.recordFeedback(currentTrack, 'more_like_this', text)
    return { handled: false }
  }

  if (intent.feedbackAction === 'favorite') {
    await dependencies.recordFeedback(currentTrack, 'more_like_this', text)
    const result = await dependencies.ensureFavorite(currentTrack)
    return {
      handled: true,
      tracks: [],
      content: result.changed
        ? `我记住了，${trackLabel(currentTrack)}会留在你的喜欢里。`
        : `我记住了，${trackLabel(currentTrack)}本来就在你的喜欢里，这次我会再把它当成一条偏好。`,
    }
  }

  const explicitMiss = shouldRecordExplicitMiss(text)
  if (explicitMiss) {
    await dependencies.recordFeedback(currentTrack, 'not_right', text)
  } else {
    const recordSkip = dependencies.recordSkippedFeedback ?? recordSkippedFeedback
    await recordSkip(currentTrack, text)
  }
  const correction = explicitMiss
    ? dependencies.rememberMusicCorrection({
      text,
      currentTrack,
      fallbackTitle: currentTrack.title,
    })
    : undefined
  if (wantsTrackChange(text, intent)) {
    const correctedTrack = await dependencies.searchCorrectedReplacement(correction, currentTrack, signal)
    if (correctedTrack && !sameTrack(correctedTrack, currentTrack)) {
      return {
        handled: true,
        tracks: [correctedTrack],
        content: `这次按你纠正的来，换成${trackLabel(correctedTrack)}。`,
      }
    }
    const hasSpecificCorrection = hasSpecificCorrectionTarget(correction)
    const directedTrack = hasSpecificCorrection ? null : await dependencies.searchDirectedReplacement(intent, currentTrack, text, signal)
    if (directedTrack && !sameTrack(directedTrack, currentTrack)) {
      return {
        handled: true,
        tracks: [directedTrack],
        content: explicitMiss
          ? `懂了，${trackLabel(currentTrack)}这个方向我先收一收。换一首更贴近你刚说的：${trackLabel(directedTrack)}。`
          : `好，换一首更贴近你刚说的：${trackLabel(directedTrack)}。`,
      }
    }
    if (correction && hasSpecificCorrection) {
      rememberPendingCorrectionClarification(correction, text)
      return {
        handled: true,
        tracks: [],
        content: correctionClarificationContent(correction),
      }
    }
    let genericSearchAttempted = false
    if (wantsFreshReplacementSearch(text)) {
      genericSearchAttempted = true
      const genericTrack = await dependencies.searchGenericReplacement(currentTrack, signal)
      if (genericTrack && !sameTrack(genericTrack, currentTrack)) {
        return {
          handled: true,
          tracks: [genericTrack],
          content: explicitMiss
            ? `懂了，${trackLabel(currentTrack)}先放一边。换成${trackLabel(genericTrack)}。`
            : `好，换成${trackLabel(genericTrack)}。`,
        }
      }
    }
    const state = await dependencies.playNext(EXPLICIT_FEEDBACK_NEXT_OPTIONS)
    if (state.current && !sameTrack(state.current, currentTrack)) {
      return {
        handled: true,
        tracks: [state.current],
        hints: { playbackAlreadyApplied: true },
        content: explicitMiss
          ? `懂了，${trackLabel(currentTrack)}这个方向我先收一收。现在换成${trackLabel(state.current)}。`
          : `好，现在换成${trackLabel(state.current)}。`,
      }
    }
    const genericTrack = genericSearchAttempted ? null : await dependencies.searchGenericReplacement(currentTrack, signal)
    if (genericTrack && !sameTrack(genericTrack, currentTrack)) {
      return {
        handled: true,
        tracks: [genericTrack],
        content: explicitMiss
          ? `懂了，${trackLabel(currentTrack)}先放一边。换成${trackLabel(genericTrack)}。`
          : `好，换成${trackLabel(genericTrack)}。`,
      }
    }
    if (intent.wantsMusic) {
      return { handled: false }
    }
    return {
      handled: true,
      tracks: [],
      content: explicitMiss
        ? `懂了，${trackLabel(currentTrack)}这个方向我先收一收。我找了一轮也没拿到可播放版本，你换个歌手、语种或感觉，我接着找。`
        : '我找了一轮也没拿到可播放版本，你换个歌手、语种或感觉，我接着找。',
    }
  }

  return {
    handled: true,
    tracks: [],
    content: !explicitMiss
      ? `好，${trackLabel(currentTrack)}我先跳过。`
      : correction?.artistQuery
      ? `懂了，这次错在版本上。我会先按${correction.artistQuery}的${correction.seedTitle ? `《${correction.seedTitle}》` : '这个方向'}找，刚才那版先排除。`
      : `懂了，${trackLabel(currentTrack)}这个方向我先收一收。`,
  }
}
