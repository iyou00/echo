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

function firstNonEmpty(items: Array<string | undefined>): string {
  return items.map((item) => item?.trim() ?? '').find(Boolean) ?? ''
}

function semanticVibeTarget(track: Track): string {
  return firstNonEmpty([
    track.semantic?.moods[0],
    track.semantic?.scenes[0],
    track.echoNote,
    track.reason,
  ])
}

function semanticGenreTarget(track: Track): string {
  return firstNonEmpty([track.semantic?.genres[0]])
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

  return [
    {
      kind: 'skipped',
      refreshReason: 'explicit_miss',
      payload: {
        artist: track.artist,
        trackId,
        title: track.title,
        context,
      },
    },
  ]
}

export function buildExplicitTrackFeedbackSignal(
  track: Track,
  action: ExplicitTrackFeedbackAction,
  context?: string,
): TasteSignalDraft {
  return buildExplicitTrackFeedbackSignals(track, action, context)[0]
}
