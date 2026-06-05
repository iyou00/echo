import type { Track } from '../../../types/ipc'
import type { MusicEntityAmbiguity } from '../../skills/music/entityResolver'
import type { MusicSearchFailureReason } from '../../skills/music/search'

const DIRECT_SONG_PENDING_TTL_MS = 5 * 60 * 1000

export interface DirectSongReference {
  seedTitle: string
  artistQuery?: string
}

interface PendingDirectSongClarification extends DirectSongReference {
  sourceText: string
  askedAt: number
}

interface PendingDirectSongChoice {
  directSong: DirectSongReference
  candidates: Track[]
  sourceText: string
  askedAt: number
}

interface PendingMusicEntityClarification {
  artistQuery?: string
  seedTitle?: string
  ambiguity: MusicEntityAmbiguity
  sourceText: string
  askedAt: number
}

interface PendingTrackPreferenceClarification {
  seedTitle: string
  sourceText: string
  askedAt: number
}

export interface PendingDirectSongReply {
  query?: string
  response?: string
}

export interface PendingTrackPreferenceReply {
  artistQuery?: string
  seedTitle: string
  response?: string
}

export interface PendingDirectSongChoiceReply {
  track?: Track
  response?: string
}

let pendingDirectSongClarification: PendingDirectSongClarification | null = null
let pendingDirectSongChoice: PendingDirectSongChoice | null = null
let pendingMusicEntityClarification: PendingMusicEntityClarification | null = null
let pendingTrackPreferenceClarification: PendingTrackPreferenceClarification | null = null

export function directSongClarificationContent(directSong: DirectSongReference): string {
  const title = `《${directSong.seedTitle}》`
  if (directSong.artistQuery) {
    return `我没找准${directSong.artistQuery}的${title}。你确认下歌名是不是这个全称？也可以直接发我“歌手 + 歌名”，我再放。`
  }
  return `我没找准${title}。这是完整歌名吗？有歌手名的话也发我一下，我再放。`
}

export function directSongChoiceContent(candidates: Track[]): string {
  const options = candidates.slice(0, 3).map((track, index) => `${index + 1}. ${track.artist}《${track.title}》`)
  return `我找到了几个版本，你要哪一个？\n${options.join('\n')}\n直接回“第几个”或歌手名就行。`
}

export function musicEntityClarificationContent(input: {
  artistQuery?: string
  seedTitle?: string
  ambiguity: MusicEntityAmbiguity
  failureReason?: MusicSearchFailureReason
  verificationStatus?: string
}): string {
  const artist = input.artistQuery ? `${input.artistQuery}` : ''
  const title = input.seedTitle ? `《${input.seedTitle}》` : ''
  if (input.failureReason === 'candidate_mismatch' && (artist || title)) {
    return `我搜到了一些接近的结果，但都对不上${artist}${title}，所以先没放。你可以补一个版本名，或者直接说“找${artist || '这个歌手'}其他歌”。`
  }
  if (input.failureReason === 'not_playable' && (artist || title)) {
    return `我确认到${artist}${title}，但网易云这边暂时没有可播放链接。你可以说“找${artist || '这个歌手'}其他歌”，我换一首可播的。`
  }
  if (input.failureReason === 'track_not_found' && (artist || title)) {
    return `我没在网易云搜到${artist}${title}的可用结果。你可以补充版本、专辑，或者说“找${artist || '这个歌手'}其他歌”。`
  }
  if (input.failureReason === 'artist_not_found' && artist) {
    return `我没在网易云校准到“${artist}”。你可以确认一下拼写，或者直接发“歌手 + 歌名”。`
  }
  if (input.ambiguity === 'artist_or_title' && input.seedTitle) {
    return `我先确认一下：你说的是歌手“${input.seedTitle}”，还是歌名《${input.seedTitle}》？`
  }
  if (input.seedTitle && !input.artistQuery) {
    return `我没找准《${input.seedTitle}》。你把歌手名也发我一下，我再继续找。`
  }
  if (input.artistQuery) {
    return `我没在网易云里校准到“${input.artistQuery}”。你是想听这个歌手的歌吗？有具体歌名也可以直接发我。`
  }
  return '这句我没抓准你要找的歌。你可以直接发“歌手 + 歌名”。'
}

export function setPendingDirectSongClarification(directSong: DirectSongReference, sourceText: string): void {
  pendingDirectSongChoice = null
  pendingMusicEntityClarification = null
  pendingDirectSongClarification = {
    seedTitle: directSong.seedTitle,
    artistQuery: directSong.artistQuery,
    sourceText,
    askedAt: Date.now(),
  }
}

export function setPendingDirectSongChoice(directSong: DirectSongReference, candidates: Track[], sourceText: string): void {
  pendingDirectSongClarification = null
  pendingMusicEntityClarification = null
  pendingDirectSongChoice = {
    directSong,
    candidates: candidates.slice(0, 5),
    sourceText,
    askedAt: Date.now(),
  }
}

export function setPendingMusicEntityClarification(
  entity: { artistQuery?: string; seedTitle?: string; ambiguity: MusicEntityAmbiguity },
  sourceText: string,
): void {
  pendingDirectSongClarification = null
  pendingDirectSongChoice = null
  pendingTrackPreferenceClarification = null
  pendingMusicEntityClarification = {
    artistQuery: entity.artistQuery,
    seedTitle: entity.seedTitle,
    ambiguity: entity.ambiguity,
    sourceText,
    askedAt: Date.now(),
  }
}

export function setPendingTrackPreferenceClarification(seedTitle: string, sourceText: string): void {
  pendingDirectSongClarification = null
  pendingDirectSongChoice = null
  pendingMusicEntityClarification = null
  pendingTrackPreferenceClarification = {
    seedTitle,
    sourceText,
    askedAt: Date.now(),
  }
}

export function clearPendingDirectSongState(): void {
  pendingDirectSongClarification = null
  pendingDirectSongChoice = null
  pendingMusicEntityClarification = null
  pendingTrackPreferenceClarification = null
}

function clearPendingDirectSongClarification(): void {
  pendingDirectSongClarification = null
}

function clearPendingDirectSongChoice(): void {
  pendingDirectSongChoice = null
}

function pendingDirectSongIsExpired(pending: { askedAt: number }): boolean {
  return Date.now() - pending.askedAt > DIRECT_SONG_PENDING_TTL_MS
}

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》"'“”·.,，。!！?？()（）:：\-_]/g, '')
}

function cleanArtistReply(text: string): string {
  return text
    .trim()
    .replace(/^歌手(应该)?是/, '')
    .replace(/^(应该是|可能是|大概是|就是|是)/, '')
    .replace(/唱的$/, '')
    .replace(/的$/, '')
    .trim()
}

function cleanEntityText(text: string): string {
  return text
    .trim()
    .replace(/[，。！？?！,.]+$/g, '')
    .trim()
}

function cleanEntityArtist(text: string): string {
  return cleanEntityText(text)
    .replace(/^(?:我)?(?:想听|想要听|要听|我要听|我想听|播放|放|放首|放一首|点播|推荐|推)\s*/, '')
    .replace(/^(?:歌手|艺人|乐队)?(?:是|应该是|可能是|大概是)?/, '')
    .replace(/的$/, '')
    .trim()
}

function parseArtistTitleReply(text: string): { artist?: string; title?: string } | null {
  const compact = cleanEntityText(text)
  if (!compact) return null
  const quoted = compact.match(/《([^》]{1,60})》/)
  if (quoted?.[1]) {
    const prefix = cleanEntityArtist(compact.slice(0, quoted.index))
    return {
      artist: prefix || undefined,
      title: cleanEntityText(quoted[1]),
    }
  }

  const labelled = compact.match(/歌手(?:应该)?是\s*([^，。！？?！,]{1,40}).{0,8}(?:歌名|歌曲|曲名)(?:应该)?是?\s*([^，。！？?！,]{1,60})/i)
  if (labelled?.[1] && labelled[2]) {
    return {
      artist: cleanEntityArtist(labelled[1]),
      title: cleanEntityText(labelled[2]),
    }
  }

  const pair = compact.match(/^([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40})\s*的\s*([^，。！？?！,]{1,60})$/i)
  if (pair?.[1] && pair[2]) {
    return {
      artist: cleanEntityArtist(pair[1]),
      title: cleanEntityText(pair[2]),
    }
  }

  return null
}

function queryFromArtistTitle(artist?: string, title?: string): string | null {
  const cleanArtist = cleanEntityArtist(artist ?? '')
  const cleanTitle = cleanEntityText(title ?? '')
  if (cleanArtist && cleanTitle) return `我要听${cleanArtist}的《${cleanTitle}》`
  if (cleanArtist) return `推荐几首${cleanArtist}歌曲`
  if (cleanTitle) return `我要听《${cleanTitle}》`
  return null
}

function isShortArtistReply(text: string): boolean {
  return /^[A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}$/.test(text) && !/算了|不用|取消|不是|没有|完整|歌名|这首|这个|这种|感觉|继续|类似|换|首|歌|曲|听|来|放|推荐/.test(text)
}

function isNewMusicRequest(text: string): boolean {
  return /想听|想要听|要听|我要听|我想听|播放|放首|放一首|来一首|推荐|推首|歌|曲|《|》/i.test(text)
}

function isExplicitPendingEntityReply(text: string): boolean {
  return /^(歌手|艺人|乐队|应该是|可能是|大概是|就是|是|对|嗯|没错)/.test(text.trim())
    || Boolean(parseArtistTitleReply(text))
}

function isLikelyPendingInterruption(text: string): boolean {
  const compact = text.trim()
  if (!compact || isExplicitPendingEntityReply(compact)) return false
  return /天气|气温|温度|下雨|冷不冷|热不热|冷吗|热吗|几度|多少度|我有点|我现在|今天|心情|难受|开心|烦|累|困|睡不着|想聊|怎么|为什么|你能|你会|你是|你是谁|什么|代码|翻译|政治|数学|商业|生意/.test(compact)
}

function isCancelReply(text: string): boolean {
  return /算了|不用|取消|先不听|别找|不找了/.test(text)
}

function parseChoiceIndex(text: string): number | null {
  const match = text.trim().match(/^第?\s*([1-5一二两三四五])\s*(?:个|首|项|号)?$/)
  if (!match) return null
  const raw = match[1]
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }
  return raw ? Number(raw) || map[raw] || null : null
}

export function resolvePendingDirectSongReply(text: string): PendingDirectSongReply | null {
  const pending = pendingDirectSongClarification
  if (!pending) return null
  if (pendingDirectSongIsExpired(pending)) {
    clearPendingDirectSongClarification()
    return null
  }

  if (isCancelReply(text)) {
    clearPendingDirectSongClarification()
    return { response: '行，那这首先放一放。你想听别的再直接说。' }
  }
  if (!isExplicitPendingEntityReply(text) && (isNewMusicRequest(text) || isLikelyPendingInterruption(text))) {
    clearPendingDirectSongClarification()
    return null
  }

  const compact = text.trim()
  if (/^(是|对|嗯|没错|就是|完整歌名|歌名没错)$/.test(compact)) {
    if (pending.artistQuery) {
      clearPendingDirectSongClarification()
      return { query: `我要听${pending.artistQuery}的《${pending.seedTitle}》` }
    }
    return { response: `歌名我先记着：《${pending.seedTitle}》。你再发我歌手名，我就继续找。` }
  }

  const artist = cleanArtistReply(compact)
  if (isShortArtistReply(artist)) {
    clearPendingDirectSongClarification()
    return { query: `我要听${artist}的《${pending.seedTitle}》` }
  }

  return null
}

export function resolvePendingMusicEntityReply(text: string): PendingDirectSongReply | null {
  const pending = pendingMusicEntityClarification
  if (!pending) return null
  if (pendingDirectSongIsExpired(pending)) {
    pendingMusicEntityClarification = null
    return null
  }
  if (isCancelReply(text)) {
    pendingMusicEntityClarification = null
    return { response: '行，那这条先放一放。你想听别的再直接说。' }
  }
  if (!isExplicitPendingEntityReply(text) && (isNewMusicRequest(text) || isLikelyPendingInterruption(text))) {
    pendingMusicEntityClarification = null
    return null
  }

  const compact = text.trim()
  const artistTitleReply = parseArtistTitleReply(compact)
  if (artistTitleReply) {
    const query = queryFromArtistTitle(
      artistTitleReply.artist ?? pending.artistQuery,
      artistTitleReply.title ?? pending.seedTitle,
    )
    if (query) {
      pendingMusicEntityClarification = null
      return { query }
    }
  }

  if (pending.ambiguity === 'artist_or_title' && pending.seedTitle) {
    if (/歌手|艺人|乐队|唱的/.test(compact)) {
      pendingMusicEntityClarification = null
      return { query: `推荐几首${pending.seedTitle}歌曲` }
    }
    if (/歌名|这首|那首|歌曲|曲子|单曲/.test(compact)) {
      pendingMusicEntityClarification = null
      return { query: `我要听《${pending.seedTitle}》` }
    }
  }

  const artist = cleanArtistReply(compact)
  if (pending.seedTitle && isShortArtistReply(artist)) {
    pendingMusicEntityClarification = null
    return { query: `我要听${artist}的《${pending.seedTitle}》` }
  }

  if (pending.artistQuery && /^(是|对|嗯|没错|就是|歌手|艺人)$/.test(compact)) {
    pendingMusicEntityClarification = null
    return { query: `推荐几首${pending.artistQuery}歌曲` }
  }

  return null
}

export function resolvePendingTrackPreferenceReply(text: string): PendingTrackPreferenceReply | null {
  const pending = pendingTrackPreferenceClarification
  if (!pending) return null
  if (pendingDirectSongIsExpired(pending)) {
    pendingTrackPreferenceClarification = null
    return null
  }
  if (isCancelReply(text)) {
    pendingTrackPreferenceClarification = null
    return { seedTitle: pending.seedTitle, response: '行，这个偏好我先不记。' }
  }
  if (!isExplicitPendingEntityReply(text) && (isNewMusicRequest(text) || isLikelyPendingInterruption(text))) {
    pendingTrackPreferenceClarification = null
    return null
  }

  const artistTitleReply = parseArtistTitleReply(text)
  if (artistTitleReply?.artist) {
    pendingTrackPreferenceClarification = null
    return {
      artistQuery: artistTitleReply.artist,
      seedTitle: artistTitleReply.title ?? pending.seedTitle,
    }
  }

  const artist = cleanArtistReply(text.trim())
  if (isShortArtistReply(artist)) {
    pendingTrackPreferenceClarification = null
    return {
      artistQuery: artist,
      seedTitle: pending.seedTitle,
    }
  }

  return { seedTitle: pending.seedTitle, response: `我想确认一下，《${pending.seedTitle}》是哪位歌手的？你直接回歌手名就行。` }
}

export function resolvePendingDirectSongChoiceReply(text: string): PendingDirectSongChoiceReply | null {
  const pending = pendingDirectSongChoice
  if (!pending) return null
  if (pendingDirectSongIsExpired(pending)) {
    clearPendingDirectSongChoice()
    return null
  }
  if (isCancelReply(text)) {
    clearPendingDirectSongChoice()
    return { response: '行，这几个版本我先放一边。你想听别的再直接说。' }
  }
  if (isNewMusicRequest(text)) {
    clearPendingDirectSongChoice()
    return null
  }
  if (isLikelyPendingInterruption(text)) {
    clearPendingDirectSongChoice()
    return null
  }

  const index = parseChoiceIndex(text)
  if (index !== null) {
    const track = pending.candidates[index - 1]
    if (track) {
      clearPendingDirectSongChoice()
      return { track }
    }
    return { response: `我这里有 ${Math.min(3, pending.candidates.length)} 个选项，你回 1 到 ${Math.min(3, pending.candidates.length)} 就行。` }
  }

  const compact = compactText(text)
  if (!compact) return null
  const matches = pending.candidates.filter((track) => {
    const artist = compactText(track.artist)
    const title = compactText(track.title)
    return (artist.length >= 2 && compact.includes(artist)) || (title.length >= 2 && compact.includes(title))
  })
  if (matches.length === 1) {
    clearPendingDirectSongChoice()
    return { track: matches[0] }
  }
  if (matches.length > 1) return { response: directSongChoiceContent(matches) }

  return { response: `我没对应上你选的版本。你可以回 1 到 ${Math.min(3, pending.candidates.length)}，或者直接说歌手名。` }
}
