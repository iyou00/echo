import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
  },
}))

vi.mock('../db/conversations', () => ({ loadRecentConversations: vi.fn(() => []) }))
vi.mock('../db/tracks', () => ({
  appendRecommendedTracks: vi.fn(),
  loadListenedTracksSince: vi.fn(() => []),
  loadRecentRecommendedTracks: vi.fn(() => []),
}))
vi.mock('../db/playlists', () => ({ getAllImportedTracks: vi.fn(() => []) }))
vi.mock('../db/taste', () => ({ getTasteProfile: vi.fn(() => null) }))
vi.mock('../db/settings', () => ({ getSettings: vi.fn(() => ({ user: {}, llm: {} })) }))
vi.mock('../llm/client', () => ({
  LlmError: class LlmError extends Error {
    kind = 'network'
  },
  completeChat: vi.fn(),
}))
vi.mock('../netease/music', () => ({ filterPlayableTracks: vi.fn(async () => []) }))
vi.mock('../tts/client', () => ({ synthesize: vi.fn(async () => ({ ok: false })) }))
vi.mock('../utils/paths', () => ({ readRootFile: vi.fn(() => '') }))
vi.mock('./daySeal', () => ({ getMostRecentSeal: vi.fn(() => '') }))
vi.mock('../weather/client', () => ({ getWeather: vi.fn(async () => null) }))
vi.mock('./health', () => ({ recordHealth: vi.fn() }))
vi.mock('./recommendation', () => ({ recommendFromNetease: vi.fn(async () => []) }))

function track(): Track {
  return {
    id: '1',
    neteaseId: '1',
    title: '十年',
    artist: '陈奕迅',
    playUrl: 'mock://1',
  }
}

describe('listening text alignment', () => {
  it('removes a mismatched artist/title sentence and anchors the selected track', async () => {
    const { listeningTestHelpers } = await import('./listening')
    const aligned = listeningTestHelpers.alignTextToTrack('我给你放周杰伦的《晴天》，先垫着。', track())

    expect(aligned).toBe('我给你接上陈奕迅的《十年》。')
    expect(aligned).not.toContain('周杰伦')
    expect(aligned).not.toContain('晴天')
  })

  it('adds the selected artist when the text only mentions the title', async () => {
    const { listeningTestHelpers } = await import('./listening')
    const aligned = listeningTestHelpers.alignTextToTrack('这会儿可以先听《十年》。', track())

    expect(aligned).toContain('陈奕迅的《十年》')
  })
})
