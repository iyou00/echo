import { describe, expect, it } from 'vitest'
import type { Track } from '../../../types/ipc'
import { classifyFallbackChatIntent, type ChatIntent } from './intent'
import { chatSendPipelineTestHelpers } from './sendPipeline'
import type { TranslatedInput } from './inputTranslator'
import { enforceAssistantTrackBinding } from './pipelineContract'
import { classifyPlaybackOutcome } from '../../domain/agentAction/outcomePolicy'

const { mergeTranslatedIntent } = chatSendPipelineTestHelpers

const currentTrack: Track = {
  id: 'track-1',
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  playUrl: 'https://example.com/a.mp3',
}

function translate(overrides: Partial<TranslatedInput> = {}): TranslatedInput {
  return {
    searchQuery: '轻快 活力',
    intent: '用户想听轻快的歌',
    artist: null,
    title: null,
    ...overrides,
  }
}

/**
 * 翻译器的输出只能补充确定性层，不能改写它。
 * 这六个 kind 各自对应独立的推荐管线或分支，被改掉就是整条链路失效。
 * specs/routing-layering-design.md — Phase B / §5.2
 */
describe('mergeTranslatedIntent', () => {
  it('returns null when the translation carries no search query', () => {
    const base = classifyFallbackChatIntent('你好')
    expect(mergeTranslatedIntent(base, translate({ searchQuery: null }))).toBeNull()
  })

  describe('非音乐意图不得被改判', () => {
    it('keeps the weather branch', () => {
      const base = classifyFallbackChatIntent('今天天气怎么样')
      expect(base.kind).toBe('weather')

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.kind).toBe('weather')
      expect(merged?.wantsMusic).toBe(false)
    })

    it('keeps the identity branch', () => {
      const base = classifyFallbackChatIntent('你是谁')
      expect(base.kind).toBe('identity')

      expect(mergeTranslatedIntent(base, translate())?.kind).toBe('identity')
    })

    it('keeps the out-of-scope branch', () => {
      const base = classifyFallbackChatIntent('帮我写一段 Python 代码')
      expect(base.kind).toBe('out_of_scope')

      expect(mergeTranslatedIntent(base, translate())?.kind).toBe('out_of_scope')
    })
  })

  describe('独立管线对应的 kind 不得被改写', () => {
    it('keeps similar_to_track so the similarity pipeline still runs', () => {
      const base = classifyFallbackChatIntent('来点像这首的歌', { currentTrack })
      expect(base.kind).toBe('similar_to_track')

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.kind).toBe('similar_to_track')
      // 搜索词仍然并入——翻译只补充
      expect(merged?.recommendationIntent.searchQuery).toBe('轻快 活力')
    })

    it('keeps feedback_current_track and its wantsMusic decision', () => {
      const base = classifyFallbackChatIntent('这首不好听，换一首', { currentTrack })
      expect(base.kind).toBe('feedback_current_track')

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.kind).toBe('feedback_current_track')
      expect(merged?.feedbackAction).toBe(base.feedbackAction)
      // 收藏/不认同类反馈不该触发放歌，必须尊重确定性层
      expect(merged?.wantsMusic).toBe(base.wantsMusic)
    })

    it('keeps clarification_needed so ambiguous titles still get a follow-up', () => {
      // 规则层只在「歌名较长且没有歌手」时才判 clarification_needed（chat.ts directSongClarification），
      // 短歌名离线跑不出来，这里直接构造该形态来锁定合并规则本身。
      const base: ChatIntent = {
        ...classifyFallbackChatIntent('播放晴天'),
        kind: 'clarification_needed',
        needsClarification: { reason: 'missing_artist', prompt: '我先确认一下' },
      }

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.kind).toBe('clarification_needed')
      expect(merged?.needsClarification?.reason).toBe('missing_artist')
    })
  })

  describe('其余情况按翻译实体推导', () => {
    it('derives mood_request when no entity is translated', () => {
      const base = classifyFallbackChatIntent('随便来一首')

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.kind).toBe('mood_request')
      expect(merged?.wantsMusic).toBe(true)
      expect(merged?.recommendationIntent.searchQuery).toBe('轻快 活力')
    })

    it('derives artist_request from a translated artist', () => {
      const base = classifyFallbackChatIntent('随便来一首')

      const merged = mergeTranslatedIntent(base, translate({ artist: '陈默之', searchQuery: '陈默之' }))
      expect(merged?.kind).toBe('artist_request')
      expect(merged?.artistQuery).toBe('陈默之')
    })

    it('derives direct_song from a translated title', () => {
      const base = classifyFallbackChatIntent('随便来一首')

      const merged = mergeTranslatedIntent(base, translate({ artist: '王菲', title: '主角', searchQuery: '王菲 主角' }))
      expect(merged?.kind).toBe('direct_song')
      expect(merged?.seedTitle).toBe('主角')
      expect(merged?.artistQuery).toBe('王菲')
    })
  })

  describe('实体只补充不清空', () => {
    it('keeps the deterministic entity when the translator extracts none', () => {
      const base = classifyFallbackChatIntent('陈默之的歌', {})
      expect(base.artistQuery).toBeTruthy()

      const merged = mergeTranslatedIntent(base, translate({ artist: null, searchQuery: '安静 舒缓' }))
      expect(merged?.artistQuery).toBe(base.artistQuery)
      expect(merged?.recommendationIntent.artistQuery).toBe(base.recommendationIntent.artistQuery)
    })

    it('prefers the translated entity when both are present', () => {
      const base = classifyFallbackChatIntent('陈默之的歌', {})

      const merged = mergeTranslatedIntent(base, translate({ artist: '王菲', searchQuery: '王菲' }))
      expect(merged?.artistQuery).toBe('王菲')
    })
  })

  describe('searchQuery 必须进入 llmIntentOverride 才能到达召回层', () => {
    // fetchRecommendationCandidates 只把 llmIntentOverride 传给 searchMusic
    // （并短路 inferMusicSearchIntent 的第二次 LLM），recall 的 keywordFromIntent
    // 只消费 mergeIntent 后的 intent.searchQuery。只写在 recommendationIntent
    // 上没有下游读取——这是 Phase C 期间发现的断链，用这组断言锁死。
    it('carries searchQuery in llmIntentOverride for mood requests', () => {
      const base = classifyFallbackChatIntent('随便来一首')

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.llmIntentOverride?.searchQuery).toBe('轻快 活力')
      expect(merged?.llmIntentOverride?.wantsMusic).toBe(true)
      // 纯情绪请求：清掉规则层从原话猜的实体，防止描述性短语被补回成歌名
      expect(merged?.llmIntentOverride?.clearSeedTitle).toBe(true)
      expect(merged?.llmIntentOverride?.clearArtistQuery).toBe(true)
    })

    it('carries translated entities in the override without clear flags', () => {
      const base = classifyFallbackChatIntent('随便来一首')

      const merged = mergeTranslatedIntent(base, translate({ artist: '王菲', title: '主角', searchQuery: '王菲 主角' }))
      expect(merged?.llmIntentOverride?.artistQuery).toBe('王菲')
      expect(merged?.llmIntentOverride?.seedTitle).toBe('主角')
      expect(merged?.llmIntentOverride?.clearSeedTitle).toBe(false)
      expect(merged?.llmIntentOverride?.clearArtistQuery).toBe(false)
    })

    it('does not attach an override for preserved pipelines', () => {
      const base = classifyFallbackChatIntent('来点像这首的歌', { currentTrack })
      expect(base.kind).toBe('similar_to_track')

      const merged = mergeTranslatedIntent(base, translate())
      expect(merged?.llmIntentOverride).toBeUndefined()
    })

    it('override searchQuery survives mergeIntent into the recall intent', async () => {
      const { mergeIntent, parseIntent } = await import('../recommendation/intent')
      const base = classifyFallbackChatIntent('心里堵得慌，想听点能把这口气散掉的音乐')
      const merged = mergeTranslatedIntent(base, translate({ searchQuery: '宣泄 节奏' }))

      const recallIntent = mergeIntent(parseIntent('心里堵得慌，想听点能把这口气散掉的音乐'), merged?.llmIntentOverride)
      expect(recallIntent.searchQuery).toBe('宣泄 节奏')
    })

    it('does not wipe a deterministic entity the translator missed (search layer)', async () => {
      // 回归：clear* 曾无条件跟随翻译器缺实体置位——翻译器漏抽歌手时，
      // recommendFromNetease 的 mergeIntent 会把确定性层抽到的实体 delete 掉，
      // 「推荐几首陈默之的歌」退化成泛泛的情绪搜索。搜索层同样要守住
      // 「实体只补充不清空」契约。
      const { mergeIntent, parseIntent } = await import('../recommendation/intent')
      const base = classifyFallbackChatIntent('推荐几首陈默之的歌')
      expect(base.artistQuery).toBe('陈默之')

      const merged = mergeTranslatedIntent(base, translate({ artist: null, searchQuery: '安静 舒缓' }))
      expect(merged?.llmIntentOverride?.clearArtistQuery).toBe(false)

      const recallIntent = mergeIntent(parseIntent('推荐几首陈默之的歌'), merged?.llmIntentOverride)
      expect(recallIntent.artistQuery).toBe('陈默之')
      expect(recallIntent.searchQuery).toBe('安静 舒缓')
    })
  })

  describe('intentDescription', () => {
    it('carries the translator understanding for reply disambiguation', () => {
      const base = classifyFallbackChatIntent('随便来一首')

      const merged = mergeTranslatedIntent(base, translate({ intent: '用户想听轻快的歌' }))
      expect(merged?.intentDescription).toBe('用户想听轻快的歌')
    })
  })
})

describe('agent loop cross-layer contract', () => {
  it('keeps one grounded identity from understanding through recall, reply, and outcome', async () => {
    const { mergeIntent, parseIntent } = await import('../recommendation/intent')
    const base = classifyFallbackChatIntent('心里堵得慌，来点能让我松口气的')
    const routed = mergeTranslatedIntent(base, translate({ searchQuery: '舒缓 松弛' }))
    const recall = mergeIntent(parseIntent('心里堵得慌，来点能让我松口气的'), routed?.llmIntentOverride)
    expect(recall.searchQuery).toBe('舒缓 松弛')

    const candidate: Track = { id: 'candidate-1', title: '真正候选', artist: '候选歌手', source: 'netease' }
    const boundReply = enforceAssistantTrackBinding('先听候选歌手的《真正候选》。', [candidate], true)
    expect(boundReply).toContain('《真正候选》')

    const outcome = classifyPlaybackOutcome({
      playbackInstanceId: 'play-1', actionId: 'recommendation-1', actionItemId: 'track-1',
      positionMs: 180_000, durationMs: 200_000, reason: 'ended',
    })
    expect(outcome).toMatchObject({
      actionId: 'recommendation-1', actionItemId: 'track-1', outcomeType: 'completed', polarity: 'positive',
    })
  })
})
