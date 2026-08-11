import type { Track } from '../../../types/ipc'
import { similarTrackSearchQuery } from '../../skills/music/query'
import { hasExplicitSimilarityAnchor } from '../../skills/music/entityResolver'

const SESSION_CONTEXT_TTL_MS = 10 * 60 * 1000

interface ChatMusicSessionContext {
  sourceText: string
  intentKind: string
  tracks: Track[]
  artistQuery?: string
  seedTitle?: string
  affirmationAction?: 'play_first' | 'search'
  updatedAt: number
}

export type SessionMusicFollowUp =
  | { kind: 'none' }
  | { kind: 'play_track'; track: Track; content: string }
  | { kind: 'search'; query: string; excludeTracks: Track[] }

export interface ChatMusicSessionSnapshot {
  sourceText: string
  tracks: Array<{ title: string; artist: string }>
  artistQuery?: string
  seedTitle?: string
  affirmationAction?: 'play_first' | 'search'
}

let musicSessionContext: ChatMusicSessionContext | null = null

interface MentionedTrack {
  track: Track
  match: 'index' | 'title' | 'artist'
}

function isContextFresh(context: ChatMusicSessionContext | null): context is ChatMusicSessionContext {
  return Boolean(context && Date.now() - context.updatedAt <= SESSION_CONTEXT_TTL_MS)
}

function trackLabel(track: Track): string {
  return `${track.artist}的《${track.title}》`
}

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》"'“”·.,，。!！?？()（）:：\-_]/g, '')
}

function pickMentionedTrack(text: string, tracks: Track[]): MentionedTrack | null {
  const compact = compactText(text)
  if (!compact) return null
  const indexMatch = text.trim().match(/^第?\s*([1-5一二两三四五])\s*(?:个|首|项|号)?$/)
  if (indexMatch?.[1]) {
    const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }
    const index = Number(indexMatch[1]) || map[indexMatch[1]]
    const track = tracks[index - 1]
    return track ? { track, match: 'index' } : null
  }
  const matches: MentionedTrack[] = []
  for (const track of tracks) {
    const title = compactText(track.title)
    const artist = compactText(track.artist)
    if (title.length >= 2 && compact.includes(title)) {
      matches.push({ track, match: 'title' })
      continue
    }
    if (artist.length >= 2 && compact.includes(artist)) {
      matches.push({ track, match: 'artist' })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

function isBareAffirmation(text: string): boolean {
  return /^(可以|可以的|好|好的|行|行啊|好啊|来吧|嗯|对|没问题|也行)[呀啊吧的了，。!！?？]*$/.test(text.trim())
}

function isExplicitPlaySelection(text: string): boolean {
  return /^(就这个|就这首|这首|放这个|放这首|听这个|听这首|选这个|选这首|要这个|要这首)[呀啊吧的了，。!！?？]*$/.test(text.trim())
}

function wantsMore(text: string): boolean {
  return /^(再来|再给|再放|接着|继续|还有|多来|来一首|来几首|挑一首|选一首|找一首)|帮我(?:挑|选|找)一首|你(?:来|帮我)?(?:挑|选|找)一首|再来点|继续来|还有吗/.test(text.trim())
}

function wantsChange(text: string): boolean {
  return /换一首|换首|下一首|换个|换一个|别的|另外/.test(text)
}

function wantsSimilar(text: string): boolean {
  return /类似|像|这种|那种|这个方向|这个感觉|差不多|同款/.test(text)
}

function buildFollowUpSearchQuery(context: ChatMusicSessionContext, text: string): string {
  const seed = context.tracks[0]
  const base = context.artistQuery
    ? `推荐一首${context.artistQuery}的歌`
    : seed
      ? similarTrackSearchQuery(seed, text)
      : `${context.sourceText} ${text}`
  return wantsSimilar(text) && seed ? similarTrackSearchQuery(seed, text) : `${base}。${text}`
}

export function inferSessionAffirmationAction(content: string): 'play_first' | 'search' | undefined {
  if (/(?:我来|我帮你|要不要|要不|还是|可以).{0,28}(?:挑一首|选一首|找一首|来一首|推荐一首|开始放|放一首)|(?:挑一首|选一首|找一首|来一首).{0,18}(?:吗|么|嘛|可以|要不要)/.test(content)) {
    return 'search'
  }
  if (/(?:先试哪一首|选哪一首|想听哪一首|要哪一首)/.test(content)) {
    return 'play_first'
  }
  if (/(要不要|要不|想不想|还要|需要|可以).{0,24}(换|继续|再来|接一首|类似|推荐|找歌|放歌|来一首)|(换|继续|再来|接一首|类似).{0,18}(吗|么|嘛|可以|要不要)/.test(content)) {
    return /(换|继续|再来|接一首|类似|推荐|找歌|来一首)/.test(content) ? 'search' : 'play_first'
  }
  return undefined
}

export function rememberChatMusicSession(input: {
  sourceText: string
  intentKind: string
  tracks: Track[]
  artistQuery?: string
  seedTitle?: string
  affirmationAction?: 'play_first' | 'search'
}): void {
  if (input.tracks.length === 0) return
  musicSessionContext = {
    sourceText: input.sourceText,
    intentKind: input.intentKind,
    tracks: input.tracks.slice(0, 8),
    artistQuery: input.artistQuery,
    seedTitle: input.seedTitle,
    affirmationAction: input.affirmationAction,
    updatedAt: Date.now(),
  }
}

export function armChatMusicSessionAffirmation(action: 'play_first' | 'search' | undefined): void {
  if (!action || !isContextFresh(musicSessionContext)) return
  musicSessionContext = {
    ...musicSessionContext,
    affirmationAction: action,
    updatedAt: Date.now(),
  }
}

export function clearChatMusicSession(): void {
  musicSessionContext = null
}

export function getChatMusicSessionSnapshot(): ChatMusicSessionSnapshot | null {
  if (!isContextFresh(musicSessionContext)) {
    musicSessionContext = null
    return null
  }
  return {
    sourceText: musicSessionContext.sourceText,
    tracks: musicSessionContext.tracks.slice(0, 5).map((track) => ({
      title: track.title,
      artist: track.artist,
    })),
    artistQuery: musicSessionContext.artistQuery,
    seedTitle: musicSessionContext.seedTitle,
    affirmationAction: musicSessionContext.affirmationAction,
  }
}

export function resolveSessionMusicFollowUp(text: string): SessionMusicFollowUp {
  if (!isContextFresh(musicSessionContext)) {
    musicSessionContext = null
    return { kind: 'none' }
  }

  const context = musicSessionContext
  if (hasExplicitSimilarityAnchor(text)) return { kind: 'none' }
  const mentioned = pickMentionedTrack(text, context.tracks)
  const indexSelection = /^第?\s*[1-5一二两三四五]/.test(text.trim())
  const explicitSelection = isExplicitPlaySelection(text)
  const bareAffirmation = isBareAffirmation(text)
  const titleSelection = mentioned?.match === 'title' && /就|放|听|选|要|这首|那首|这个|那个/.test(text)
  const artistSelection = mentioned?.match === 'artist' && /就|这首|那首|这个|那个/.test(text)
  if (mentioned && (explicitSelection || indexSelection || mentioned.match === 'index' || titleSelection || artistSelection || (bareAffirmation && context.affirmationAction === 'play_first'))) {
    return {
      kind: 'play_track',
      track: mentioned.track,
      content: `好，就放${trackLabel(mentioned.track)}。`,
    }
  }

  if (explicitSelection) {
    const first = context.tracks[0]
    if (!first) return { kind: 'none' }
    return {
      kind: 'play_track',
      track: first,
      content: `好，就放${trackLabel(first)}。`,
    }
  }

  if (bareAffirmation) {
    if (context.affirmationAction === 'play_first') {
      const first = context.tracks[0]
      if (!first) return { kind: 'none' }
      return {
        kind: 'play_track',
        track: first,
        content: `好，就放${trackLabel(first)}。`,
      }
    }
    if (context.affirmationAction === 'search') {
      return {
        kind: 'search',
        query: buildFollowUpSearchQuery(context, text),
        excludeTracks: context.tracks,
      }
    }
    return { kind: 'none' }
  }

  if (wantsChange(text) || wantsMore(text) || wantsSimilar(text)) {
    return {
      kind: 'search',
      query: buildFollowUpSearchQuery(context, text),
      excludeTracks: context.tracks,
    }
  }

  return { kind: 'none' }
}
