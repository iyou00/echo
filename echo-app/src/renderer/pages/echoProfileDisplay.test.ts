import { describe, expect, it } from 'vitest'
import {
  ERA_SCALE,
  eraNeedleLeft,
  findPortraitClueMatch,
  hasProfileBehaviorEvidence,
  profileChangeSectionCopy,
  profileBehaviorEvidenceCount,
  profileEvidenceSourceLabel,
  profileItemHasBehaviorEvidence,
  profileItemHasUserActionEvidence,
  profileItemIsPositiveDisplaySignal,
  profileMoodLine,
  profileSummaryCardMeta,
  profileTrendLines,
  tempoPreferenceDisplay,
  type ProfileStatsEvidence,
} from './echoProfileDisplay'

const importedOnlyEvidence: ProfileStatsEvidence = {
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
}

describe('echo profile display helpers', () => {
  it('keeps every taste era bucket addressable by the tuner', () => {
    expect(ERA_SCALE).toEqual(['70s', '80s', '90s', '00s', '10s', '20s'])
    expect(eraNeedleLeft('70s')).toBe('0%')
    expect(eraNeedleLeft('20s')).toBe('100%')
  })

  it('falls back to the center when an unknown era appears', () => {
    expect(eraNeedleLeft('60s')).toBe('50%')
  })

  it('normalizes tempo preference values into display percentages', () => {
    expect(tempoPreferenceDisplay({ slow: 2, medium: 1, fast: 1 }).map((item) => ({
      tempo: item.tempo,
      label: item.label,
    }))).toEqual([
      { tempo: 'slow', label: '50%' },
      { tempo: 'medium', label: '25%' },
      { tempo: 'fast', label: '25%' },
    ])
  })

  it('uses imported-only wording when genre trends have no behavior evidence', () => {
    expect(profileTrendLines([
      { name: '华语流行', trend: 'up', source: 'semantic', evidenceLevel: 'medium' },
      { name: '电子', trend: 'down', source: 'semantic', evidenceLevel: 'medium' },
    ], { evidence: importedOnlyEvidence })).toEqual(['歌单线索：华语流行'])
  })

  it('uses recent wording when genre trends have playback or feedback evidence', () => {
    expect(profileTrendLines([
      { name: '摇滚', trend: 'up', source: 'played', evidenceLevel: 'strong' },
      { name: '民谣', trend: 'down', source: 'explicit_miss', evidenceLevel: 'medium' },
    ], {
      evidence: {
        ...importedOnlyEvidence,
        feedbackTrackCount: 1,
      },
    })).toEqual(['最近更明显：摇滚', '最近变少：民谣'])
  })

  it('keeps behavior-backed genre trends in the recent bucket even when evidence is medium', () => {
    expect(profileTrendLines([
      { name: '摇滚', trend: 'up', source: 'played', evidenceLevel: 'medium' },
      { name: '民谣', trend: 'up', source: 'semantic', evidenceLevel: 'medium' },
    ], {
      evidence: {
        ...importedOnlyEvidence,
        feedbackTrackCount: 1,
      },
    })).toEqual(['最近更明显：摇滚', '歌单线索：民谣'])
  })

  it('requires stable behavior evidence before marking the whole profile as behavior-backed', () => {
    const thinBehavior: ProfileStatsEvidence = {
      ...importedOnlyEvidence,
      feedbackTrackCount: 1,
      positiveEventCount: 2,
      eraBehaviorCount: 2,
      energyBehaviorCount: 2,
      tempoBehaviorCount: 2,
      sceneEventCount: 1,
    }
    const stableBehavior: ProfileStatsEvidence = {
      ...thinBehavior,
      positiveEventCount: 3,
      energyBehaviorCount: 3,
      tempoBehaviorCount: 3,
    }

    expect(profileBehaviorEvidenceCount(thinBehavior)).toBe(2)
    expect(hasProfileBehaviorEvidence(thinBehavior)).toBe(false)
    expect(profileBehaviorEvidenceCount(stableBehavior)).toBe(3)
    expect(hasProfileBehaviorEvidence(stableBehavior)).toBe(true)
  })

  it('separates recent genre trends from imported-only genre trends in the same profile', () => {
    expect(profileTrendLines([
      { name: '摇滚', trend: 'up', source: 'played', evidenceLevel: 'strong' },
      { name: '华语流行', trend: 'up', source: 'semantic', evidenceLevel: 'medium' },
      { name: '民谣', trend: 'down', source: 'semantic', evidenceLevel: 'medium' },
    ], {
      evidence: {
        ...importedOnlyEvidence,
        feedbackTrackCount: 2,
      },
    })).toEqual(['最近更明显：摇滚', '歌单线索：华语流行'])
  })

  it('does not describe imported-only mood evidence as recent behavior', () => {
    expect(profileMoodLine([{ tag: '安静', frequency: 0.72, source: 'semantic', evidenceLevel: 'medium' }], importedOnlyEvidence)).toBe('氛围线索：安静')
  })

  it('uses recent mood wording after playback or feedback evidence appears', () => {
    expect(profileMoodLine([{ tag: '热烈', frequency: 0.72, source: 'played', evidenceLevel: 'strong' }], {
      ...importedOnlyEvidence,
      positiveEventCount: 2,
    })).toBe('最近氛围：热烈')
  })

  it('labels summary card metadata with evidence source', () => {
    expect(profileSummaryCardMeta({ source: 'imported', evidenceLevel: 'medium' }, '42%')).toBe('42% · 来自导入歌单')
    expect(profileSummaryCardMeta({ source: 'played', evidenceLevel: 'strong' }, '线索很强')).toBe('线索很强 · 来自播放')
    expect(profileSummaryCardMeta({ source: 'semantic', evidenceLevel: 'medium' }, '70%')).toBe('70% · 语义线索')
    expect(profileSummaryCardMeta({ source: 'explicit_miss', evidenceLevel: 'medium' }, '线索稳定')).toBe('线索稳定 · 不合适线索')
  })

  it('detects behavior evidence per profile item instead of using global profile state', () => {
    expect(profileItemHasBehaviorEvidence({ source: 'imported', evidenceLevel: 'medium' })).toBe(false)
    expect(profileItemHasBehaviorEvidence({ source: 'semantic', evidenceLevel: 'strong' })).toBe(false)
    expect(profileItemHasBehaviorEvidence({ source: 'favorite', evidenceLevel: 'strong' })).toBe(true)
    expect(profileItemHasBehaviorEvidence({ source: 'explicit_miss', evidenceLevel: 'medium' })).toBe(false)
  })

  it('counts explicit misses as user actions for recent-change copy', () => {
    expect(profileItemHasUserActionEvidence({ source: 'imported', evidenceLevel: 'medium' })).toBe(false)
    expect(profileItemHasUserActionEvidence({ source: 'explicit_miss', evidenceLevel: 'medium' })).toBe(true)
    expect(profileChangeSectionCopy(profileItemHasUserActionEvidence({ source: 'explicit_miss', evidenceLevel: 'medium' })).label).toBe('最近变化')
  })

  it('keeps explicit miss evidence out of positive profile display slots', () => {
    expect(profileItemIsPositiveDisplaySignal({ source: 'explicit_miss', evidenceLevel: 'medium' })).toBe(false)
    expect(profileItemIsPositiveDisplaySignal({ source: 'imported', evidenceLevel: 'medium' })).toBe(true)
    expect(profileItemIsPositiveDisplaySignal({ source: 'played', evidenceLevel: 'strong' })).toBe(true)
  })

  it('keeps fallback source labels neutral', () => {
    expect(profileEvidenceSourceLabel({ source: 'fallback', evidenceLevel: 'weak' })).toBe('还在观察')
  })

  it('keeps semantic mood wording even when unrelated behavior evidence exists', () => {
    expect(profileMoodLine([{ tag: '安静', frequency: 0.72, source: 'semantic', evidenceLevel: 'medium' }], {
      ...importedOnlyEvidence,
      feedbackTrackCount: 2,
    })).toBe('氛围线索：安静')
  })

  it('does not promote legacy strong semantic genre evidence into recent behavior', () => {
    expect(profileTrendLines([
      { name: '华语流行', trend: 'up', source: 'semantic', evidenceLevel: 'strong' },
    ], {
      evidence: {
        ...importedOnlyEvidence,
        feedbackTrackCount: 3,
      },
    })).toEqual(['歌单线索：华语流行'])
  })

  it('does not promote legacy strong semantic mood evidence into recent behavior', () => {
    expect(profileMoodLine([{ tag: '安静', frequency: 0.72, source: 'semantic', evidenceLevel: 'strong' }], {
      ...importedOnlyEvidence,
      feedbackTrackCount: 3,
    })).toBe('氛围线索：安静')
  })

  it('does not highlight short generic genre words as portrait evidence', () => {
    expect(findPortraitClueMatch('旋律听起来很流行', [], ['流行'])).toBeNull()
  })

  it('keeps short artist names highlightable in portrait copy', () => {
    expect(findPortraitClueMatch('你会靠近王菲那类声音', ['王菲'], ['华语流行'])).toEqual({
      kind: 'artist',
      name: '王菲',
    })
  })

  it('keeps specific romanized genres highlightable in portrait copy', () => {
    expect(findPortraitClueMatch('R&B 的线条会更明显', [], ['R&B'])).toEqual({
      kind: 'genre',
      name: 'R&B',
    })
  })
})
