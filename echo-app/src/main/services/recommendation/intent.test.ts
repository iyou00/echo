import { describe, expect, it } from 'vitest'
import { parseIntent, validateIntentOverride } from './intent'

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

  it('extracts explicit song preference with noisy Chinese suffix', () => {
    const parsed = parseIntent('王菲的主角这个首歌，我还蛮喜欢听的')
    expect(parsed.artistQuery).toBe('王菲')
    expect(parsed.seedTitle).toBe('主角')
  })

  it('maps 激情 to a high-energy fast recommendation intent', () => {
    const parsed = parseIntent('这首歌不好听，换一首激情一点的')
    expect(parsed.energy).toBe('high')
    expect(parsed.tempo).toBe('fast')
    expect(parsed.moods).toContain('热烈')
    expect(parsed.rejectIf?.minEnergy).toBeGreaterThanOrEqual(0.55)
  })
})
