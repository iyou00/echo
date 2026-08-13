import { describe, expect, it } from 'vitest'
import { normalizeProfileMoodFilter, profileChangeSectionCopy, profileEnergyLine, profileItemIsPositiveDisplaySignal, profileSignatureItemVisible, profileTrendLines, profileWeightDisplay, tempoPreferenceDisplay } from './echoProfileDisplay'

describe('EchoProfile display math', () => {
  it('keeps genre percentages aligned with profile weights', () => {
    expect(profileWeightDisplay(0.24)).toMatchObject({
      value: 24,
      label: '24%',
      bar: 24,
    })
    expect(profileWeightDisplay(24)).toMatchObject({
      value: 24,
      label: '24%',
      bar: 24,
    })
  })

  it('keeps tiny positive profile weights visible without inflating the label', () => {
    expect(profileWeightDisplay(0.004)).toMatchObject({
      value: 0,
      label: '<1%',
      bar: 3,
    })
  })

  it('normalizes accumulated tempo weights for display', () => {
    expect(tempoPreferenceDisplay({ slow: 2, medium: 1, fast: 1 }).map((entry) => ({
      tempo: entry.tempo,
      label: entry.label,
      bar: entry.bar,
    }))).toEqual([
      { tempo: 'slow', label: '50%', bar: 50 },
      { tempo: 'medium', label: '25%', bar: 25 },
      { tempo: 'fast', label: '25%', bar: 25 },
    ])
  })

  it('ignores invalid tempo weights instead of leaking them into the profile UI', () => {
    expect(tempoPreferenceDisplay({ slow: -1, medium: Number.NaN, fast: 0.5 })).toMatchObject([
      { tempo: 'fast', label: '100%', bar: 100 },
    ])
  })

  it('labels energy trend source by evidence stage', () => {
    expect(profileEnergyLine('偏高能', {
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
    })).toBe('歌单能量：偏高能')

    expect(profileEnergyLine('偏高能', {
      importedTrackCount: 20,
      semanticTrackCount: 20,
      feedbackTrackCount: 1,
      positiveEventCount: 1,
      eraImportedCount: 20,
      eraBehaviorCount: 1,
      energyImportedCount: 20,
      energyBehaviorCount: 1,
      tempoImportedCount: 20,
      tempoBehaviorCount: 1,
      sceneEventCount: 1,
    })).toBe('行为能量：偏高能')

    expect(profileEnergyLine('偏高能', {
      importedTrackCount: 20,
      semanticTrackCount: 20,
      feedbackTrackCount: 4,
      positiveEventCount: 4,
      eraImportedCount: 20,
      eraBehaviorCount: 4,
      energyImportedCount: 20,
      energyBehaviorCount: 4,
      tempoImportedCount: 20,
      tempoBehaviorCount: 4,
      sceneEventCount: 4,
    })).toBe('最近能量：偏高能')
  })

  it('keeps imported-only trend lines out of recent wording', () => {
    const lines = profileTrendLines(
      [{ name: '华语流行', trend: 'up', source: 'semantic', evidenceLevel: 'medium' }],
      {
        evidence: {
          importedTrackCount: 12,
          semanticTrackCount: 12,
          feedbackTrackCount: 0,
          positiveEventCount: 0,
          eraImportedCount: 12,
          eraBehaviorCount: 0,
          energyImportedCount: 12,
          energyBehaviorCount: 0,
          tempoImportedCount: 12,
          tempoBehaviorCount: 0,
          sceneEventCount: 0,
        },
        energyLine: profileEnergyLine('中等能量', {
          importedTrackCount: 12,
          semanticTrackCount: 12,
          feedbackTrackCount: 0,
          positiveEventCount: 0,
          eraImportedCount: 12,
          eraBehaviorCount: 0,
          energyImportedCount: 12,
          energyBehaviorCount: 0,
          tempoImportedCount: 12,
          tempoBehaviorCount: 0,
          sceneEventCount: 0,
        }),
      },
    )

    expect(lines).toEqual(['歌单线索：华语流行', '歌单能量：中等能量'])
  })

  it('uses evidence-aware copy for the profile change section', () => {
    expect(profileChangeSectionCopy(false)).toMatchObject({
      label: '初始线索',
    })
    expect(profileChangeSectionCopy(false).emptyText).toContain('导入和语义线索')
    expect(profileChangeSectionCopy(true)).toMatchObject({
      label: '最近变化',
    })
    expect(profileChangeSectionCopy(true).emptyText).toContain('播放、收藏和切歌')
  })

  it('keeps explicit misses out of visible signature tracks', () => {
    expect(profileSignatureItemVisible({
      track: { title: '沉溺', artist: '陈默之', reason: '主动标记不太合适 1 次。' },
      note: '主动标记不太合适 1 次。',
      evidenceLevel: 'medium',
      source: 'explicit_miss',
    })).toBe(false)

    expect(profileSignatureItemVisible({
      track: { title: '红豆', artist: '王菲', reason: '来自收藏' },
      note: '来自收藏',
      evidenceLevel: 'strong',
      source: 'favorite',
    })).toBe(true)
  })

  it('keeps explicit misses out of positive profile sections', () => {
    expect(profileItemIsPositiveDisplaySignal({
      evidenceLevel: 'strong',
      source: 'explicit_miss',
    })).toBe(false)
    expect(profileItemIsPositiveDisplaySignal({
      evidenceLevel: 'medium',
      source: 'played',
    })).toBe(true)
  })

  it('returns to all songs when a refreshed profile no longer has the selected mood', () => {
    expect(normalizeProfileMoodFilter('晚上工作', ['晚上工作', '回家路上'])).toBe('晚上工作')
    expect(normalizeProfileMoodFilter('晚上工作', ['放松发呆', '回家路上'])).toBe('all')
  })
})
