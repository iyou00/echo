import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../../types/ipc'

const mocks = vi.hoisted(() => ({
  completeChat: vi.fn(),
  readRootFile: vi.fn(),
}))

vi.mock('../../llm/client', () => ({
  completeChat: mocks.completeChat,
}))

vi.mock('../../skills/soul/policy', () => ({
  buildSoulPolicyPrompt: vi.fn(() => 'SOUL'),
}))

vi.mock('../../utils/paths', () => ({
  readRootFile: mocks.readRootFile,
}))

import { translateUserInput } from './inputTranslator'

const settings = { llm: { baseUrl: 'http://x', apiKey: 'k', model: 'm' } } as unknown as Settings

/** 模拟一份 prompt 文件：System 段 + User 段，用于验证只取 System 段 */
const promptFile = ['# Input Translator', '## System', '翻译规则', '', '## User', '动态拼接部分不应该进入 system'].join('\n')

function replyWith(payload: unknown): void {
  mocks.completeChat.mockResolvedValueOnce(JSON.stringify(payload))
}

function lastUserPrompt(): string {
  const messages = mocks.completeChat.mock.calls.at(-1)?.[1] as Array<{ role: string; content: string }>
  return messages.find((message) => message.role === 'user')?.content ?? ''
}

describe('translateUserInput', () => {
  beforeEach(() => {
    mocks.completeChat.mockReset()
    mocks.readRootFile.mockReturnValue(promptFile)
  })

  it('translates an emotion into search keywords', async () => {
    replyWith({
      searchQuery: '安静 舒缓',
      intent: '用户心情烦躁，想听安静的歌',
      entities: { artist: null, title: null },
    })

    const result = await translateUserInput('当心情烦躁的时候，你有什么歌曲推荐给我', settings, {})

    expect(result?.searchQuery).toBe('安静 舒缓')
    expect(result?.intent).toBe('用户心情烦躁，想听安静的歌')
    expect(result?.artist).toBeNull()
    expect(result?.title).toBeNull()
  })

  it('extracts artist and title entities', async () => {
    replyWith({
      searchQuery: '王菲 主角',
      intent: '用户想听王菲的《主角》',
      entities: { artist: '王菲', title: '主角' },
    })

    const result = await translateUserInput('王菲的主角', settings, {})

    expect(result?.searchQuery).toBe('王菲 主角')
    expect(result?.artist).toBe('王菲')
    expect(result?.title).toBe('主角')
  })

  it('keeps searchQuery null for non-music input', async () => {
    replyWith({ searchQuery: null, intent: '用户在打招呼', entities: { artist: null, title: null } })

    const result = await translateUserInput('你好', settings, {})

    expect(result?.searchQuery).toBeNull()
    expect(result?.intent).toBe('用户在打招呼')
  })

  it('parses JSON wrapped in a markdown fence', async () => {
    mocks.completeChat.mockResolvedValueOnce(
      '```json\n{"searchQuery":"轻快 活力","intent":"用户想提神","entities":{}}\n```',
    )

    const result = await translateUserInput('来点提神的', settings, {})

    expect(result?.searchQuery).toBe('轻快 活力')
  })

  it('rejects a searchQuery that is a sentence rather than keywords', async () => {
    replyWith({ searchQuery: '我想听一首让人安静下来的歌。', intent: 'x', entities: {} })

    const result = await translateUserInput('我想听一首让人安静下来的歌。', settings, {})

    expect(result?.searchQuery).toBeNull()
  })

  it('drops a descriptive phrase mistakenly filled as a song title', async () => {
    replyWith({
      searchQuery: '宣泄 节奏',
      intent: '用户心里憋闷',
      entities: { artist: null, title: '能把这口气散掉' },
    })

    const result = await translateUserInput('心里堵得慌，想听点能把这口气散掉的音乐', settings, {})

    expect(result?.searchQuery).toBe('宣泄 节奏')
    expect(result?.title).toBeNull()
  })

  it('returns null when the model returns garbage', async () => {
    mocks.completeChat.mockResolvedValueOnce('这不是 JSON')

    expect(await translateUserInput('你好', settings, {})).toBeNull()
  })

  it('returns null when the model call fails', async () => {
    mocks.completeChat.mockRejectedValueOnce(new Error('boom'))

    expect(await translateUserInput('来首歌', settings, {})).toBeNull()
  })

  it('returns null for empty input without calling the model', async () => {
    expect(await translateUserInput('   ', settings, {})).toBeNull()
    expect(mocks.completeChat).not.toHaveBeenCalled()
  })

  it('uses only the System section of the prompt file', async () => {
    replyWith({ searchQuery: '安静', intent: 'x', entities: {} })

    await translateUserInput('静一静', settings, {})

    const system = (mocks.completeChat.mock.calls.at(-1)?.[1] as Array<{ role: string; content: string }>)
      .find((message) => message.role === 'system')?.content ?? ''
    expect(system).toContain('翻译规则')
    expect(system).not.toContain('动态拼接部分')
  })

  it('caps dialog history at 8 turns and 200 characters per message', async () => {
    replyWith({ searchQuery: '安静', intent: 'x', entities: {} })

    const recentDialog = Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: `${index}`.repeat(400),
    }))
    await translateUserInput('再来一首', settings, { recentDialog })

    const prompt = JSON.parse(lastUserPrompt())
    expect(prompt.context.recentDialog).toHaveLength(8)
    expect(prompt.context.recentDialog[0]).toHaveLength(200 + 'user: '.length)
  })

  it('passes music session and current track into the context', async () => {
    replyWith({ searchQuery: '陈默之', intent: 'x', entities: {} })

    await translateUserInput('再来几首', settings, {
      musicSession: { artistQuery: '陈默之' },
      currentTrack: { title: '旧歌', artist: '旧歌手' },
    })

    const prompt = JSON.parse(lastUserPrompt())
    expect(prompt.context.musicSession).toEqual({ artistQuery: '陈默之' })
    expect(prompt.context.currentTrack).toEqual({ title: '旧歌', artist: '旧歌手' })
  })

  it('omits empty context blocks rather than sending nulls', async () => {
    replyWith({ searchQuery: '安静', intent: 'x', entities: {} })

    await translateUserInput('静一静', settings, {})

    const prompt = JSON.parse(lastUserPrompt())
    expect(prompt.context).toEqual({})
  })

  it('asks for deterministic output with a short token budget', async () => {
    replyWith({ searchQuery: '安静', intent: 'x', entities: {} })

    await translateUserInput('静一静', settings, {})

    expect(mocks.completeChat.mock.calls.at(-1)?.[2]).toMatchObject({ temperature: 0 })
  })
})
