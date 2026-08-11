import type { SendChatResult, Track } from '../../../types/ipc'

export const CHAT_PIPELINE_INVARIANTS = [
  {
    id: 'direct-song-plays-selected-track',
    input: '我要听王菲的《主角》',
    invariant: '音乐动作回复有可播放候选时，最终 tracks 至少包含一首，并且回复文案绑定实际卡片。',
  },
  {
    id: 'session-affirmation-needs-armed-action',
    input: '嗯',
    invariant: '裸确认语只在上一轮明确邀请继续、换歌或播放时触发音乐动作。',
  },
  {
    id: 'session-change-has-candidate-fallback',
    input: '换一首',
    invariant: '上一轮候选过滤为空时，回退原候选池，并继续避开当前正在播放的歌。',
  },
] as const

export function assertAssistantReplyInputContract(content: string, tracks: Track[]): void {
  if (typeof content !== 'string') {
    throw new Error('chat pipeline contract failed: assistant content missing')
  }
  if (!Array.isArray(tracks)) {
    throw new Error('chat pipeline contract failed: reply tracks must be an array')
  }
  for (const track of tracks) {
    if (!track.title || !track.artist) {
      throw new Error('chat pipeline contract failed: track title and artist are required')
    }
  }
}

export function containsUnboundTrackClaim(content: string): boolean {
  const concreteTitleClaim = /《[^》]{1,40}》/.test(content)
    && /(?:放|听|推荐|挑|选|这首|先从|开始|试试)/.test(content)
  const playbackCommitment = /(?:^|[，。！？；\s])(?:行|好|可以|那就|这就|我来|给你|先|就|直接|不如)?[，\s]*(?:先)?(?:放|播放|推荐|挑|选|接上|试试|听听|听一下|先听|开始听)/.test(content)
  const implicitTrackClaim = /(?:这首|这一首).{0,50}(?:先听|正好|适合|开始放|试试看)/.test(content)
  const descriptiveTrackClaim = /(?:这首|这歌|这首歌|这一首).{0,80}(?:前奏|副歌|编曲|旋律|歌词|鼓点|冲击力|感觉|气质|听听看|先听|开头)/.test(content)
  const unquotedTitleClaim = /(?:^|[，。！？；\s])[A-Za-z0-9][A-Za-z0-9'’.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’.-]*){1,8}.{0,12}(?:先听|听一下|试试|开始放|放着听)/.test(content)
  return concreteTitleClaim || playbackCommitment || implicitTrackClaim || descriptiveTrackClaim || unquotedTitleClaim
}

function compactTrackText(value: string): string {
  return value.toLowerCase().replace(/[\s《》“”"'‘’.,，。!！?？:：\-_/]/g, '')
}

function trackClaimMatches(track: Track, claim: string): boolean {
  const normalizedClaim = compactTrackText(claim)
  const normalizedTitle = compactTrackText(track.title)
  const normalizedArtist = compactTrackText(track.artist)
  return Boolean(
    normalizedClaim
    && (
      normalizedClaim === normalizedTitle
      || (normalizedTitle.length >= 3 && normalizedTitle.includes(normalizedClaim))
      || (normalizedClaim.length >= 3 && normalizedClaim.includes(normalizedTitle))
      || (normalizedArtist && normalizedClaim.includes(normalizedArtist) && normalizedClaim.includes(normalizedTitle))
    ),
  )
}

export function quotedTrackClaims(content: string): string[] {
  return Array.from(content.matchAll(/《([^》]{1,40})》/g))
    .map((match) => (match[1] ?? '').trim())
    .filter(Boolean)
}

function quotedClaimSentence(content: string, index: number, claimLength: number): string {
  const left = content.slice(0, index).search(/[^。！？；.!?;]*$/)
  const start = left >= 0 ? left : 0
  const tail = content.slice(index + claimLength)
  const right = tail.search(/[。！？；.!?;]/)
  const end = right >= 0 ? index + claimLength + right : content.length
  return content.slice(start, end)
}

function quotedClaimLooksPlayable(content: string, index: number, rawClaim: string): boolean {
  const sentence = quotedClaimSentence(content, index, rawClaim.length + 2)
  const hasPlaybackVerb = /(?:放|播放|推荐|挑|选|接上|试试|听听|听一下|先听|开头|开始|换成|来一首|找一首|可以接|先从|不合适再换)/.test(sentence)
  const hasMusicDescription = /(?:前奏|副歌|编曲|旋律|歌词|鼓点|冲击力|感觉|气质|节奏|音色|人声)/.test(sentence)
  return hasPlaybackVerb || (hasMusicDescription && /(?:这首|这歌|这一首|先听|听听)/.test(sentence))
}

export function containsUnboundQuotedTrackClaim(content: string, tracks: Track[]): boolean {
  const claims = Array.from(content.matchAll(/《([^》]{1,40})》/g))
    .map((match) => ({
      claim: (match[1] ?? '').trim(),
      index: match.index ?? 0,
    }))
    .filter((item) => item.claim && quotedClaimLooksPlayable(content, item.index, item.claim))
  if (claims.length === 0) return false
  return claims.some(({ claim }) => !tracks.some((track) => trackClaimMatches(track, claim)))
}

function unquotedLatinTrackClaims(content: string): string[] {
  const claims: string[] = []
  const beforeAction = /(?:^|[，。！？；,.!?;\s])([A-Za-z0-9][A-Za-z0-9'’.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’.-]*){1,8})(?=.{0,12}(?:先听|听一下|试试|开始放|放着听))/g
  const afterAction = /(?:先放|播放|换成|推荐|听听|听一下)\s*([A-Za-z0-9][A-Za-z0-9'’.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’.-]*){0,8})/g
  for (const pattern of [beforeAction, afterAction]) {
    for (const match of content.matchAll(pattern)) {
      const claim = (match[1] ?? '').trim()
      if (claim) claims.push(claim)
    }
  }
  return Array.from(new Set(claims))
}

export function containsUnboundUnquotedTrackClaim(content: string, tracks: Track[]): boolean {
  const claims = unquotedLatinTrackClaims(content)
  return claims.some((claim) => {
    const normalizedClaim = compactTrackText(claim)
    return !tracks.some((track) => (
      trackClaimMatches(track, claim)
      || normalizedClaim === compactTrackText(track.artist)
    ))
  })
}

export function boundTrackClaimContent(tracks: Track[]): string {
  const first = tracks[0]
  if (!first) return '我刚才没拿到能播放的版本，这次先不乱报歌名。你再让我挑一次，我直接把歌放出来。'
  if (tracks.length === 1) return `行，先放${first.artist}的《${first.title}》。先听开头。`
  const names = tracks.slice(0, 3).map((track) => `${track.artist}的《${track.title}》`).join('、')
  return `行，我先挑这几首：${names}。先从第一首开始。`
}

export function enforceAssistantTrackBinding(content: string, tracks: Track[], expectsMusicAction = true): string {
  if (tracks.length > 0) {
    return containsUnboundQuotedTrackClaim(content, tracks) || containsUnboundUnquotedTrackClaim(content, tracks)
      ? boundTrackClaimContent(tracks)
      : content
  }
  if (!containsUnboundTrackClaim(content)) return content
  if (!expectsMusicAction && !/(?:放|播放|听听|先听|这首|这歌|《[^》]{1,40}》)/.test(content)) return content
  return boundTrackClaimContent([])
}

export function assertSendChatResultContract(result: SendChatResult): SendChatResult {
  if (!result.message || result.message.role !== 'assistant') {
    throw new Error('chat pipeline contract failed: assistant message missing')
  }
  if (typeof result.message.content !== 'string') {
    throw new Error('chat pipeline contract failed: assistant content missing')
  }
  if (!Array.isArray(result.tracks)) {
    throw new Error('chat pipeline contract failed: result tracks must be an array')
  }
  assertAssistantReplyInputContract(result.message.content, result.tracks)
  const messageTracks = result.message.tracks ?? []
  if (messageTracks.length !== result.tracks.length) {
    throw new Error('chat pipeline contract failed: message tracks and result tracks diverged')
  }
  return result
}
