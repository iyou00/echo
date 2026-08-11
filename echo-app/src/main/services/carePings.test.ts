import { describe, expect, it } from 'vitest'
import { carePingTestHelpers } from './carePings'

describe('care ping copy boundaries', () => {
  it('rejects office-template notification text', () => {
    expect(carePingTestHelpers.isUnsafeBody('以下是可直接发的通知模板，请把信息补齐。')).toBe(true)
    expect(carePingTestHelpers.isUnsafeBody('通知文案：请把对象、事项、金额发给我。')).toBe(true)
  })

  it('rejects internal portrait and memory language', () => {
    expect(carePingTestHelpers.isUnsafeBody('根据你的画像和数据，这会儿适合听点安静的。')).toBe(true)
    expect(carePingTestHelpers.isUnsafeBody('我看到记忆策略里纠正过这个标签，来提醒你一下。')).toBe(true)
    expect(carePingTestHelpers.isUnsafeBody('我记得你说过不喜欢电子音墙，这会儿先听点安静的。')).toBe(true)
    expect(carePingTestHelpers.isUnsafeBody('你之前告诉过我少推悲伤的歌，今晚换个轻一点的。')).toBe(true)
    expect(carePingTestHelpers.isUnsafeBody('我记得你喜欢王菲，这会儿可以听一首。')).toBe(true)
  })

  it('rejects banned companion cliches', () => {
    expect(carePingTestHelpers.isUnsafeBody('我给你接上这一首，让你稳稳的，把情绪接住。')).toBe(true)
    expect(carePingTestHelpers.isUnsafeBody('音乐是治愈的力量，我完全理解你的心情。')).toBe(true)
  })

  it('accepts compact product-style care pings', () => {
    expect(carePingTestHelpers.isUnsafeBody('这个点容易散神。先歇一小会儿，让自己缓过来。')).toBe(false)
    expect(carePingTestHelpers.isUnsafeBody('这首你说不定会喜欢，先放一会儿也行。')).toBe(false)
  })

  it('keeps recommend-track notification copy bound to the actual track', () => {
    const track = { title: 'Wake Up', artist: 'Arcade Fire' }

    expect(carePingTestHelpers.isCarePingBodyUsableForTrack('Arcade Fire 的《Wake Up》这会儿挺合适。', track)).toBe(true)
    expect(carePingTestHelpers.isCarePingBodyUsableForTrack('先听《沉溺》，再放 Arcade Fire 的《Wake Up》。', track)).toBe(false)
    expect(carePingTestHelpers.isCarePingBodyUsableForTrack('《Wake Up》这会儿挺合适。', track)).toBe(false)
  })

  it('cleans markdown wrappers before safety checking', () => {
    expect(carePingTestHelpers.cleanBody('```md\n> “晚上安静下来了。先听一首再收尾。”\n```')).toBe('晚上安静下来了。先听一首再收尾。')
  })

  it('passes memory evidence into care prompt input', () => {
    const content = carePingTestHelpers.buildCarePingPromptInput('这个点可以轻轻问一句。', {
      currentTime: '6月17日 周三 21:00',
      weather: '晴',
      recentConversations: 'user: 今天有点累',
      yesterdaySeal: '昨天你听得很慢。',
      recentNotifications: '晚上安静下来了。',
      trackLine: '',
      memoryEvidence: '<memory_evidence_contract>\n用户明确纠正是最高优先级证据\n</memory_evidence_contract>',
      activeEvents: [],
    })

    expect(content).toContain('用户明确纠正是最高优先级证据')
    expect(content).toContain('"recentNotifications"')
    expect(content).toContain('晚上安静下来了。')
    expect(content).toContain('现在输出最终通知正文')
  })

  it('passes active short-term context into care prompt input with a boundary', () => {
    const activeEvents = carePingTestHelpers.activeEventsForCarePrompt([{
      kind: 'context',
      content: '觉得有点冷',
      confidence: 0.64,
      weight: 0.32,
    }])
    const content = carePingTestHelpers.buildCarePingPromptInput('这个点可以轻轻问一句。', {
      currentTime: '6月17日 周三 21:00',
      weather: '晴',
      recentConversations: 'user: 今天有点冷',
      yesterdaySeal: '昨天你听得很慢。',
      recentNotifications: '(暂无)',
      trackLine: '',
      memoryEvidence: '<memory_evidence_contract>\n用户明确纠正是最高优先级证据\n</memory_evidence_contract>',
      activeEvents,
    })

    expect(content).toContain('"content": "觉得有点冷"')
    expect(content).toContain('"scope": "today_context"')
    expect(content).toContain('只表示今天仍在发生的短期状态')
    expect(content).toContain('不能写成稳定人格')
  })
})
