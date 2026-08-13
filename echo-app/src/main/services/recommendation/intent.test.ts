import { afterEach, describe, expect, it } from 'vitest'
import type { TasteProfile, Track, TrackSemantic } from '../../../types/ipc'
import { recommendationTestHelpers } from '../recommendation'
import { tasteTestHelpers } from '../taste'
import { mergeIntent, parseIntent, validateIntentOverride } from './intent'
import { musicSearchTestHelpers } from '../../skills/music/search'
import { clearMusicCorrectionMemory, currentMusicCorrectionConstraint, rememberMusicCorrection } from '../../skills/music/correctionMemory'
import { recommendationRecallTestHelpers } from './recall'
import { allowsArtistFromCorrection, allowsTrackFromMemoryConstraints, buildRecommendationMemoryConstraints, recommendationMemoryConstraintScore } from './memoryConstraints'
import { scoreCandidateForTest, type DirectionMemoryItem } from './scoring'

afterEach(() => {
  clearMusicCorrectionMemory()
})

describe('recommendation intent entity inference boundaries', () => {
  it('does not infer artist or title from scene prompts when entity inference is disabled', () => {
    const prompt = '有点犯困,帮我找几首提神但别太炸的歌。'
    const parsed = parseIntent(prompt, { inferEntities: false })
    const override = validateIntentOverride(prompt, { targetCount: 5 }, { inferEntities: false })

    expect(parsed.artistQuery).toBeUndefined()
    expect(parsed.seedTitle).toBeUndefined()
    expect(override?.artistQuery).toBeUndefined()
    expect(override?.seedTitle).toBeUndefined()
  })

  it('keeps normal direct song parsing enabled by default', () => {
    const parsed = parseIntent('我要听王菲的主角')
    expect(parsed.artistQuery).toBe('王菲')
    expect(parsed.seedTitle).toBe('主角')
  })

  it('extracts a short described song title from natural listening wording', () => {
    const parsed = parseIntent('最近枪火这首歌蛮火的，听听看')

    expect(parsed.seedTitle).toBe('枪火')
    expect(parsed.artistQuery).toBeUndefined()
  })

  it('extracts a short described song title when surrounding wording has typos', () => {
    const parsed = parseIntent('最近枪火这首歌蛮义的，听听看')

    expect(parsed.seedTitle).toBe('枪火')
    expect(parsed.artistQuery).toBeUndefined()
  })

  it('removes Chinese question suffixes from artist names', () => {
    const parsed = parseIntent('陈默之有哪些歌适合现在听')
    expect(parsed.artistQuery).toBe('陈默之')
    expect(parsed.seedTitle).toBeUndefined()
  })

  it('extracts explicit song preference with noisy Chinese suffix', () => {
    const parsed = parseIntent('王菲的主角这个首歌，我还蛮喜欢听的')
    expect(parsed.artistQuery).toBe('王菲')
    expect(parsed.seedTitle).toBe('主角')
  })

  it('extracts unquoted explicit song preference without playback action', () => {
    const parsed = parseIntent('我喜欢陈奕迅的冷夜')
    expect(parsed.artistQuery).toBe('陈奕迅')
    expect(parsed.seedTitle).toBe('冷夜')
  })

  it('keeps broad artist details out of song title extraction', () => {
    const voice = parseIntent('我喜欢陈奕迅的声音')
    expect(voice.seedTitle).toBeUndefined()

    const songs = parseIntent('我喜欢陈奕迅的歌')
    expect(songs.seedTitle).toBeUndefined()
    expect(songs.artistQuery).toBe('陈奕迅')
  })

  it('extracts artists from colloquial arrange wording', () => {
    for (const [text, artist] of [
      ['给我安排一首陈奕迅', '陈奕迅'],
      ['整一首周杰伦', '周杰伦'],
      ['搞一首王菲吧', '王菲'],
    ] as const) {
      const parsed = parseIntent(text)

      expect(parsed.artistQuery).toBe(artist)
      expect(parsed.seedTitle).toBeUndefined()
      expect(parsed.targetCount).toBe(1)
    }
  })

  it('turns artist latest and popularity wording into deterministic ranking intents', () => {
    const latest = parseIntent('听听陈默之的最新几首歌')
    const popular = parseIntent('那你随便推荐几首热度高的')

    expect(latest).toMatchObject({ artistQuery: '陈默之', targetCount: 3, ranking: 'latest' })
    expect(popular).toMatchObject({ targetCount: 3, ranking: 'popular' })
  })

  it('orders latest artist candidates by full publish time and preserves hot source order', () => {
    const tracks: Track[] = [
      { title: '旧歌', artist: '陈默之', publishedAt: '2025-01-03T00:00:00.000Z' },
      { title: '新歌', artist: '陈默之', publishedAt: '2026-08-01T00:00:00.000Z' },
      { title: '未知时间', artist: '陈默之' },
    ]
    const latestIntent = parseIntent('陈默之最新的歌')
    const popularIntent = parseIntent('陈默之热度高的歌')

    expect(recommendationTestHelpers.orderedArtistCandidates(tracks, latestIntent, 'seed').map((track) => track.title))
      .toEqual(['新歌', '旧歌', '未知时间'])
    expect(recommendationTestHelpers.orderedArtistCandidates(tracks, popularIntent, 'seed').map((track) => track.title))
      .toEqual(['旧歌', '新歌', '未知时间'])
  })

  it('fills an artist request from lower-priority pools without displacing fresher candidates', () => {
    const fresh: Track[] = [{ id: 'fresh', title: '全新候选', artist: '陈默之' }]
    const withoutHardCooldown: Track[] = [
      { id: 'recent', title: '近期推荐过', artist: '陈默之' },
      ...fresh,
    ]
    const allCandidates: Track[] = [
      { id: 'hard', title: '最终兜底', artist: '陈默之' },
      ...withoutHardCooldown,
    ]
    const intent = parseIntent('推荐10首陈默之热度高的歌')

    const merged = recommendationTestHelpers.mergeOrderedArtistCandidatePools(
      [fresh, withoutHardCooldown, allCandidates],
      intent,
      'seed',
    )

    expect(merged.map((track) => track.title)).toEqual(['全新候选', '近期推荐过', '最终兜底'])
  })

  it('keeps colloquial vague discovery wording out of artist extraction', () => {
    const parsed = parseIntent('给我整点好听的')

    expect(parsed.artistQuery).toBeUndefined()
    expect(parsed.seedTitle).toBeUndefined()
  })

  it('maps 激情 to a high-energy fast recommendation intent', () => {
    const parsed = parseIntent('这首歌不好听，换一首激情一点的')
    expect(parsed.energy).toBe('high')
    expect(parsed.tempo).toBe('fast')
    expect(parsed.moods).toContain('热烈')
    expect(parsed.rejectIf?.minEnergy).toBeGreaterThanOrEqual(0.55)
  })

  it('maps warm companionship wording to a low-energy healing intent', () => {
    const parsed = parseIntent('我有点冷，来点暖一点的')

    expect(parsed.energy).toBe('low')
    expect(parsed.tempo).toBe('slow')
    expect(parsed.moods).toContain('治愈')
    expect(parsed.moods).toContain('陪伴')
    expect(parsed.rejectIf?.maxEnergy).toBeLessThanOrEqual(0.78)
    expect(parsed.rejectIf?.forbidTempo).toContain('fast')
  })

  it('extracts an unquoted reference title from a similarity request', () => {
    const parsed = parseIntent('类似大鱼海棠这首歌的歌曲推荐下')

    expect(parsed.seedTitle).toBe('大鱼海棠')
    expect(parsed.artistQuery).toBeUndefined()
  })

  it('extracts artist and title from a quoted similarity request', () => {
    const parsed = parseIntent('推荐几首像周深《大鱼》这样的歌')

    expect(parsed.artistQuery).toBe('周深')
    expect(parsed.seedTitle).toBe('大鱼')
    expect(parsed.targetCount).toBe(3)
  })

  it('does not turn a contextual similarity reference into a song title', () => {
    const parsed = parseIntent('像刚才那首再来一首')

    expect(parsed.seedTitle).toBeUndefined()
    expect(parsed.artistQuery).toBeUndefined()
  })

  it('supports authoritative entity removal from an LLM route', () => {
    const base = parseIntent('我要听陈奕迅的歌曲吧')
    const merged = mergeIntent(base, {
      artistQuery: '陈奕迅',
      clearSeedTitle: true,
    })

    expect(merged.artistQuery).toBe('陈奕迅')
    expect(merged.seedTitle).toBeUndefined()
  })

  it('does not restore a cleared entity during override validation', () => {
    const override = validateIntentOverride('我要听陈奕迅的歌曲吧', {
      artistQuery: '陈奕迅',
      clearSeedTitle: true,
    })

    expect(override?.artistQuery).toBe('陈奕迅')
    expect(override?.seedTitle).toBeUndefined()
    expect(override?.clearSeedTitle).toBe(true)
  })

  it('preserves an explicit semantic wantsMusic decision for chat routing', () => {
    const override = validateIntentOverride(
      '王菲的主角这首歌我喜欢',
      { wantsMusic: false },
      { inferEntities: false, preserveWantsMusic: true },
    )

    expect(override?.wantsMusic).toBe(false)
  })

  it('removes rejected rule entities before Netease verification', () => {
    const resolution = musicSearchTestHelpers.resolutionWithIntentOverride({
      artistQuery: '陈奕迅',
      seedTitle: '歌曲吧',
      targetCount: 1,
      requestedCount: 1,
      explicitCount: false,
      entities: [
        { kind: 'artist', text: '陈奕迅', sourceSpan: '陈奕迅', confidence: 0.9, source: 'rules' },
        { kind: 'title', text: '歌曲吧', sourceSpan: '歌曲吧', confidence: 0.7, source: 'rules' },
      ],
      ambiguity: 'none',
      confidence: 0.8,
      source: 'rules',
    }, {
      artistQuery: '陈奕迅',
      clearSeedTitle: true,
      intentConfidence: 0.96,
    })

    expect(resolution.artistQuery).toBe('陈奕迅')
    expect(resolution.seedTitle).toBeUndefined()
    expect(resolution.entities.some((entity) => entity.kind === 'title')).toBe(false)
  })

  it('replaces conflicting rule entities when the chat route is authoritative', () => {
    const resolution = musicSearchTestHelpers.resolutionWithIntentOverride({
      artistQuery: '歌曲吧',
      targetCount: 1,
      requestedCount: 1,
      explicitCount: false,
      entities: [
        { kind: 'artist', text: '歌曲吧', sourceSpan: '歌曲吧', confidence: 0.6, source: 'rules' },
      ],
      ambiguity: 'artist_or_title',
      confidence: 0.6,
      source: 'rules',
    }, {
      artistQuery: '陈奕迅',
      intentConfidence: 0.96,
    }, true)

    expect(resolution.artistQuery).toBe('陈奕迅')
    expect(resolution.entities.filter((entity) => entity.kind === 'artist')).toEqual([
      expect.objectContaining({ text: '陈奕迅', source: 'llm' }),
    ])
    expect(resolution.ambiguity).toBe('none')
  })

  it('uses the current track only for contextual similarity requests', () => {
    const current = {
      id: 'current',
      title: '当前歌曲',
      artist: '当前歌手',
    }
    const contextual = musicSearchTestHelpers.selectSimilarityReference({
      explicitCount: false,
      entities: [],
      ambiguity: 'none',
      confidence: 0,
      source: 'rules',
      verificationStatus: 'not_needed',
    }, current)
    const namedArtist = musicSearchTestHelpers.selectSimilarityReference({
      artistQuery: '陈奕迅',
      explicitCount: false,
      entities: [],
      ambiguity: 'none',
      confidence: 0.9,
      source: 'llm',
      verificationStatus: 'verified',
    }, current)

    expect(contextual).toBe(current)
    expect(namedArtist).toBeUndefined()
  })

  it('preserves an artist as a similarity recall seed without treating it as a track reference', () => {
    const entities = {
      artistQuery: '陈奕迅',
      verifiedArtistName: '陈奕迅',
      explicitCount: false,
      entities: [],
      ambiguity: 'none' as const,
      confidence: 0.94,
      source: 'netease' as const,
      verificationStatus: 'verified' as const,
    }

    expect(musicSearchTestHelpers.selectSimilarityReference(entities)).toBeUndefined()
    expect(musicSearchTestHelpers.selectSimilarityArtistQuery(entities)).toBe('陈奕迅')
  })

  it('changes the recommendation cache namespace when explicit taste memory changes', () => {
    const profile = {
      artists: [{ name: '陈奕迅', affinity: 0.7 }],
      genres: [{ name: '流行', weight: 0.6, trend: 'steady' }],
      moods: [{ tag: '陪伴', frequency: 0.5 }],
      discovery_appetite: 0.5,
      anti_patterns: [],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const updated = {
      ...profile,
      anti_patterns: ['不喜欢:某歌手 某歌曲'],
    } satisfies TasteProfile

    expect(recommendationTestHelpers.tasteProfileFingerprint(profile))
      .not.toBe(recommendationTestHelpers.tasteProfileFingerprint(updated))
  })

  it('changes the recommendation cache namespace when session music correction changes', () => {
    const intent = parseIntent('我要听Nicky Youre的Part Time Lover')
    const determinism = { daySeed: '2026-06-22' }
    const before = recommendationTestHelpers.buildCacheKey(intent, determinism, undefined, undefined, undefined, null)
    const currentTrack: Track = {
      id: 'wrong-track',
      neteaseId: 'wrong-track',
      title: 'Part-Time Lover',
      artist: 'Dabin / Claire Ridgely',
      source: 'netease',
    }

    rememberMusicCorrection({
      text: '不是Dabin那版，我要的是Nicky Youre的《Part Time Lover》',
      currentTrack,
      fallbackTitle: 'Part Time Lover',
    })

    expect(recommendationTestHelpers.buildCacheKey(intent, determinism, undefined, undefined, undefined, null))
      .not.toBe(before)
  })

  it('changes the recommendation cache namespace when trusted memory corrections change', () => {
    const intent = parseIntent('推荐一首适合现在听的歌')
    const determinism = { daySeed: '2026-06-22' }
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: [],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const beforeConstraints = buildRecommendationMemoryConstraints(profile, [])
    const afterConstraints = buildRecommendationMemoryConstraints(profile, [
      { kind: 'correction', content: '最近更想听轻快一点。', weight: 0.9, createdAt: '2026-06-22T10:00:00.000Z' },
    ])
    const before = recommendationTestHelpers.buildCacheKey(intent, determinism, undefined, undefined, undefined, profile, beforeConstraints)
    const after = recommendationTestHelpers.buildCacheKey(intent, determinism, undefined, undefined, undefined, profile, afterConstraints)

    expect(recommendationTestHelpers.memoryConstraintsFingerprint(beforeConstraints))
      .not.toBe(recommendationTestHelpers.memoryConstraintsFingerprint(afterConstraints))
    expect(after).not.toBe(before)
  })

  it('extracts explicit replacement artist and title from mixed current-track rejection', () => {
    const currentTrack: Track = {
      id: 'wrong-track',
      title: '沉溺',
      artist: '陈默之',
      source: 'netease',
    }

    rememberMusicCorrection({
      text: '这首歌不好听，我要听王菲的主角',
      currentTrack,
      fallbackTitle: currentTrack.title,
    })

    expect(currentMusicCorrectionConstraint()).toMatchObject({
      artistQuery: '王菲',
      seedTitle: '主角',
    })
  })

  it('penalizes candidates that match explicit anti patterns', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: ['周杰伦', '不喜欢:陈默之 沉溺'],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const intent = parseIntent('推荐一首歌')

    expect(recommendationMemoryConstraintScore({ title: '晴天', artist: '周杰伦' }, intent, constraints)).toBeLessThanOrEqual(-6)
    expect(recommendationMemoryConstraintScore({ title: '沉溺', artist: '陈默之' }, intent, constraints)).toBeLessThanOrEqual(-6)
    expect(recommendationMemoryConstraintScore({ title: '主角', artist: '王菲' }, intent, constraints)).toBe(0)
  })

  it('allows an explicit user request to override anti-pattern penalties', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: ['周杰伦'],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const genericIntent = parseIntent('推荐一首歌')
    const explicitIntent = parseIntent('我要听周杰伦的晴天')

    expect(recommendationMemoryConstraintScore({ title: '晴天', artist: '周杰伦' }, genericIntent, constraints)).toBeLessThan(0)
    expect(recommendationMemoryConstraintScore({ title: '晴天', artist: '周杰伦' }, explicitIntent, constraints)).toBe(0)
  })

  it('hard-filters explicit anti patterns unless the user asks for that exact direction', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: ['不喜欢:陈默之 沉溺', '电子音墙'],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const genericIntent = parseIntent('推荐一首歌')
    const explicitIntent = parseIntent('我要听陈默之的沉溺')
    const dislikedTrack: Track = { title: '沉溺', artist: '陈默之' }
    const dislikedStyle: Track = {
      title: '夜间电流',
      artist: '某歌手',
      semantic: {
        language: '华语',
        genres: ['电子音墙'],
        moods: ['压抑'],
        scenes: ['夜晚'],
        energy: 0.8,
        tempo: 'fast',
        familiarity: 'explore',
        confidence: 0.8,
      },
    }

    expect(allowsTrackFromMemoryConstraints(dislikedTrack, genericIntent, constraints)).toBe(false)
    expect(allowsTrackFromMemoryConstraints(dislikedStyle, genericIntent, constraints)).toBe(false)
    expect(allowsTrackFromMemoryConstraints(dislikedTrack, explicitIntent, constraints)).toBe(true)
  })

  it('turns natural profile corrections into recommendation constraints', () => {
    const profile = {
      artists: [{ name: '周杰伦', affinity: 0.7 }],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: [],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [
      { kind: 'correction', content: '我不是一直喜欢周杰伦，只是那几天刚好听得多。', weight: 0.8 },
      { kind: 'correction', content: '别总说我爱听悲伤的歌，最近我想轻快一点。', weight: 0.8 },
    ])
    const intent = parseIntent('推荐一首歌')
    const sadTrack: Track = {
      title: '雨夜',
      artist: '别的歌手',
      source: 'netease',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['悲伤'],
        scenes: ['夜晚'],
        energy: 0.3,
        tempo: 'slow',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }

    expect(recommendationMemoryConstraintScore({ title: '晴天', artist: '周杰伦' }, intent, constraints)).toBeLessThan(0)
    expect(recommendationMemoryConstraintScore(sadTrack, intent, constraints)).toBeLessThan(0)
  })

  it('keeps recent correction block terms ahead of older anti-pattern overflow', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: Array.from({ length: 12 }, (_, index) => `旧规避${index + 1}`),
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [
      { kind: 'correction', content: '少推电子音墙，我现在听这个会烦。', weight: 0.9 },
    ])
    const intent = parseIntent('推荐一首歌')
    const blockedTrack: Track = {
      title: '夜间电流',
      artist: '某歌手',
      semantic: {
        language: '华语',
        genres: ['电子音墙'],
        moods: ['压迫'],
        scenes: ['夜晚'],
        energy: 0.85,
        tempo: 'fast',
        familiarity: 'explore',
        confidence: 0.8,
      },
    }

    expect(constraints.blockedTerms).toContain('电子音墙')
    expect(allowsTrackFromMemoryConstraints(blockedTrack, intent, constraints)).toBe(false)
  })

  it('lets later explicit positive direction memory override older correction blocks', () => {
    const positiveAt = new Date().toISOString()
    const correctionAt = new Date(Date.now() - 86400000).toISOString()
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: [],
      signature_tracks: [],
      echo_portrait: '',
      profile_meta: {
        incrementalSignals: [
          { kind: 'like_genre', target: '电子音墙', strength: 0.08, updatedAt: positiveAt },
        ],
      },
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [
      { kind: 'correction', content: '少推电子音墙，我之前听这个会烦。', weight: 0.9, createdAt: correctionAt },
    ])
    const intent = parseIntent('推荐一首歌')
    const track: Track = {
      title: '夜间电流',
      artist: '某歌手',
      semantic: {
        language: '华语',
        genres: ['电子音墙'],
        moods: ['压迫'],
        scenes: ['夜晚'],
        energy: 0.85,
        tempo: 'fast',
        familiarity: 'explore',
        confidence: 0.8,
      },
    }

    expect(constraints.blockedTerms).not.toContain('电子音墙')
    expect(allowsTrackFromMemoryConstraints(track, intent, constraints)).toBe(true)
    expect(recommendationMemoryConstraintScore(track, intent, constraints)).toBe(0)
  })

  it('lets a later favorite override an older track-level correction block', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: [],
      signature_tracks: [{ title: '沉溺', artist: '陈默之', source: 'favorite' }],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [
      { kind: 'correction', content: '我不喜欢陈默之《沉溺》，少推一点。', weight: 0.9, createdAt: '2026-06-01T08:00:00.000Z' },
    ])
    const intent = parseIntent('推荐一首歌')

    expect(constraints.blockedTerms).not.toContain('陈默之沉溺')
    expect(allowsTrackFromMemoryConstraints({ title: '沉溺', artist: '陈默之' }, intent, constraints)).toBe(true)
  })

  it('lets an explicit direct-song request override previous negative direction memory for that track', () => {
    const semantic: TrackSemantic = {
      language: '华语',
      genres: ['流行'],
      moods: ['陪伴'],
      scenes: ['夜晚'],
      energy: 0.42,
      tempo: 'medium',
      familiarity: 'safe',
      confidence: 0.9,
    }
    const track: Track = {
      id: 'track-chenmozhi-chenni',
      title: '沉溺',
      artist: '陈默之',
      source: 'netease',
      semantic,
    }
    const memory: DirectionMemoryItem[] = [{
      action: 'not_right',
      semantic,
      artist: '陈默之',
      trackKey: 'track-chenmozhi-chenni',
      weight: 1,
    }]
    const explicitIntent = parseIntent('我要听陈默之的沉溺')
    const genericIntent = parseIntent('推荐一首歌')

    expect(scoreCandidateForTest(track, explicitIntent, new Set(), memory))
      .toBe(scoreCandidateForTest(track, explicitIntent, new Set(), []))
    expect(scoreCandidateForTest(track, genericIntent, new Set(), memory))
      .toBeLessThan(scoreCandidateForTest(track, genericIntent, new Set(), []))
  })

  it('keeps skipped-track anti patterns scoped to artist and title', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: ['跳过:周杰伦 晴天'],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const intent = parseIntent('推荐一首歌')

    expect(recommendationMemoryConstraintScore({ title: '晴天', artist: '周杰伦' }, intent, constraints)).toBeLessThan(0)
    expect(recommendationMemoryConstraintScore({ title: '晴天', artist: '别的歌手' }, intent, constraints)).toBe(0)
  })

  it('soft-penalizes explicit miss direction memory without hard-filtering broad styles', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: ['少推:安静', '少推:流行'],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const intent = parseIntent('推荐一首歌')
    const track: Track = {
      title: '夜风',
      artist: '某歌手',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['安静'],
        scenes: ['夜晚'],
        energy: 0.3,
        tempo: 'slow',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }

    expect(constraints.softenedTerms).toEqual(['安静', '流行'])
    expect(allowsTrackFromMemoryConstraints(track, intent, constraints)).toBe(true)
    expect(recommendationMemoryConstraintScore(track, intent, constraints)).toBeLessThan(0)
  })

  it('lets later positive feedback clear matching soft direction memory', () => {
    expect(tasteTestHelpers.filterAntiPatternsForPositiveSignal(
      ['少推:安静', '少推:流行', '不喜欢:陈默之 沉溺'],
      { kind: 'reinforce_vibe', target: '安静' },
    )).toEqual(['少推:流行', '不喜欢:陈默之 沉溺'])
    expect(tasteTestHelpers.filterAntiPatternsForPositiveSignal(
      ['少推:安静', '少推:流行', '不喜欢:陈默之 沉溺'],
      { kind: 'like_genre', target: '流行' },
    )).toEqual(['少推:安静', '不喜欢:陈默之 沉溺'])
  })

  it('blocks artist recall for artist-level anti patterns without blocking track-level misses', () => {
    const profile = {
      artists: [{ name: '周杰伦', affinity: 0.8 }, { name: '陈默之', affinity: 0.7 }],
      genres: [],
      moods: [],
      discovery_appetite: 0.5,
      anti_patterns: ['周杰伦', '不喜欢:陈默之 沉溺'],
      signature_tracks: [],
      echo_portrait: '',
    } satisfies TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const genericIntent = parseIntent('推荐一首歌')
    const explicitIntent = parseIntent('我想听周杰伦的歌')

    expect(allowsArtistFromCorrection('周杰伦', genericIntent, constraints)).toBe(false)
    expect(allowsArtistFromCorrection('周杰伦', explicitIntent, constraints)).toBe(true)
    expect(allowsArtistFromCorrection('陈默之', genericIntent, constraints)).toBe(true)
  })

  it('normalizes impossible energy and tempo constraints during intent merge', () => {
    const merged = mergeIntent(parseIntent('推荐一首歌'), {
      rejectIf: {
        minEnergy: 0.9,
        maxEnergy: 0.2,
        forbidTempo: ['fast', 'slow'],
        requireTempo: ['fast'],
      },
    })

    expect(merged.rejectIf?.minEnergy).toBeUndefined()
    expect(merged.rejectIf?.maxEnergy).toBeUndefined()
    expect(merged.rejectIf?.forbidTempo).toEqual(['slow'])
    expect(merged.rejectIf?.requireTempo).toEqual(['fast'])
  })

  it('keeps scene candidate-pool searches from falling back to cooled tracks', () => {
    const sceneIntent = { ...parseIntent('安静一点'), sceneKey: 'focus' as const }

    expect(recommendationTestHelpers.shouldAllowCooldownFallback(sceneIntent)).toBe(true)
    expect(recommendationTestHelpers.shouldAllowCooldownFallback(sceneIntent, { respectCooldown: true })).toBe(false)
  })

  it('treats candidate-pool size as a maximum instead of a minimum result count', () => {
    const fresh = ['fresh-1', 'fresh-2', 'fresh-3', 'fresh-4', 'fresh-5']
    const cooled = [...fresh, 'cooled-1']

    expect(recommendationTestHelpers.selectCandidatePool(fresh, cooled, [], 5)).toBe(fresh)
    expect(recommendationTestHelpers.selectCandidatePool(fresh.slice(0, 3), cooled, [], 5)).toBe(cooled)
    expect(recommendationTestHelpers.selectCandidatePool(fresh.slice(0, 3), [], [], 5)).toEqual(fresh.slice(0, 3))
  })

  it('extracts related artist ids while excluding the reference artist', () => {
    const ids = recommendationRecallTestHelpers.extractSimilarArtistIds({
      body: {
        artists: [
          { id: 1, name: '参照艺人' },
          { id: 2, name: '相关艺人 A' },
          { id: 3, name: '相关艺人 B' },
        ],
      },
    }, '1')

    expect(ids).toEqual(['2', '3'])
  })
})
