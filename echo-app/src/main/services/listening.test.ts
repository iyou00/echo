import { describe, expect, it, vi } from 'vitest'
import type { TasteProfile, Track } from '../../types/ipc'
import { listeningTestHelpers } from './listening'

vi.mock('./memoryEvidence', () => ({
  buildMemoryEvidencePrompt: vi.fn(() => '<memory_evidence_contract>\n用户明确纠正是最高优先级证据\n</memory_evidence_contract>\n<user_corrections>\n(暂无明确纠正)\n</user_corrections>\n<profile_memory>\n{"kind":"profile_digest"}\n</profile_memory>'),
}))

describe('listening segment context', () => {
  it('builds a taste-based recommendation when today has no user conversation', () => {
    const profile: TasteProfile = {
      echo_portrait: '偏爱安静的民谣。',
      artists: [{ name: '陈粒', affinity: 0.8 }],
      genres: [{ name: '民谣', weight: 0.8, trend: 'steady' }],
      moods: [{ tag: '放松', frequency: 7 }],
      signature_tracks: [],
      anti_patterns: [],
      discovery_appetite: 0.5,
      profile_meta: {},
    }

    const basis = listeningTestHelpers.fallbackRecommendationBasis(profile)

    expect(basis.source).toBe('taste')
    expect(basis.searchQuery).toContain('放松、民谣')
    expect(basis.canReferenceYesterday).toBe(false)
    expect(listeningTestHelpers.yesterdayDate(new Date(2026, 7, 11, 12))).toBe('2026-08-10')
  })

  it('builds yesterday queries only from allowlisted music terms', () => {
    const fallback = {
      searchQuery: '推荐一首放松的歌',
      summary: '长期品味',
      canReferenceYesterday: false,
      source: 'taste' as const,
    }
    const basis = listeningTestHelpers.normalizeYesterdayRecommendationBasis({
      terms: ['韩语', '欢快', '具体疾病名称', '某个人名'],
      canReferenceYesterday: false,
      summary: '不应进入下游的隐私原文',
      searchQuery: '不应采用的自由查询',
    }, fallback)

    expect(basis.searchQuery).toBe('推荐一首韩语、欢快、适合现在听的歌')
    expect(basis.summary).toBe('只参考韩语、欢快这一音乐方向')
    expect(basis.searchQuery).not.toContain('疾病')
    expect(basis.summary).not.toContain('隐私')
  })

  it('does not expose the yesterday seal when a safe recommendation basis is used', () => {
    const profile: TasteProfile = {
      echo_portrait: '', artists: [], genres: [], moods: [], signature_tracks: [], anti_patterns: [], discovery_appetite: 0.5, profile_meta: {},
    }
    const context = listeningTestHelpers.buildContext({
      generatedAt: '2026-08-11T10:00:00+08:00',
      conversations: [],
      seal: '昨日包含不应进入本轮文案的私人内容',
      profile,
      candidates: [],
      voiceMoment: {
        state: 'daily_first', reason: '无今日对话', playedToday: 0, importedTrackCount: 0,
        hasRecommendationHistory: false, hasTasteProfile: false, isContinuation: false, suggestedLength: '150-220',
      },
      recommendationBasis: {
        searchQuery: '推荐一首韩语、欢快、适合现在听的歌',
        summary: '只参考韩语、欢快这一音乐方向',
        canReferenceYesterday: false,
        source: 'yesterday',
      },
    })

    expect(context).not.toContain('昨日包含不应进入本轮文案的私人内容')
  })

  it('uses stable event ids so later active events remain distinguishable', () => {
    expect(listeningTestHelpers.activeEventKey({ id: 12, kind: 'context', content: '今天很累' })).toBe('event:12')
    expect(listeningTestHelpers.activeEventKey({ id: 13, kind: 'context', content: '今天很累' })).toBe('event:13')
  })

  it('passes shared memory evidence into the long-form voice prompt', () => {
    const profile: TasteProfile = {
      echo_portrait: '我还在观察你。',
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [],
      anti_patterns: [],
      discovery_appetite: 0.5,
      energy_preference: 0.5,
      tempo_preference: { slow: 0, medium: 1, fast: 0 },
      profile_meta: {},
    }
    const candidate: Track = {
      title: '主角',
      artist: '王菲',
      source: 'netease',
    }

    const context = listeningTestHelpers.buildContext({
      generatedAt: '2026-06-19T09:30:00.000Z',
      weatherSummary: '多云',
      conversations: [],
      seal: '',
      profile,
      candidates: [candidate],
      voiceMoment: {
        state: 'daily_first',
        reason: '今天第一次打开回声',
        playedToday: 0,
        importedTrackCount: 10,
        hasRecommendationHistory: true,
        hasTasteProfile: true,
        isContinuation: false,
        suggestedLength: '150-220',
      },
      recommendationBasis: {
        searchQuery: '推荐一首放松的民谣',
        summary: '昨天明确问过适合休息时听的歌',
        canReferenceYesterday: true,
        source: 'yesterday',
      },
    })

    expect(context).toContain('<memory_evidence_contract>')
    expect(context).toContain('<user_corrections>')
    expect(context).toContain('<profile_memory>')
    expect(context).toContain('用户明确纠正是最高优先级证据')
    expect(context).not.toContain('<taste_signals_recent>')
    expect(context).toContain('<recommendation_basis>')
    expect(context).toContain('canReferenceYesterday')
    expect(context).toContain('昨天明确问过适合休息时听的歌')
  })

  it('passes active short-term context into the long-form voice prompt', () => {
    const profile: TasteProfile = {
      echo_portrait: '我还在观察你。',
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [],
      anti_patterns: [],
      discovery_appetite: 0.5,
      profile_meta: {},
    }

    const context = listeningTestHelpers.buildContext({
      generatedAt: '2026-06-19T09:30:00.000Z',
      weatherSummary: '多云',
      conversations: [],
      seal: '',
      profile,
      candidates: [{ title: '主角', artist: '王菲', source: 'netease' }],
      activeEvents: [{
        kind: 'context',
        content: '觉得有点冷',
        confidence: 0.64,
        weight: 0.32,
        startedAt: '2026-06-19T09:00:00.000Z',
        createdAt: '2026-06-19T09:00:00.000Z',
      }],
      voiceMoment: {
        state: 'emotion_context',
        reason: '最近对话里有情绪或状态线索',
        playedToday: 0,
        importedTrackCount: 10,
        hasRecommendationHistory: true,
        hasTasteProfile: true,
        isContinuation: false,
        suggestedLength: '150-220',
      },
    })

    expect(context).toContain('<active_events>')
    expect(context).toContain('"content": "觉得有点冷"')
    expect(context).toContain('"scope": "today_context"')
    expect(context).toContain('<active_events_contract>')
    expect(context).toContain('只能写成“今天/这会儿/刚才”的轻量观察')
  })

  it('rejects memory source leaks in long-form voice copy', () => {
    expect(listeningTestHelpers.hasListeningTextQuality('我记得你说过不喜欢电子音墙，这次先听王菲的《主角》。声音开小一点，等副歌出来再看合不合适。')).toBe(false)
    expect(listeningTestHelpers.hasListeningTextQuality('你之前告诉过我少推悲伤的歌，这次先听陈奕迅的《好久不见》。从第一句慢慢进去就行。')).toBe(false)
  })

  it('keeps ordinary speculative wording in long-form voice copy', () => {
    expect(listeningTestHelpers.hasListeningTextQuality(
      '先听王菲的《主角》。你说不定会更在意第一句出来之前那点空白，我也想看看这首能不能贴住现在。',
    )).toBe(true)
  })

  it('rejects mechanically similar copy from recent listening segments', () => {
    const recentTexts = ['先听王菲的《主角》。这回先跟着前奏走。']

    expect(listeningTestHelpers.hasListeningTextQuality(
      '先听陈奕迅的《好久不见》。这回先跟着前奏走。',
      { recentTexts },
    )).toBe(false)
  })

  it('applies dynamic density limits to generated copy', () => {
    const plan = {
      sessionId: 1,
      segmentIndex: 2,
      delivery: 'spoken' as const,
      density: 'micro' as const,
      move: 'judge' as const,
      sentenceForm: 'judgment' as const,
      topicSource: 'music_transition' as const,
      minChars: 16,
      maxChars: 56,
      maxSentences: 2,
      checkpoint: false,
      reason: 'automatic_continuation',
    }

    expect(listeningTestHelpers.hasListeningTextQuality('王菲的《主角》来了。刚才够安静，这回醒一醒。', { plan })).toBe(true)
    expect(listeningTestHelpers.hasListeningTextQuality('王菲的《主角》来了。第一句。第二句。第三句。', { plan })).toBe(false)

    const firstFallback = listeningTestHelpers.fallbackText({ title: '主角', artist: '王菲' }, plan)
    const secondFallback = listeningTestHelpers.fallbackText({ title: '主角', artist: '王菲' }, plan, [firstFallback])
    expect(listeningTestHelpers.hasListeningTextQuality(firstFallback, { plan })).toBe(true)
    expect(listeningTestHelpers.hasListeningTextQuality(secondFallback, { plan, recentTexts: [firstFallback] })).toBe(true)
    expect(secondFallback).not.toBe(firstFallback)
  })

  it('compares copy shape while ignoring the selected song title', () => {
    const similarity = listeningTestHelpers.listeningTextSimilarity(
      '先听王菲的《主角》。这回让耳朵走条新路。',
      '先听陈奕迅的《好久不见》。这回让耳朵走条新路。',
    )

    expect(similarity).toBeGreaterThan(0.58)
  })

  it('uses artist evidence when picking among duplicate song titles', () => {
    const candidates: Track[] = [
      { title: '主角', artist: '未知歌手', source: 'netease' },
      { title: '主角', artist: '王菲', source: 'netease' },
    ]

    const picked = listeningTestHelpers.pickTrackFromText('现在先听王菲的《主角》。你不用认真听，等副歌出来再说。', candidates)

    expect(picked?.artist).toBe('王菲')
  })

  it('ranks a different language and genre ahead of a cooled artist', () => {
    const semantic = (language: string, genres: string[], energy: number): Track['semantic'] => ({
      language,
      genres,
      moods: ['放松'],
      scenes: ['夜晚'],
      energy,
      tempo: energy > 0.6 ? 'fast' : 'slow',
      familiarity: 'safe',
      confidence: 0.8,
    })
    const history = [
      { artist: '麦小兜', language: '华语', genres: ['华语流行'], moods: ['放松'], energy: 0.35, tempo: 'slow', year: 2024 },
      { artist: '魏玉慧', language: '华语', genres: ['华语流行'], moods: ['治愈'], energy: 0.38, tempo: 'slow', year: 2023 },
      { artist: '指尖笑', language: '华语', genres: ['华语流行'], moods: ['安静'], energy: 0.4, tempo: 'slow', year: 2022 },
    ]
    const candidates: Track[] = [
      { title: '旧方向', artist: '麦小兜', year: 2024, semantic: semantic('华语', ['华语流行'], 0.36) },
      { title: '新方向', artist: 'New Hope Club', year: 2019, semantic: semantic('英语', ['欧美流行'], 0.72) },
    ]

    const ranked = listeningTestHelpers.rankBySessionDiversity(candidates, history)

    expect(ranked[0].title).toBe('新方向')
  })

  it('separates imported-only profile evidence from real listening behavior for voice fallback wording', () => {
    const importedOnly: TasteProfile = {
      echo_portrait: '我还在观察你。',
      artists: [{ name: '王菲', affinity: 0.8 }],
      genres: [],
      moods: [],
      signature_tracks: [],
      anti_patterns: [],
      discovery_appetite: 0.5,
      profile_meta: {
        statsEvidence: {
          importedTrackCount: 20,
          semanticTrackCount: 20,
          feedbackTrackCount: 0,
          positiveEventCount: 0,
          eraImportedCount: 20,
          eraBehaviorCount: 0,
          energyImportedCount: 20,
          energyBehaviorCount: 0,
          tempoImportedCount: 20,
          tempoBehaviorCount: 0,
          sceneEventCount: 0,
        },
      },
    }
    const withBehavior: TasteProfile = {
      ...importedOnly,
      profile_meta: {
        statsEvidence: {
          ...importedOnly.profile_meta!.statsEvidence!,
          feedbackTrackCount: 1,
        },
      },
    }
    const stableBehavior: TasteProfile = {
      ...importedOnly,
      profile_meta: {
        statsEvidence: {
          ...importedOnly.profile_meta!.statsEvidence!,
          feedbackTrackCount: 1,
          positiveEventCount: 3,
          energyBehaviorCount: 3,
          tempoBehaviorCount: 3,
        },
      },
    }

    expect(listeningTestHelpers.hasVoiceBehaviorEvidence(importedOnly)).toBe(false)
    expect(listeningTestHelpers.hasVoiceBehaviorEvidence(withBehavior)).toBe(false)
    expect(listeningTestHelpers.hasVoiceBehaviorEvidence(stableBehavior)).toBe(true)
    expect(listeningTestHelpers.voiceTopArtistIntro(importedOnly)).toBe('你的歌单里有不少王菲，')
    expect(listeningTestHelpers.voiceTopArtistIntro(withBehavior)).toBe('你的歌单里有不少王菲，')
    expect(listeningTestHelpers.voiceTopArtistIntro(stableBehavior)).toBe('你之前听过不少王菲，')
  })

  it('marks returned listening tracks as voice-owned playback context', () => {
    const track: Track = { title: '主角', artist: '王菲', source: 'netease' }

    const marked = listeningTestHelpers.withVoiceSourceContext(track)

    expect(marked.sourceContext).toBe('voice')
    expect(marked.reason).toBe('回声里 Echo 想到的这首。')
  })

  it('keeps existing listening track reason when marking voice ownership', () => {
    const track: Track = { title: '主角', artist: '王菲', source: 'netease', reason: '先听这一首。' }

    const marked = listeningTestHelpers.withVoiceSourceContext(track)

    expect(marked.sourceContext).toBe('voice')
    expect(marked.reason).toBe('先听这一首。')
  })
})
