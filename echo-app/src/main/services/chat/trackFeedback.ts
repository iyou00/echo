import type { Track } from '../../../types/ipc'
import { rememberMusicCorrection } from '../../skills/music/correctionMemory'
import { searchMusic } from '../../skills/music/search'
import type { MusicEntityConstraint } from '../../skills/music/verifier'
import type { IntentOverride } from '../recommendation'
import { recordFeedback } from '../feedback'
import { toggleFavorite } from '../favorites'
import { next as playNext } from '../playback'
import type { ChatIntent } from './intent'
import { setPendingMusicEntityClarification } from './pendingIntents'

export type CurrentTrackFeedbackResult =
  | { handled: false }
  | { handled: true; content: string; tracks: Track[] }

export function trackLabel(track: Track): string {
  return `${track.artist}的《${track.title}》`
}

function wantsTrackChange(text: string, intent: ChatIntent): boolean {
  return intent.feedbackAction === 'skip' || /换一首|换首|下一首|跳过|切歌|别放|不听/.test(text)
}

const REPLACEMENT_DIRECTION_PATTERN = /激情|激昂|高昂|亢奋|振奋|热血|澎湃|炸|爆|带感|节奏|鼓点|动感|有劲|提神|清醒|燃|快一点|快点|快歌|舒缓|安静|放松|慢一点|慢点|粤语|英文|英语|欧美|韩语|日语|华语|民谣|摇滚|说唱|电子|r&b|rnb|爵士/i
const FEEDBACK_WORD_PATTERN = /这首歌|这首|这歌|刚才|当前|现在这首|不好听|没感觉|不喜欢|不对|不太对|别放|不听|腻了|太吵|太慢|太快|错误|错歌|放错|播错/gi
const CHANGE_WORD_PATTERN = /换一首|换首|下一首|跳过|切歌|换个|换一个/gi
const ALLOWED_REPLACEMENT_LANGUAGES = new Set(['华语', '粤语', '英语', '韩语', '日语'])

function hasReplacementDirection(text: string, intent: ChatIntent): boolean {
  const recommendation = intent.recommendationIntent
  if (recommendation.artistQuery || recommendation.seedTitle || recommendation.language || recommendation.energy || recommendation.tempo) return true
  if (recommendation.scenes.length > 0) return true
  if (recommendation.moods.some((mood) => mood !== '陪伴')) return true
  return REPLACEMENT_DIRECTION_PATTERN.test(text)
}

function buildReplacementQuery(text: string): string {
  const cleaned = text
    .replace(FEEDBACK_WORD_PATTERN, '')
    .replace(CHANGE_WORD_PATTERN, '')
    .replace(/[，。！？?！,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned && /太慢|没劲|太软|太平/.test(text)) return '推荐一首节奏更快更有劲的歌'
  if (!cleaned && /太吵|太炸|太快|太闹/.test(text)) return '推荐一首舒缓一点的歌'
  return cleaned ? `推荐一首${cleaned}的歌` : ''
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
  const leftId = String(left.neteaseId ?? left.id ?? '').trim()
  const rightId = String(right.neteaseId ?? right.id ?? '').trim()
  if (leftId && rightId) return leftId === rightId
  return left.title.trim().toLowerCase() === right.title.trim().toLowerCase()
    && left.artist.trim().toLowerCase() === right.artist.trim().toLowerCase()
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
    candidatePoolSize: 32,
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

export async function handleCurrentTrackFeedback(
  intent: ChatIntent,
  currentTrack: Track,
  text: string,
  signal?: AbortSignal,
): Promise<CurrentTrackFeedbackResult> {
  if (intent.feedbackAction === 'more_like_this') {
    await recordFeedback(currentTrack, 'more_like_this', text)
    return { handled: false }
  }

  if (intent.feedbackAction === 'favorite') {
    const result = await toggleFavorite(currentTrack)
    return {
      handled: true,
      tracks: [],
      content: result.favorited
        ? `我记住了，${trackLabel(currentTrack)}会留在你的喜欢里。`
        : `我把${trackLabel(currentTrack)}从喜欢里拿掉了。`,
    }
  }

  await recordFeedback(currentTrack, 'not_right', text)
  const correction = rememberMusicCorrection({
    text,
    currentTrack,
    fallbackTitle: currentTrack.title,
  })
  if (wantsTrackChange(text, intent)) {
    const correctedTrack = await searchCorrectedReplacement(correction, currentTrack, signal)
    if (correctedTrack) {
      return {
        handled: true,
        tracks: [correctedTrack],
        content: `这次按你纠正的来，换成${trackLabel(correctedTrack)}。`,
      }
    }
    const directedTrack = correction ? null : await searchDirectedReplacement(intent, currentTrack, text, signal)
    if (directedTrack) {
      return {
        handled: true,
        tracks: [directedTrack],
        content: `懂了，${trackLabel(currentTrack)}这个方向我先收一收。换一首更贴近你刚说的：${trackLabel(directedTrack)}。`,
      }
    }
    if (correction) {
      rememberPendingCorrectionClarification(correction, text)
      return {
        handled: true,
        tracks: [],
        content: correctionClarificationContent(correction),
      }
    }
    const state = await playNext()
    if (state.current) {
      return {
        handled: true,
        tracks: [state.current],
        content: `懂了，${trackLabel(currentTrack)}这个方向我先收一收。现在换成${trackLabel(state.current)}。`,
      }
    }
    return {
      handled: true,
      tracks: [],
      content: `懂了，${trackLabel(currentTrack)}这个方向我先收一收。队列里暂时没有下一首。`,
    }
  }

  return {
    handled: true,
    tracks: [],
    content: correction?.artistQuery
      ? `懂了，这次错在版本上。我会先按${correction.artistQuery}的${correction.seedTitle ? `《${correction.seedTitle}》` : '这个方向'}找，刚才那版先排除。`
      : `懂了，${trackLabel(currentTrack)}这个方向我先收一收。`,
  }
}
