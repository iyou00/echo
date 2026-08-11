export {
  diversifyByArtist,
  hasTrackIdentity,
  normalizeText,
  primaryArtist,
  trackIdentityKeys,
  trackIdentitySet,
  trackKey,
  unique,
  uniqueTracks,
} from '../../skills/music/identity'

export function parseJsonObject(content: string): Record<string, unknown> | null {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return null
  }
}
