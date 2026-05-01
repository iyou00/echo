import type { TasteProfile, Track } from '../../types/ipc'
import { getDb } from '../db'
import { getFeedbackSignalCount, listTrackFeedback, type TrackFeedback } from '../db/feedback'
import { getAllImportedTracks } from '../db/playlists'
import { listSemantics, semanticTrackKey } from '../db/semantics'
import { loadProfileTrackEvents, type ProfileTrackEvent } from '../db/tracks'
import {
  addTasteQuestion,
  answerTasteQuestion as saveTasteQuestionAnswer,
  getPendingQuestions,
  getTasteProfile,
  saveTasteProfile,
} from '../db/taste'
import { getSettings } from '../db/settings'
import { getYinyiRange } from '../db/yinyi'
import { completeChat, LlmError, type LlmMessage } from '../llm/client'
import { readRootFile } from '../utils/paths'
import { inferTrackSemanticFallback } from './semantics'

interface ArtistSeed {
  genre?: string[]
  mood?: string[]
  signature_vibe?: string
  echo_should_ask?: boolean
}

interface PortraitResponse {
  portrait?: string
  summary?: string
  suggested_questions?: Array<{ kind?: string; content?: string; context?: Record<string, unknown> }>
}

export class PortraitRegenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortraitRegenerationError'
  }
}

interface RegeneratePortraitOptions {
  refreshStructured?: boolean
  fallbackOnError?: boolean
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))))
}

function readArtistSeed(): Record<string, ArtistSeed> {
  try {
    const parsed = JSON.parse(readRootFile('samples/artist-genre-seed.json')) as { artists?: Record<string, ArtistSeed> }
    return parsed.artists ?? {}
  } catch {
    return {}
  }
}

function countBy<T extends string>(items: T[]): Map<T, number> {
  const counts = new Map<T, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

function topEntries(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit)
}

function eraForYear(year?: number): string | null {
  if (!year) return null
  if (year >= 2020) return '20s'
  if (year >= 2010) return '10s'
  if (year >= 2000) return '00s'
  if (year >= 1990) return '90s'
  if (year >= 1980) return '80s'
  if (year >= 1970) return '70s'
  return null
}

function trackKey(track: Track): string {
  return semanticTrackKey(track)
}

function addWeighted(counts: Map<string, number>, key: string, value: number): void {
  if (!key) return
  counts.set(key, (counts.get(key) ?? 0) + value)
}

function normalizedGenre(genre: string, language?: string): string {
  if (genre === '流行') {
    if (language === '粤语') return '粤语流行'
    if (language === '英语') return '欧美流行'
    if (language === '韩语') return 'K-pop'
    if (language === '日语') return '日语流行'
    return '华语流行'
  }
  if (/r&b/i.test(genre)) return 'Pop / R&B'
  return genre
}

function mostFrequent(items: string[]): string | null {
  const counts = countBy(items.filter(Boolean))
  return topEntries(counts, 1)[0]?.[0] ?? null
}

function eventMoods(events: ProfileTrackEvent[]): string[] {
  return events.flatMap((event) => event.track.profileEvidence?.moods ?? [])
}

function eventScenes(events: ProfileTrackEvent[]): string[] {
  return events.flatMap((event) => event.track.profileEvidence?.scenes ?? [])
}

function feedbackReason(feedback: TrackFeedback | undefined, events: ProfileTrackEvent[], semanticMood?: string): string {
  if (feedback?.favoriteCount) return '你主动收藏过,Echo 会把它留在代表曲里。'
  if ((feedback?.loopCount ?? 0) >= 2) return '你反复循环过它,像一个稳的回头点。'
  if ((feedback?.playCount ?? 0) >= 3) return `你完整听过 ${feedback?.playCount} 次,耳朵很少抗拒它。`
  const scene = mostFrequent(eventScenes(events))
  if (scene) return `你在${scene}时,它常被 Echo 接上。`
  const mood = mostFrequent(eventMoods(events)) ?? semanticMood
  if (mood) return `它在你的「${mood}」安全区里很稳。`
  return '它是导入歌单里的稳定坐标。'
}

function genreNote(name: string, trend: 'up' | 'down' | 'steady', artists: string[]): string {
  const artist = artists[0]
  if (!artist) return trend === 'up' ? '最近权重在上来。' : '这是你歌单里的稳定区域。'
  if (trend === 'up') return `最近上来,${artist} 推动得比较明显。`
  if (trend === 'down') return `${artist} 还在,但最近权重收了一点。`
  if (/K-pop/i.test(name)) return `白天电池感更强,${artist} 是主要线索。`
  return `你的稳定区域,${artist} 经常出现。`
}

function artistNote(artist: string, stats: { imported: number; played: number; skipped: number; looped: number; favorited: number; scenes: string[] }, seed?: ArtistSeed): string {
  if (stats.favorited > 0) return `收藏信号很强,最近更靠前。`
  if (stats.looped > 0) return `循环过 ${stats.looped} 次,属于会回头的声音。`
  if (stats.played >= 3) return `完整听过 ${stats.played} 次。`
  const scene = mostFrequent(stats.scenes)
  if (scene) return `${scene}时常被接上。`
  if (stats.skipped >= 3 && stats.played < stats.skipped) return '最近跳过偏多,Echo 会收一点。'
  return seed?.signature_vibe ?? (stats.imported > 0 ? `导入歌单里出现 ${stats.imported} 次。` : `${artist} 还需要继续观察。`)
}

function buildFallbackPortrait(topArtists: string[], topGenres: string[], signatureTracks: Track[]): string {
  const artists = topArtists.slice(0, 3).join('、') || '这些歌'
  const genres = topGenres.slice(0, 2).join('和') || '旋律性强的流行歌'
  const firstTrack = signatureTracks[0]
  const anchor = firstTrack ? `像《${firstTrack.title}》这种歌` : '那些旋律先到、情绪后到的歌'
  return `我先从歌单里认出几个坐标: ${artists}。你的安全区大概在${genres}附近,要有旋律,也要有一句能留下来的表达。${anchor}对你来说像入口,它能把白天的噪音压低一点。等你多和我聊几次,我会把这些粗线条慢慢改细。`
}

function buildProfileFromTracks(tracks: Track[]): TasteProfile {
  const artistSeed = readArtistSeed()
  const previous = getTasteProfile()
  const semanticTracks = listSemantics()
  const feedbackRows = listTrackFeedback()
  const profileEvents = loadProfileTrackEvents()
  const feedbackByKey = new Map(feedbackRows.map((item) => [item.trackKey, item]))
  const semanticByKey = new Map(semanticTracks.map((track) => [trackKey(track), track.semantic]))
  const eventsByKey = new Map<string, ProfileTrackEvent[]>()
  for (const event of profileEvents) {
    const key = trackKey(event.track)
    eventsByKey.set(key, [...(eventsByKey.get(key) ?? []), event])
  }
  const genreCounts = new Map<string, number>()
  const moodCounts = new Map<string, number>()
  const eraCounts = new Map<string, number>()
  const genreArtists = new Map<string, Map<string, number>>()
  const artistStats = new Map<string, { imported: number; played: number; skipped: number; looped: number; favorited: number; scenes: string[]; score: number }>()

  function semanticFor(track: Track) {
    return semanticByKey.get(trackKey(track)) ?? track.semantic ?? inferTrackSemanticFallback(track)
  }

  for (const track of tracks) {
    const seed = artistSeed[track.artist]
    const stats = artistStats.get(track.artist) ?? { imported: 0, played: 0, skipped: 0, looped: 0, favorited: 0, scenes: [], score: 0 }
    stats.imported += 1
    stats.score += 0.35
    artistStats.set(track.artist, stats)
    for (const genre of seed?.genre ?? ['流行']) addWeighted(genreCounts, normalizedGenre(genre), 0.35)
    for (const mood of seed?.mood ?? ['calm']) moodCounts.set(mood, (moodCounts.get(mood) ?? 0) + 1)
    const era = eraForYear(track.year)
    if (era) eraCounts.set(era, (eraCounts.get(era) ?? 0) + 1)
  }

  for (const track of semanticTracks) {
    const feedback = feedbackByKey.get(trackKey(track))
    const behaviorWeight = Math.max(0, Math.min(3, feedback?.score ?? 0))
    for (const rawGenre of track.semantic.genres) {
      const genre = normalizedGenre(rawGenre, track.semantic.language)
      addWeighted(genreCounts, genre, 2 + behaviorWeight)
      const artists = genreArtists.get(genre) ?? new Map<string, number>()
      artists.set(track.artist, (artists.get(track.artist) ?? 0) + 1 + behaviorWeight)
      genreArtists.set(genre, artists)
    }
    for (const mood of track.semantic.moods) moodCounts.set(mood, (moodCounts.get(mood) ?? 0) + 2 + behaviorWeight)
    const stats = artistStats.get(track.artist) ?? { imported: 0, played: 0, skipped: 0, looped: 0, favorited: 0, scenes: [], score: 0 }
    stats.score += 0.8 + behaviorWeight
    artistStats.set(track.artist, stats)
  }

  for (const feedback of feedbackRows) {
    const artist = feedback.track.artist
    const semantic = semanticFor(feedback.track)
    const positiveWeight = Math.max(0, Math.min(4, feedback.score))
    const stats = artistStats.get(artist) ?? { imported: 0, played: 0, skipped: 0, looped: 0, favorited: 0, scenes: [], score: 0 }
    stats.played += feedback.playCount
    stats.skipped += feedback.skipCount
    stats.looped += feedback.loopCount
    stats.favorited += feedback.favoriteCount
    stats.score += feedback.playCount * 0.9 + feedback.loopCount * 2 + feedback.favoriteCount * 2.4 - feedback.skipCount * 1.2
    artistStats.set(artist, stats)
    if (positiveWeight > 0) {
      for (const rawGenre of semantic.genres) addWeighted(genreCounts, normalizedGenre(rawGenre, semantic.language), positiveWeight * 0.8)
      for (const mood of semantic.moods) addWeighted(moodCounts, mood, positiveWeight)
    }
  }

  for (const event of profileEvents) {
    const artist = event.track.artist
    const semantic = semanticFor(event.track)
    const eventWeight = event.queueStatus === 'completed' ? 0.85 : event.queueStatus === 'skipped' ? -0.25 : 0.25
    const stats = artistStats.get(artist) ?? { imported: 0, played: 0, skipped: 0, looped: 0, favorited: 0, scenes: [], score: 0 }
    stats.score += event.queueStatus === 'completed' ? 0.55 : event.queueStatus === 'skipped' ? -0.35 : 0.15
    stats.scenes.push(...(event.track.profileEvidence?.scenes ?? []))
    artistStats.set(artist, stats)
    for (const mood of event.track.profileEvidence?.moods ?? []) moodCounts.set(mood, (moodCounts.get(mood) ?? 0) + 0.7)
    if (eventWeight > 0) {
      for (const rawGenre of semantic.genres) addWeighted(genreCounts, normalizedGenre(rawGenre, semantic.language), eventWeight * 0.55)
      for (const mood of semantic.moods) addWeighted(moodCounts, mood, eventWeight)
    }
  }

  const maxGenre = Math.max(1, ...Array.from(genreCounts.values()))
  const maxMood = Math.max(1, ...Array.from(moodCounts.values()))
  const totalEra = Math.max(1, Array.from(eraCounts.values()).reduce((sum, value) => sum + value, 0))
  const maxArtistScore = Math.max(1, ...Array.from(artistStats.values()).map((item) => item.score))
  const topArtists = Array.from(artistStats.entries()).sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([name, stats]) => ({
    name,
    affinity: clamp(Math.max(0.08, stats.score / maxArtistScore)),
    notes: artistNote(name, stats, artistSeed[name]),
  }))
  const topGenres = topEntries(genreCounts, 8).map(([name, count]) => ({
    name,
    weight: clamp(count / maxGenre),
    trend: (() => {
      const last = previous?.genres.find((genre) => genre.name === name)?.weight ?? 0
      const next = count / maxGenre
      if (next - last > 0.08) return 'up' as const
      if (last - next > 0.08) return 'down' as const
      return 'steady' as const
    })(),
    note: genreNote(
      name,
      (() => {
        const last = previous?.genres.find((genre) => genre.name === name)?.weight ?? 0
        const next = count / maxGenre
        if (next - last > 0.08) return 'up' as const
        if (last - next > 0.08) return 'down' as const
        return 'steady' as const
      })(),
      topEntries(genreArtists.get(name) ?? new Map<string, number>(), 3).map(([artist]) => artist),
    ),
  }))
  const moods = topEntries(moodCounts, 8).map(([tag, count]) => ({
    tag,
    frequency: clamp(count / maxMood),
    signature_artists: topArtists.slice(0, 3).map((artist) => artist.name),
  }))
  const candidateMap = new Map<string, Track>()
  for (const track of [...tracks, ...semanticTracks, ...feedbackRows.map((item) => item.track), ...profileEvents.map((event) => event.track)]) {
    if (track.title && track.artist && !track.title.includes('待补充')) candidateMap.set(trackKey(track), track)
  }
  const signatureTracks = Array.from(candidateMap.values())
    .map((track) => {
      const key = trackKey(track)
      const feedback = feedbackByKey.get(key)
      const events = eventsByKey.get(key) ?? []
      const semantic = semanticTracks.find((item) => trackKey(item) === key)?.semantic
      const score =
        (feedback?.score ?? 0) * 2 +
        events.length * 0.45 +
        (feedback?.favoriteCount ? 4 : 0) +
        (feedback?.loopCount ?? 0) * 1.8 +
        (semantic?.confidence ?? 0) +
        (tracks.some((item) => trackKey(item) === key) ? 0.35 : 0)
      return {
        track: {
          ...track,
          reason: feedbackReason(feedback, events, semantic?.moods[0]),
        },
        score,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)
    .map((item) => item.track)

  const topArtistNames = topArtists.map((artist) => artist.name)
  const topGenreNames = topGenres.map((genre) => genre.name)
  const profile: TasteProfile = {
    genres: topGenres,
    artists: topArtists,
    moods,
    era_preference: Object.fromEntries(Array.from(eraCounts.entries()).map(([era, count]) => [era, clamp(count / totalEra)])),
    discovery_appetite: 0.5,
    anti_patterns: ['纯实验电子', 'noise / drone', '古典纯器乐'],
    signature_tracks: signatureTracks,
    echo_portrait: previous?.echo_portrait ?? buildFallbackPortrait(topArtistNames, topGenreNames, signatureTracks),
    profile_meta: {
      ...(previous?.profile_meta ?? {}),
      structuredUpdatedAt: new Date().toISOString(),
      updatedAt: previous?.profile_meta?.updatedAt ?? new Date().toISOString(),
      signalCount: getFeedbackSignalCount(),
    },
  }

  return profile
}

function parseJsonObject<T>(text: string): T | null {
  const trimmed = text.trim()
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as T
  } catch {
    return null
  }
}

function readPortraitPrompt(): string {
  const latest = readRootFile('prompts/portrait-writer-v2.md') || readRootFile('prompts/portrait-writer.md')
  const systemStart = latest.indexOf('## System')
  const fewShotStart = latest.indexOf('\n## Few-shot')
  const userStartMatch = latest.match(/\n## User[（(]/)
  const start = systemStart >= 0 ? systemStart : 0
  const possibleEnds = [fewShotStart, userStartMatch?.index ?? -1].filter((index) => index > start)
  const end = possibleEnds.length ? Math.min(...possibleEnds) : latest.length
  return latest.slice(start, end).trim()
}

function compactLine(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function buildEchoShouldAsk(profile: TasteProfile): string {
  const seed = readArtistSeed()
  const lines = profile.artists
    .filter((artist) => seed[artist.name]?.echo_should_ask)
    .slice(0, 6)
    .map((artist) => `- ${artist.name}: ${seed[artist.name]?.signature_vibe ?? 'Echo 需要继续问清楚'}`)
  return lines.length ? lines.join('\n') : '(暂无)'
}

function buildKpopUndetermined(profile: TasteProfile): string {
  const haystack = [...profile.genres.map((genre) => genre.name), ...profile.artists.map((artist) => artist.name)].join(' ')
  if (!/k-?pop|blackpink|twice|seventeen|stray kids|newjeans|bts|exo|韩国|韩团/i.test(haystack)) return '(暂无)'
  return '用户资料里出现 K-pop / 韩团线索,但偏好的具体组合、时期、成员取向仍需要 Echo 在问题里问清楚。'
}

function buildRecentYinyiSummaries(): string {
  const entries = getYinyiRange(7)
  if (!entries.length) return '(暂无)'
  return entries.map((entry) => `- ${entry.date}: ${compactLine(entry.content, 120)}`).join('\n')
}

function buildThisWeekSignals(profile: TasteProfile): string {
  const artists = profile.artists.slice(0, 5).map((artist) => `${artist.name}(${artist.affinity})`).join('、') || '暂无'
  const genres = profile.genres.slice(0, 4).map((genre) => `${genre.name}(${genre.weight}, ${genre.trend})`).join('、') || '暂无'
  const tracks = profile.signature_tracks
    .slice(0, 5)
    .map((track) => `《${track.title}》-${track.artist}${track.year ? `(${track.year})` : ''}`)
    .join('、') || '暂无'
  return [
    `当前可用信号来自导入歌单、对话反馈、播放/跳过/循环行为和听音记录。`,
    `top artists: ${artists}`,
    `top genres: ${genres}`,
    `signature tracks: ${tracks}`,
    `anti patterns: ${profile.anti_patterns.slice(0, 6).join('、') || '暂无'}`,
  ].join('\n')
}

function buildThisMonthSignals(profile: TasteProfile): string {
  const rising = profile.genres.filter((genre) => genre.trend === 'up').map((genre) => genre.name)
  const falling = profile.genres.filter((genre) => genre.trend === 'down').map((genre) => genre.name)
  return [
    `当前版本优先用已沉淀 TasteProfile 和上一次画像做月度对照。`,
    `rising genres: ${rising.join('、') || '暂无明显上升'}`,
    `falling genres: ${falling.join('、') || '暂无明显下降'}`,
    `discovery appetite: ${profile.discovery_appetite}`,
  ].join('\n')
}

function buildPortraitUserPrompt(profile: TasteProfile): string {
  return `<current_profile>
${JSON.stringify(profile, null, 2)}
</current_profile>

<last_portrait>
${profile.echo_portrait}
</last_portrait>

<this_week_signals>
${buildThisWeekSignals(profile)}
</this_week_signals>

<this_month_signals>
${buildThisMonthSignals(profile)}
</this_month_signals>

<echo_should_ask>
${buildEchoShouldAsk(profile)}
</echo_should_ask>

<kpop_undetermined>
${buildKpopUndetermined(profile)}
</kpop_undetermined>

<recent_yinyi_summaries>
${buildRecentYinyiSummaries()}
</recent_yinyi_summaries>

请严格返回 JSON,字段只包含 portrait、summary、suggested_questions。portrait 必须通过 v2 checklist,并控制在 100-120 字。`
}

function portraitV2Issues(portrait: string): string[] {
  const compact = portrait.replace(/\s+/g, '')
  const issues: string[] = []
  if (Array.from(compact).length < 90 || Array.from(compact).length > 140) issues.push('portrait 字数需要接近 100-120 字')
  if (!/(我猜|我不太确定|我说不准|我还没看清|我有一处不确定|我没搞懂)/.test(portrait)) issues.push('缺少克制权表达')
  if (!/(比起|上次|以前|这周|上周|这个月|上个月|刚认识|最近|从.+到|变化|变|涨到|降到|多了|少了)/.test(portrait)) {
    issues.push('缺少对比或变化')
  }
  if (!/(《[^》]+》|top\s*\d|Top\s*\d|\d+\s*次|\d+%|\d+首|周[一二三四五六日天]|凌晨|晚上|下午|早上)/.test(portrait)) {
    issues.push('缺少具体歌名、数据或时间锚点')
  }
  if (!/(我没搞懂|我有一处不确定|我还没看清|改天告诉我|吗[？?]|是不是|为什么)/.test(portrait)) issues.push('缺少 Echo 想继续问的问题')
  if (/(分寸感|续航感|底色|光谱)/.test(portrait)) issues.push('出现 v2 禁用抽象词')
  return issues
}

export async function buildInitialProfile(tracks: Track[]): Promise<TasteProfile> {
  const base = buildProfileFromTracks(tracks)
  base.profile_meta = {
    ...(base.profile_meta ?? {}),
    refreshReason: 'import',
    updatedAt: new Date().toISOString(),
    structuredUpdatedAt: new Date().toISOString(),
    signalCount: getFeedbackSignalCount(),
  }
  const saved = saveTasteProfile(base, base.echo_portrait)

  for (const artist of saved.artists.slice(0, 5)) {
    const seed = readArtistSeed()[artist.name]
    if (seed?.echo_should_ask) {
      addTasteQuestion('unknown_artist', `${artist.name}我还不太熟,你怎么形容他的歌?`, { artist: artist.name })
    }
  }

  if (saved.artists.some((artist) => /blackpink|twice|seventeen|stray kids|newjeans|bts|exo|k-pop/i.test(artist.name))) {
    addTasteQuestion('kpop_detail', '你喜欢的韩国组合里,哪个是最稳的那个?', { source: 'initial_playlist' })
  }

  const regenerated = await regeneratePortrait().catch(() => saved)
  return regenerated ?? saved
}

export function refreshStructuredProfile(reason = 'manual'): TasteProfile | null {
  const next = buildStructuredProfileDraft(reason)
  return next ? saveTasteProfile(next, next.echo_portrait) : null
}

function buildStructuredProfileDraft(reason = 'manual'): TasteProfile | null {
  const tracks = getAllImportedTracks()
  const current = getTasteProfile()
  if (!current && tracks.length === 0) return null
  const next = buildProfileFromTracks(tracks)
  next.echo_portrait = current?.echo_portrait ?? next.echo_portrait
  next.profile_meta = {
    ...(next.profile_meta ?? {}),
    updatedAt: current?.profile_meta?.updatedAt ?? new Date().toISOString(),
    structuredUpdatedAt: new Date().toISOString(),
    refreshReason: reason,
    signalCount: getFeedbackSignalCount(),
  }
  return next
}

export function maybeRefreshStructuredProfile(reason = 'signal'): TasteProfile | null {
  const profile = getTasteProfile()
  if (!profile) return refreshStructuredProfile(reason)
  return profile
}

export function getProfileWithQuestions(): { profile: TasteProfile | null; questions: ReturnType<typeof getPendingQuestions> } {
  return {
    profile: getTasteProfile(),
    questions: getPendingQuestions(3),
  }
}

export async function regeneratePortrait(options: RegeneratePortraitOptions = {}): Promise<TasteProfile | null> {
  const refreshStructured = options.refreshStructured ?? true
  const profile = (refreshStructured ? buildStructuredProfileDraft('portrait') : null) ?? getTasteProfile()
  if (!profile) return null

  const prompt = readPortraitPrompt()
  const userPrompt = buildPortraitUserPrompt(profile)
  const settings = getSettings()
  try {
    const messages: LlmMessage[] = [
      { role: 'system', content: prompt },
      { role: 'user', content: userPrompt },
    ]
    const response = await completeChat(settings, messages)
    let parsed = parseJsonObject<PortraitResponse>(response)
    const issues = parsed?.portrait ? portraitV2Issues(parsed.portrait) : ['没有返回 portrait']
    if (issues.length) {
      const retryResponse = await completeChat(settings, [
        ...messages,
        { role: 'assistant', content: response },
        {
          role: 'user',
          content: `上一版没有通过 portrait-writer-v2 checklist: ${issues.join('；')}。请重写一次,继续严格返回 JSON。`,
        },
      ])
      parsed = parseJsonObject<PortraitResponse>(retryResponse) ?? parsed
    }
    if (!parsed?.portrait) throw new PortraitRegenerationError('画像文案生成失败：模型没有返回 portrait。')

    const next: TasteProfile = {
      ...profile,
      echo_portrait: parsed.portrait,
      profile_meta: {
        ...(profile.profile_meta ?? {}),
        updatedAt: new Date().toISOString(),
        structuredUpdatedAt: profile.profile_meta?.structuredUpdatedAt ?? new Date().toISOString(),
        portraitSignalCount: getFeedbackSignalCount(),
      },
    }
    saveTasteProfile(next, parsed.summary ?? parsed.portrait)
    for (const question of parsed.suggested_questions ?? []) {
      if (question.content) addTasteQuestion(question.kind ?? 'observation', question.content, question.context ?? {})
    }
    return next
  } catch (error) {
    if (options.fallbackOnError) return profile
    if (error instanceof LlmError && error.kind === 'config') {
      throw new PortraitRegenerationError('模型配置还没准备好，画像文案没有刷新。')
    }
    if (error instanceof Error) throw error
    throw new PortraitRegenerationError('画像文案刷新失败。')
  }
}

export async function applySignal(kind: string, payload: Record<string, unknown>): Promise<TasteProfile | null> {
  const profile = getTasteProfile() ?? buildProfileFromTracks(getAllImportedTracks())
  const target = String(payload.target ?? payload.artist ?? payload.genre ?? payload.vibe ?? '').trim()
  const strength = typeof payload.strength === 'number' ? clamp(payload.strength) : 0.2

  if (!target && !kind.startsWith('event_')) return saveTasteProfile(profile, profile.echo_portrait)

  if (kind === 'like_artist') {
    const existing = profile.artists.find((artist) => artist.name === target)
    if (existing) existing.affinity = clamp(existing.affinity + strength)
    else profile.artists.unshift({ name: target, affinity: clamp(0.5 + strength), notes: String(payload.note ?? '用户在对话中提到喜欢') })
  }

  if (kind === 'unlike_artist') {
    const existing = profile.artists.find((artist) => artist.name === target)
    if (existing) existing.affinity = clamp(existing.affinity - strength)
    if (!profile.anti_patterns.includes(target)) profile.anti_patterns.push(target)
  }

  if (kind === 'like_genre') {
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight + strength)
      existing.trend = 'up'
    } else {
      profile.genres.unshift({ name: target, weight: clamp(0.4 + strength), trend: 'up' })
    }
  }

  if (kind === 'unlike_genre') {
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight - strength)
      existing.trend = 'down'
    }
    if (!profile.anti_patterns.includes(target)) profile.anti_patterns.push(target)
  }

  if (kind === 'reinforce_vibe' && target) {
    profile.moods.unshift({ tag: target, frequency: clamp(0.5 + strength), signature_artists: profile.artists.slice(0, 3).map((artist) => artist.name) })
    profile.moods = profile.moods.slice(0, 10)
  }

  if (kind === 'played') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + 0.03)
        existing.notes = `最近完整听过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: 0.56, notes: '最近完整听过' })
      }
    }
  }

  if (kind === 'skipped') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) existing.affinity = clamp(existing.affinity - 0.02)
      const title = String(payload.title ?? '').trim()
      if (title) {
        const marker = `跳过:${title}`
        if (!profile.anti_patterns.includes(marker)) profile.anti_patterns.push(marker)
      }
    }
  }

  if (kind === 'looped') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + 0.05)
        existing.notes = `24 小时内循环过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: 0.62, notes: '最近循环过' })
      }
    }
  }

  if (kind === 'favorited') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + 0.08)
        existing.notes = `刚收藏过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: 0.66, notes: '刚收藏过' })
      }
    }
    const title = String(payload.title ?? '').trim()
    if (title) {
      const existingTrack = profile.signature_tracks.find((track) => track.title === title && track.artist === artist)
      if (!existingTrack) {
        profile.signature_tracks = [
          {
            title,
            artist,
            source: 'favorite',
            reason: '你主动收藏过，Echo 会把它当作更强的口味信号。',
          },
          ...profile.signature_tracks,
        ].slice(0, 10)
      }
    }
  }

  if (kind === 'event_started' || kind === 'correct_assumption') {
    getDb()
      .prepare('INSERT INTO events (user_id, kind, content, confidence, weight, started_at) VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(kind === 'event_started' ? 'context' : 'correction', target || String(payload.note ?? '用户修正了 Echo 的判断'), 0.7, 0.8)
  }

  if (kind === 'event_ended') {
    getDb()
      .prepare(
        `UPDATE events
         SET expected_end_at = CURRENT_TIMESTAMP, weight = 0.1
         WHERE user_id = 1 AND content LIKE ? AND expected_end_at IS NULL`,
      )
      .run(`%${target}%`)
  }

  profile.artists = profile.artists.sort((a, b) => b.affinity - a.affinity).slice(0, 12)
  profile.genres = profile.genres.sort((a, b) => b.weight - a.weight).slice(0, 12)
  return saveTasteProfile(profile, profile.echo_portrait)
}

export async function answerQuestion(id: number, answer: string): Promise<{ ok: boolean }> {
  saveTasteQuestionAnswer(id, answer)
  await applySignal('correct_assumption', { target: answer, strength: 0.2, note: `taste_question:${id}` })
  return { ok: true }
}
