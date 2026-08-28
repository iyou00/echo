import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  matchLearnedPrecedent: vi.fn(),
  incrementLearnedCaseHit: vi.fn(),
}))

vi.mock('../../services/chat/learnedPrecedentMatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  matchLearnedPrecedent: mocks.matchLearnedPrecedent,
}))

vi.mock('../../db/learnedCases', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  incrementLearnedCaseHit: mocks.incrementLearnedCaseHit,
}))

import { resolvePreLlmChatIntent } from './chat'

/**
 * 链路顺序的回归网：确定性层必须先于翻译器执行，且只对中文生效。
 * specs/routing-layering-design.md — Phase A / 决策 1 / 决策 3
 */
describe('resolvePreLlmChatIntent', () => {
  beforeEach(() => {
    mocks.matchLearnedPrecedent.mockReset()
    mocks.incrementLearnedCaseHit.mockReset()
    mocks.matchLearnedPrecedent.mockReturnValue(null)
  })

  describe('情绪+音乐快速通道', () => {
    it('routes unambiguous emotions without asking the LLM', () => {
      const intent = resolvePreLlmChatIntent('推荐一首放松的歌')

      expect(intent?.kind).toBe('mood_request')
      expect(intent?.wantsMusic).toBe(true)
      expect(intent?.recommendationIntent.searchQuery).toBe('安静 舒缓')
    })

    it('carries the search query in llmIntentOverride so recall consumes it', () => {
      // fetchRecommendationCandidates 只把 llmIntentOverride 传给 searchMusic（并因此
      // 短路 inferMusicSearchIntent 的第二次 LLM）；recall 的 keywordFromIntent 只读
      // mergeIntent 后的 intent.searchQuery。没有 override，快速通道等于白算。
      const intent = resolvePreLlmChatIntent('推荐一首放松的歌')

      expect(intent?.llmIntentOverride?.searchQuery).toBe('安静 舒缓')
      expect(intent?.llmIntentOverride?.wantsMusic).toBe(true)
      expect(intent?.llmIntentOverride?.clearSeedTitle).toBe(true)
      expect(intent?.llmIntentOverride?.clearArtistQuery).toBe(true)
    })

    it('maps sadness to healing keywords', () => {
      expect(resolvePreLlmChatIntent('难过，想听首歌')?.recommendationIntent.searchQuery).toBe('治愈 温暖 轻柔')
    })

    it('maps tiredness to energising keywords', () => {
      expect(resolvePreLlmChatIntent('好累，来首歌提提神')?.recommendationIntent.searchQuery).toBe('提神 轻快 活力')
    })

    // 决策 1：同一个「堵」字可能是宣泄也可能是安抚，关键词匹配分不出来，必须交给翻译器看整句
    it('leaves ambiguous negative emotions to the translator', () => {
      const ambiguous = [
        '烦躁，来首歌',
        '心里堵得慌，想听点歌',
        '压力好大，推荐一首',
        '好生气，放首歌',
        '有点焦虑，来点音乐',
      ]
      for (const text of ambiguous) {
        expect(resolvePreLlmChatIntent(text), text).toBeNull()
      }
    })

    it('ignores emotion words when no music is requested', () => {
      expect(resolvePreLlmChatIntent('我今天好累')).toBeNull()
    })
  })

  describe('语种闸门（决策 3）', () => {
    it('skips the Chinese-only layers for English input', () => {
      expect(resolvePreLlmChatIntent("I'm so stressed, give me a song")).toBeNull()
    })

    it('skips the Chinese-only layers for Japanese input', () => {
      expect(resolvePreLlmChatIntent('落ち込んでる、元気が出る曲が聞きたい')).toBeNull()
    })

    it('skips the Chinese-only layers for Korean input', () => {
      expect(resolvePreLlmChatIntent('우울해, 노래 추천해줘')).toBeNull()
    })

    it('still handles Chinese written with a Latin-script artist name', () => {
      expect(resolvePreLlmChatIntent('累，来首 Taylor Swift 的歌')?.recommendationIntent.searchQuery)
        .toBe('提神 轻快 活力')
    })
  })

  describe('先例匹配（学到的纠正）', () => {
    it('applies a learned music precedent and counts the hit', () => {
      mocks.matchLearnedPrecedent.mockReturnValue({
        caseId: 'case-1',
        expectedKind: 'artist_request',
        artistQuery: '陈默之',
      })

      const intent = resolvePreLlmChatIntent('随便来一首')

      expect(intent?.kind).toBe('artist_request')
      expect(intent?.artistQuery).toBe('陈默之')
      expect(intent?.wantsMusic).toBe(true)
      expect(mocks.incrementLearnedCaseHit).toHaveBeenCalledWith('case-1')
    })

    it('applies a learned non-music precedent', () => {
      mocks.matchLearnedPrecedent.mockReturnValue({ caseId: 'case-2', expectedKind: 'casual_chat' })

      const intent = resolvePreLlmChatIntent('你今天怎么样')

      expect(intent?.kind).toBe('casual_chat')
      expect(intent?.wantsMusic).toBe(false)
    })

    it('does not count a hit when the learned kind has no deterministic path', () => {
      mocks.matchLearnedPrecedent.mockReturnValue({ caseId: 'case-3', expectedKind: 'clarification_needed' })

      expect(resolvePreLlmChatIntent('播放那首歌')).toBeNull()
      expect(mocks.incrementLearnedCaseHit).not.toHaveBeenCalled()
    })

    it('never consults precedents for non-Chinese input', () => {
      expect(resolvePreLlmChatIntent('play me something')).toBeNull()
      expect(mocks.matchLearnedPrecedent).not.toHaveBeenCalled()
    })
  })
})
