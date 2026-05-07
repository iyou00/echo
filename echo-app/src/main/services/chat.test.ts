import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Track } from '../../types/ipc'

const mocks = vi.hoisted(() => {
  class MockLlmError extends Error {
    constructor(message: string, public kind: 'config' | 'network' | 'auth' | 'rate_limit' | 'server') {
      super(message)
    }
  }

  return {
    appendConversation: vi.fn(),
    appendRecommendedTracks: vi.fn(),
    streamChat: vi.fn(),
    recommendFromNetease: vi.fn(),
    inferIntentWithLlm: vi.fn(),
    recordHealth: vi.fn(),
    MockLlmError,
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
  },
}))

vi.mock('../db/conversations', () => ({
  appendConversation: mocks.appendConversation,
  loadTodayConversations: vi.fn(() => []),
}))

vi.mock('../db/tracks', () => ({
  appendRecommendedTracks: mocks.appendRecommendedTracks,
}))

vi.mock('../db/settings', () => ({
  getSettings: vi.fn(() => ({ llm: { baseUrl: 'mock://llm', apiKey: 'key', model: 'mock' } })),
}))

vi.mock('../llm/prompt', () => ({
  buildChatContext: vi.fn(() => [{ role: 'user', content: 'mock' }]),
}))

vi.mock('../llm/client', () => ({
  LlmError: mocks.MockLlmError,
  streamChat: mocks.streamChat,
}))

vi.mock('./taste', () => ({
  applySignal: vi.fn(),
}))

vi.mock('../netease/music', () => ({
  resolvePlayableTrack: vi.fn(),
}))

vi.mock('./health', () => ({
  recordHealth: mocks.recordHealth,
}))

vi.mock('./recommendation', () => {
  class NeteaseAuthRequiredError extends Error {}

  function parseRequestedTrackCount(text: string) {
    const match = text.match(/(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*首/)
    const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    const requestedCount = match ? Number(match[1]) || map[match[1]] || 1 : 1
    const targetCount = Math.max(1, Math.min(5, requestedCount))
    return { requestedCount, targetCount, overLimit: requestedCount > 5, explicit: Boolean(match) }
  }

  return {
    MAX_RECOMMENDATION_COUNT: 5,
    OVER_LIMIT_RECOMMENDATION_LINE: '歌不在多，慢慢听。我先给你挑 5 首。',
    NeteaseAuthRequiredError,
    inferIntentWithLlm: mocks.inferIntentWithLlm,
    parseRequestedTrackCount,
    recommendFromNetease: mocks.recommendFromNetease,
  }
})

vi.mock('./scene', () => ({
  getCurrentScene: vi.fn(() => null),
}))

vi.mock('./tasteQuestionScheduler', () => ({
  capturePendingQuestionAnswer: vi.fn(() => Promise.resolve({ action: 'none' })),
  generateDynamicTasteQuestions: vi.fn(),
  pickTasteFollowUpQuestion: vi.fn(() => null),
  recordFollowUpQuestionAsked: vi.fn(),
}))

vi.mock('./safety/jailbreak-filter', () => ({
  checkJailbreak: vi.fn(() => ({ isJailbreak: false })),
  pickJailbreakResponse: vi.fn(() => '我先不聊这个。'),
}))

vi.mock('./safety/output-filter', () => ({
  checkOutputSafe: vi.fn(() => ({ safe: true })),
}))

function makeTrack(index: number): Track {
  return {
    id: String(index),
    neteaseId: String(index),
    title: `Track ${index}`,
    artist: 'Echo Test',
    playUrl: `mock://${index}`,
    source: 'netease',
  }
}

function streamText(text: string) {
  return async function* stream() {
    yield { content: text }
  }
}

function failingStream() {
  return async function* stream() {
    const empty: Array<{ content: string }> = []
    yield* empty
    throw new mocks.MockLlmError('LLM down', 'network')
  }
}

describe('chat recommendation flow', () => {
  beforeEach(() => {
    let id = 1
    mocks.appendConversation.mockImplementation((role: ChatMessage['role'], content: string, tracks: Track[] = []) => ({
      id: id++,
      role,
      content,
      tracks,
      createdAt: new Date().toISOString(),
    }))
    mocks.appendRecommendedTracks.mockReset()
    mocks.streamChat.mockReset()
    mocks.recommendFromNetease.mockReset()
    mocks.inferIntentWithLlm.mockResolvedValue(null)
    mocks.recordHealth.mockReset()
  })

  it('keeps playable candidates as song cards when the chat LLM fails', async () => {
    const [track] = [makeTrack(1)]
    mocks.recommendFromNetease.mockResolvedValue([track])
    mocks.streamChat.mockImplementation(failingStream())

    const { send } = await import('./chat')
    const result = await send('来一首欢快的歌')

    expect(result.tracks.map((item) => item.title)).toEqual(['Track 1'])
    expect(result.message.tracks?.map((item) => item.title)).toEqual(['Track 1'])
    expect(mocks.appendRecommendedTracks).toHaveBeenCalledWith([track])
    expect(result.message.content).toContain('Track 1')
  })

  it('fills an explicit five-track request from candidates even when the text mentions one song', async () => {
    const tracks = [1, 2, 3, 4, 5].map(makeTrack)
    mocks.recommendFromNetease.mockResolvedValue(tracks)
    mocks.streamChat.mockImplementation(streamText('先听《Track 1》。'))

    const { send } = await import('./chat')
    const result = await send('准备听会儿歌休息，来5首欢快的歌曲')

    expect(result.tracks).toHaveLength(5)
    expect(result.tracks.map((item) => item.title)).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5'])
    expect(mocks.appendRecommendedTracks).toHaveBeenCalledWith(tracks)
  })
})
