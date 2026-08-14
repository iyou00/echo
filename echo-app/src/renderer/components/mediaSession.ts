export interface PlayerMediaActions {
  play: () => void
  pause: () => void
  previous: () => void
  next: () => void
  seek: (details: MediaSessionActionDetails) => void
}

export function installMediaSessionActions(
  mediaSession: Pick<MediaSession, 'setActionHandler'>,
  actions: PlayerMediaActions,
): () => void {
  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ['play', actions.play],
    ['pause', actions.pause],
    ['previoustrack', actions.previous],
    ['nexttrack', actions.next],
    ['seekto', actions.seek],
    ['seekbackward', actions.seek],
    ['seekforward', actions.seek],
  ]
  for (const [action, handler] of handlers) {
    try {
      mediaSession.setActionHandler(action, handler)
    } catch {
      // Older Chromium builds may not expose every optional media action.
    }
  }
  return () => {
    for (const [action] of handlers) {
      try {
        mediaSession.setActionHandler(action, null)
      } catch {
        // Keep cleanup compatible with the same optional action set.
      }
    }
  }
}
