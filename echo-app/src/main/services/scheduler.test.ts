import { describe, expect, it } from 'vitest'
import type { SchedulerCatchupResult } from '../../types/ipc'
import { selectStartupCatchupPrimary } from './scheduler'
import { shouldSkipCompletedYinyiJob, shouldSkipExistingYinyi, yinyiCatchupCompletedMessage } from './scheduler/yinyiJobs'

function result(patch: Partial<SchedulerCatchupResult>): SchedulerCatchupResult {
  return {
    ok: true,
    job: 'yinyi_daily',
    date: '2026-06-18',
    status: 'skipped',
    message: '跳过。',
    ...patch,
  }
}

describe('startup catchup result selection', () => {
  it('keeps startup catchup quiet when every job is skipped', () => {
    expect(selectStartupCatchupPrimary([
      result({ job: 'yinyi_daily', status: 'skipped', message: '这一天已经有风信了。' }),
      result({ job: 'taste_profile_structured', status: 'skipped', message: '今天没有新增口味信号，跳过结构刷新。' }),
    ])).toMatchObject({
      status: 'skipped',
      message: '没有需要补偿的任务。',
    })
  })

  it('uses the current runtime date for quiet skipped catchup results', () => {
    expect(selectStartupCatchupPrimary([
      result({ job: 'yinyi_daily', status: 'skipped', date: '2026-06-18', message: '这一天已经有风信了。' }),
    ], new Date('2026-06-21T09:00:00+08:00'))).toMatchObject({
      date: '2026-06-21',
      status: 'skipped',
      message: '没有需要补偿的任务。',
    })
  })

  it('surfaces real work and failures ahead of skipped jobs', () => {
    expect(selectStartupCatchupPrimary([
      result({ job: 'yinyi_daily', status: 'skipped', message: '跳过风信。' }),
      result({ job: 'taste_profile_portrait', status: 'completed', message: '画像文案已刷新。' }),
    ])).toMatchObject({
      job: 'taste_profile_portrait',
      status: 'completed',
    })

    expect(selectStartupCatchupPrimary([
      result({ job: 'taste_profile_portrait', status: 'completed', message: '画像文案已刷新。' }),
      result({ job: 'yinyi_daily', ok: false, status: 'failed', message: '风信生成失败。' }),
    ])).toMatchObject({
      job: 'yinyi_daily',
      status: 'failed',
    })
  })

  it('keeps actionable readiness blockers quiet when every catchup job is skipped', () => {
    expect(selectStartupCatchupPrimary([
      result({ job: 'yinyi_daily', status: 'skipped', message: '模型尚未配置，保留这一天等待后续补写。' }),
      result({ job: 'taste_profile_structured', status: 'skipped', message: '还没有画像，跳过结构刷新。' }),
    ])).toMatchObject({
      job: 'yinyi_daily',
      status: 'skipped',
      message: '没有需要补偿的任务。',
    })

    expect(selectStartupCatchupPrimary([
      result({ job: 'yinyi_daily', status: 'skipped', message: 'Echo 还在首次设置中，暂不运行风信任务。' }),
      result({ job: 'taste_profile_portrait', status: 'skipped', message: 'Echo 还在首次设置中，暂不刷新画像文案。' }),
    ])).toMatchObject({
      job: 'yinyi_daily',
      status: 'skipped',
      message: '没有需要补偿的任务。',
    })
  })
})

describe('yinyi startup catchup wording', () => {
  it('retries failed placeholders instead of treating them as completed letters', () => {
    expect(shouldSkipExistingYinyi({ date: '2026-06-18', content: '失败占位', style: 'dialogue', meta: { status: 'failed' } })).toBe(false)
    expect(shouldSkipExistingYinyi({ date: '2026-06-18', content: '正文', style: 'dialogue', meta: { status: 'ok' } })).toBe(true)
    expect(shouldSkipCompletedYinyiJob({ date: '2026-06-18', content: '失败占位', style: 'dialogue', meta: { status: 'failed' } }, 'completed')).toBe(false)
    expect(shouldSkipCompletedYinyiJob(null, 'completed')).toBe(true)
  })

  it('counts factual fallback letters as existing so the daily slot never overwrites them', () => {
    // 事实兜底信 status 是 ok：定时档位与启动补写一样只认 failed 占位需要重试，其余一律不覆盖。
    expect(shouldSkipExistingYinyi({
      date: '2026-08-29',
      content: '你今天最后留下的一句话是“生活还苦啊”。',
      style: 'dialogue',
      meta: { status: 'ok', fallback: true, fallback_error: 'LLM 连续返回空内容' } as never,
    })).toBe(true)
  })

  it('uses normal generation wording on the first use date', () => {
    expect(yinyiCatchupCompletedMessage('2026-06-18', '2026-06-18')).toBe('风信已生成。')
  })

  it('uses normal wording for same-day startup catchup', () => {
    expect(yinyiCatchupCompletedMessage('2026-06-19', '2026-06-18', new Date('2026-06-19T23:30:00+08:00'))).toBe('风信已生成。')
  })

  it('uses backfill wording only for dates after first use', () => {
    expect(yinyiCatchupCompletedMessage('2026-06-19', '2026-06-18', new Date('2026-06-20T09:00:00+08:00'))).toBe('已补写最近缺失的风信。')
  })
})
