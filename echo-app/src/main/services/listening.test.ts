import { describe, expect, it, vi } from 'vitest'
import type { TasteProfile, Track } from '../../types/ipc'
import { listeningTestHelpers } from './listening'

vi.mock('./memoryEvidence', () => ({
  buildMemoryEvidencePrompt: vi.fn(() => '<memory_evidence_contract>\n用户明确纠正是最高优先级证据\n</memory_evidence_contract>\n<user_corrections>\n(暂无明确纠正)\n</user_corrections>\n<profile_memory>\n{"kind":"profile_digest"}\n</profile_memory>'),
}))

describe('listening segment context', () => {
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
    })

    expect(context).toContain('<memory_evidence_contract>')
    expect(context).toContain('<user_corrections>')
    expect(context).toContain('<profile_memory>')
    expect(context).toContain('用户明确纠正是最高优先级证据')
    expect(context).not.toContain('<taste_signals_recent>')
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

  it('uses artist evidence when picking among duplicate song titles', () => {
    const candidates: Track[] = [
      { title: '主角', artist: '未知歌手', source: 'netease' },
      { title: '主角', artist: '王菲', source: 'netease' },
    ]

    const picked = listeningTestHelpers.pickTrackFromText('现在先听王菲的《主角》。你不用认真听，等副歌出来再说。', candidates)

    expect(picked?.artist).toBe('王菲')
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
