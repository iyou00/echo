import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../types/ipc'
import {
  buildYinyiEvidenceBundle,
  buildYinyiWriterMessages,
  deterministicYinyiIssues,
  parseYinyiWritingBrief,
  verifyYinyiTimeRelations,
  yinyiStyleConflicts,
} from './yinyiWriting'

const conversations: ChatMessage[] = [
  { id: 1, role: 'user', content: '工作被骂了，来一首欢快歌', createdAt: '2026-08-10T07:53:00+08:00' },
  { id: 2, role: 'assistant', content: '我没有找准。', createdAt: '2026-08-10T07:54:00+08:00' },
  { id: 3, role: 'user', content: '你觉得人要如何爱人？', createdAt: '2026-08-10T08:17:00+08:00' },
]

describe('yinyi writing evidence', () => {
  it('computes local day periods and selected time relations in code', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', conversations, [])
    expect(bundle.items.map((item) => item.dayPeriod)).toEqual(['早上', '早上', '早上'])

    const brief = parseYinyiWritingBrief(JSON.stringify({
      anchorEvidenceIds: ['conversation:1'],
      supportingEvidenceIds: ['conversation:3'],
      emotionalThread: '没有及时接住的话',
      echoStance: 'regretful',
      narrativeShape: 'sentence_echo',
      openingMode: '从一句话切入',
      endingMode: '小动作',
      allowedInference: [],
      forbiddenClaims: [],
      timeRelationPairs: [{ fromEvidenceId: 'conversation:1', toEvidenceId: 'conversation:3' }],
    }), bundle)

    expect(brief).not.toBeNull()
    expect(verifyYinyiTimeRelations(brief!, bundle)).toEqual([{
      fromEvidenceId: 'conversation:1',
      toEvidenceId: 'conversation:3',
      minutes: 24,
      wording: '相隔24分钟',
    }])
  })

  it('does not attribute Echo recommendations to the user', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', [], [{
      title: '星城少年赋',
      artist: 'Echo',
      listenedAt: '2026-08-10T08:16:00+08:00',
      source: 'recommended_by_echo',
      queueStatus: 'completed',
      sourceContext: 'voice',
    }, {
      title: '用户自己播放的歌',
      artist: '歌手',
      listenedAt: '2026-08-10T08:20:00+08:00',
      source: 'local_playback',
    }])

    expect(bundle.items[0].attribution).toBe('echo_continuation')
    expect(bundle.items[1].attribution).toBe('user_playback')
  })

  it('gives the writer only evidence selected by the director', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', conversations, [])
    const brief = parseYinyiWritingBrief(JSON.stringify({
      anchorEvidenceIds: ['conversation:3'],
      supportingEvidenceIds: [],
      emotionalThread: '一个没有答完的问题',
      echoStance: 'curious',
      narrativeShape: 'unfinished_question',
      openingMode: '问题回响',
      endingMode: '留白',
      allowedInference: [],
      forbiddenClaims: [],
      timeRelationPairs: [],
    }), bundle)!
    const content = buildYinyiWriterMessages(brief, bundle, [])[1].content

    expect(content).toContain('你觉得人要如何爱人')
    expect(content).not.toContain('工作被骂了')
    expect(content).not.toContain('我没有找准')
  })

  it('rejects invented songs, durations and repeated letter edges', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', conversations, [])
    const content = '今天留在我这里的是《不存在的歌》。然后我想了想，随后发现已经过了60分钟。'
    const issues = deterministicYinyiIssues(content, bundle, [], ['今天留在我这里的是另一个晚上。'])

    expect(issues).toContain('出现了证据中不存在的歌名')
    expect(issues).toContain('出现了未经代码验证的时间间隔')
    expect(issues).toContain('按事件顺序罗列，仍有流水账感')
    expect(issues).toContain('开头与近期风信重复')
  })

  it('rejects event day periods that contradict selected evidence', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', [conversations[2]], [])
    expect(deterministicYinyiIssues('下午你忽然问我，人要如何爱人。', bundle, [], []))
      .toContain('事件时段与选中证据不一致')
  })

  it('drops time relations whose endpoints were not selected', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', conversations, [])
    const brief = parseYinyiWritingBrief(JSON.stringify({
      anchorEvidenceIds: ['conversation:3'], supportingEvidenceIds: [], emotionalThread: '问题', echoStance: 'curious',
      narrativeShape: 'unfinished_question', openingMode: '问题', endingMode: '留白', allowedInference: [], forbiddenClaims: [],
      timeRelationPairs: [{ fromEvidenceId: 'conversation:1', toEvidenceId: 'conversation:3' }],
    }), bundle)!
    expect(brief.timeRelationPairs).toEqual([])
  })

  it('rejects attributing an automatic Echo track to a user choice', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', [], [{
      title: '星城少年赋',
      artist: 'Echo',
      listenedAt: '2026-08-10T08:16:00+08:00',
      source: 'recommended_by_echo',
      sourceContext: 'voice',
      queueStatus: 'completed',
    }])

    expect(deterministicYinyiIssues('你主动选了《星城少年赋》，还把它听完了。', bundle, [], []))
      .toContain('把 Echo 自动提供的歌曲写成了用户主动选择')
  })

  it('rotates recent structure and repeated style details deterministically', () => {
    const bundle = buildYinyiEvidenceBundle('2026-08-10', conversations, [])
    const brief = parseYinyiWritingBrief(JSON.stringify({
      anchorEvidenceIds: ['conversation:3'],
      supportingEvidenceIds: [],
      emotionalThread: '没有答完的问题',
      echoStance: 'curious',
      narrativeShape: 'unfinished_question',
      openingMode: '从问题切入',
      endingMode: '停在问题上',
      imageryFamily: '雨',
      allowedInference: [],
      forbiddenClaims: [],
      timeRelationPairs: [],
    }), bundle)!
    const issues = yinyiStyleConflicts(brief, [{
      narrativeShape: 'unfinished_question',
      echoStance: 'quiet',
      openingMode: '从问题切入',
      endingMode: '停在问题上',
      imageryFamily: '雨',
    }])

    expect(issues).toEqual([
      '叙事结构与最近两篇重复',
      '开头方式与近期风信重复',
      '结尾方式与近期风信重复',
      '主要意象与近期风信重复',
    ])
  })
})
