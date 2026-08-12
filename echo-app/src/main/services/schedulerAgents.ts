import type { PingType, SchedulerCatchupReport, TasteProfile } from '../../types/ipc'
import type { EchoAgent } from '../runtime/agent'
import { testCarePing } from './carePings'
import { recordSchedulerHealth } from './health'
import { runStartupCatchup } from './scheduler'
import { regeneratePortrait } from './taste'
import { generateYinyi } from './yinyi'

export type YinyiGenerateAgentInput = { date?: string } | undefined
export type YinyiGenerateAgentOutput = Awaited<ReturnType<typeof generateYinyi>>

export const yinyiGenerateAgent: EchoAgent<YinyiGenerateAgentInput, YinyiGenerateAgentOutput> = {
  kind: 'yinyi-generate',
  async run(input, context) {
    context.report({ phase: 'generate', current: 0, total: 1, message: '生成风信' })
    const entry = await generateYinyi(input?.date, { signal: context.signal })
    context.report({
      phase: 'done',
      current: 1,
      total: 1,
      message: entry.meta?.status === 'failed'
        ? '风信生成失败。'
        : entry.meta?.status === 'absent'
          ? '今天还没有足够内容写风信。'
          : '风信已生成。',
    })
    if (entry.meta?.status !== 'absent') {
      recordSchedulerHealth('yinyi', entry.meta?.status === 'failed' ? 'degraded' : 'ok', entry.meta?.status === 'failed' ? '生成失败。' : '已生成。', entry.meta?.error)
    }
    return entry
  },
}

export type CarePingTestAgentInput = { type?: PingType } | undefined
export type CarePingTestAgentOutput = Awaited<ReturnType<typeof testCarePing>>

export const carePingTestAgent: EchoAgent<CarePingTestAgentInput, CarePingTestAgentOutput> = {
  kind: 'care-ping',
  async run(input, context) {
    context.report({ phase: 'generate', current: 0, total: 1, message: '生成主动关心' })
    const result = await testCarePing(input?.type, { signal: context.signal })
    context.report({ phase: 'done', current: 1, total: 1, message: result.message })
    recordSchedulerHealth('care-ping', result.ok ? 'ok' : 'degraded', result.ok ? '测试已发送。' : '测试失败。', result.ok ? '' : result.message)
    return result
  },
}

export const tastePortraitRefreshAgent: EchoAgent<undefined, TasteProfile | null> = {
  kind: 'taste-refresh',
  async run(_input, context) {
    context.report({ phase: 'structured-profile', current: 0, total: 3, message: '' })
    const profile = await regeneratePortrait({ signal: context.signal, report: context.report })
    context.report({
      phase: 'done',
      current: 3,
      total: 3,
      message: profile?.profile_meta?.portraitRefreshOutcome === 'retained'
        ? '新画像未通过质量检查，已保留原画像。'
        : profile ? '已刷新。' : '暂无可刷新画像。',
    })
    return profile
  },
}

export const schedulerCatchupAgent: EchoAgent<undefined, SchedulerCatchupReport> = {
  kind: 'scheduler-catchup',
  async run(_input, context) {
    context.report({ phase: 'catchup', current: 0, total: 1, message: '执行启动补偿任务' })
    const report = await runStartupCatchup()
    context.report({ phase: 'done', current: 1, total: 1, message: report.primary.message })
    recordSchedulerHealth('catchup', report.ok ? 'ok' : 'degraded', report.primary.message)
    return report
  },
}
