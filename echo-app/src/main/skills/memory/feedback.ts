import type { ExplicitTrackFeedbackAction, Track } from '../../../types/ipc'

export interface TasteSignalDraft {
  kind: string
  payload: Record<string, unknown>
  refreshReason: string
}

export const explicitFeedbackMessages: Record<ExplicitTrackFeedbackAction, string> = {
  more_like_this: '我记住了，这类可以多来一点。',
  not_right: '懂了，这个方向我先收一收。',
}

interface ReplacementDirectionSignal {
  kind: 'reinforce_vibe' | 'like_genre'
  target: string
}

const HIGH_ENERGY_REJECTION_PATTERN = /(?:别太|不要(?:太)?|太)(?:炸|吵|激烈|激情|激昂|高昂|亢奋|热血|澎湃|燃|带感|情绪高昂)|情绪太高昂/

function firstNonEmpty(items: Array<string | undefined>): string {
  return items.map((item) => item?.trim() ?? '').find(Boolean) ?? ''
}

function semanticVibeTarget(track: Track): string {
  return firstNonEmpty([
    track.semantic?.moods[0],
    track.semantic?.scenes[0],
  ])
}

function semanticSoftNegativeVibeTarget(track: Track): string {
  return semanticVibeTarget(track)
}

function semanticGenreTarget(track: Track): string {
  return firstNonEmpty([track.semantic?.genres[0]])
}

function shouldSoftenRejectedTrackVibe(context?: string): boolean {
  const text = context?.trim() ?? ''
  return HIGH_ENERGY_REJECTION_PATTERN.test(text)
    || /太(?:慢|快|吵|闹|炸|平|软|闷|刺耳|压抑|悲伤|伤感|低落|安静|激烈|激情)|不够(?:快|慢|有劲|带感|热烈|安静|舒缓|轻快)|没(?:劲|感觉)|听着不舒服|不舒服|差点意思/.test(text)
}

function shouldSoftenRejectedTrackGenre(track: Track, context?: string): boolean {
  const text = context?.trim() ?? ''
  if (!text) return false
  const genre = semanticGenreTarget(track)
  if (!genre) return false
  if (/少推|别推|不要|不想听|听腻|腻了|不喜欢|不爱听/.test(text) && text.includes(genre)) return true
  return /这类|这种|这个风格|这个类型|同类/.test(text) && /少推|别推|不要|不想听|听腻|腻了/.test(text)
}

function pushSoftNegativeSignal(
  signals: TasteSignalDraft[],
  kind: 'soften_vibe' | 'soften_genre',
  target: string,
  track: Track,
  context?: string,
): void {
  const cleanTarget = target.trim()
  if (!cleanTarget) return
  const trackId = track.id ?? track.neteaseId
  signals.push({
    kind,
    refreshReason: 'explicit_miss',
    payload: {
      target: cleanTarget,
      artist: track.artist,
      trackId,
      title: track.title,
      context,
      strength: 0.035,
      note: `这次少推:${track.title}; ${kind === 'soften_genre' ? 'genre' : 'vibe'}:${cleanTarget}`,
    },
  })
}

function replacementDirectionSignals(context?: string): ReplacementDirectionSignal[] {
  const text = context?.trim() ?? ''
  if (!text) return []
  const avoidHighEnergy = HIGH_ENERGY_REJECTION_PATTERN.test(text)
  const avoidSlow = /别太(?:慢|软|平)|不要(?:太)?(?:慢|软|平)|太(?:慢|软|平)/.test(text)
  const avoidCalm = /别太(?:安静|舒缓|放松|慢|轻柔)|不要(?:太)?(?:安静|舒缓|放松|慢|轻柔)|太(?:安静|舒缓|放松|慢|轻柔)/.test(text)
  const signals: ReplacementDirectionSignal[] = []
  const add = (kind: ReplacementDirectionSignal['kind'], target: string) => {
    if (!signals.some((item) => item.kind === kind && item.target === target)) signals.push({ kind, target })
  }

  if (!avoidHighEnergy && /激情|激昂|高昂|热血|澎湃|燃|带感|有劲|提神|清醒|快一点|快点|快歌/.test(text)) add('reinforce_vibe', '热烈')
  if (!avoidCalm && !avoidSlow && /舒缓|安静|放松|慢一点|慢点|慢歌|温柔|轻一点|轻柔/.test(text)) add('reinforce_vibe', '放松')
  if (/轻快|欢快|开心|明亮|阳光/.test(text)) add('reinforce_vibe', '轻快')
  if (/摇滚/.test(text)) add('like_genre', '摇滚')
  if (/民谣/.test(text)) add('like_genre', '民谣')
  if (/电子/.test(text)) add('like_genre', '电子')
  if (/说唱|rap/i.test(text)) add('like_genre', '说唱')
  if (/爵士|jazz/i.test(text)) add('like_genre', '爵士')
  return signals.slice(0, 3)
}

export function buildExplicitTrackFeedbackSignals(
  track: Track,
  action: ExplicitTrackFeedbackAction,
  context?: string,
): TasteSignalDraft[] {
  const trackId = track.id ?? track.neteaseId
  if (action === 'more_like_this') {
    const signals: TasteSignalDraft[] = [
      {
        kind: 'like_track',
        refreshReason: 'explicit_like',
        payload: {
          artist: track.artist,
          trackId,
          title: track.title,
          target: [track.artist, track.title].filter(Boolean).join(' / ') || track.title,
          context,
          strength: 0.08,
          note: `多来这种:${track.title}`,
          reason: '你对这首点过“多来这种”，Echo 会把它当作明确偏好线索。',
        },
      },
      {
        kind: 'like_artist',
        refreshReason: 'explicit_like',
        payload: {
          artist: track.artist,
          trackId,
          title: track.title,
          context,
          strength: 0.04,
          note: `多来这种:${track.title}`,
        },
      },
    ]
    const vibe = semanticVibeTarget(track)
    if (vibe) {
      signals.push({
        kind: 'reinforce_vibe',
        refreshReason: 'explicit_like',
        payload: {
          target: vibe,
          artist: track.artist,
          trackId,
          title: track.title,
          context,
          strength: 0.1,
          note: `多来这种:${track.title}; vibe:${vibe}`,
        },
      })
    }
    const genre = semanticGenreTarget(track)
    if (genre) {
      signals.push({
        kind: 'like_genre',
        refreshReason: 'explicit_like',
        payload: {
          target: genre,
          genre,
          artist: track.artist,
          trackId,
          title: track.title,
          context,
          strength: 0.04,
          note: `多来这种:${track.title}; genre:${genre}`,
        },
      })
    }
    return signals
  }

  const signals: TasteSignalDraft[] = [
    {
      kind: 'unlike_track',
      refreshReason: 'explicit_miss',
      payload: {
        artist: track.artist,
        trackId,
        title: track.title,
        context,
      },
    },
  ]
  if (shouldSoftenRejectedTrackVibe(context)) {
    pushSoftNegativeSignal(signals, 'soften_vibe', semanticSoftNegativeVibeTarget(track), track, context)
  }
  if (shouldSoftenRejectedTrackGenre(track, context)) {
    pushSoftNegativeSignal(signals, 'soften_genre', semanticGenreTarget(track), track, context)
  }
  for (const direction of replacementDirectionSignals(context)) {
    signals.push({
      kind: direction.kind,
      refreshReason: 'explicit_like',
      payload: {
        target: direction.target,
        genre: direction.kind === 'like_genre' ? direction.target : undefined,
        artist: track.artist,
        trackId,
        title: track.title,
        context,
        strength: 0.055,
        note: `这次想换成:${direction.target}`,
      },
    })
  }
  return signals
}

export function buildExplicitTrackFeedbackSignal(
  track: Track,
  action: ExplicitTrackFeedbackAction,
  context?: string,
): TasteSignalDraft {
  return buildExplicitTrackFeedbackSignals(track, action, context)[0]
}
