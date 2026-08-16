import { describe, expect, it } from 'vitest'
import { chatIntentTestHelpers, classifyFallbackChatIntent } from './chat'
import { INTENT_EVAL_CASES } from './evalCases'

// 评测集 runner：跑的是生产降级路径的同一组合（规则分类 + 上下文承接），
// 即 LLM 路由不可用时用户实际走到的代码。LLM 路径的评测见 evalCases.ts 头部规约。
const { applyRecentMusicContext } = chatIntentTestHelpers

describe('intent routing eval set', () => {
  for (const evalCase of INTENT_EVAL_CASES) {
    it(`${evalCase.id} — ${evalCase.text}`, () => {
      const context = evalCase.context ?? {}
      const intent = applyRecentMusicContext(classifyFallbackChatIntent(evalCase.text, context), context)

      const acceptableKinds = Array.isArray(evalCase.expect.kind) ? evalCase.expect.kind : [evalCase.expect.kind]
      expect(acceptableKinds, `kind: got '${intent.kind}'`).toContain(intent.kind)
      if ('artistQuery' in evalCase.expect) {
        expect(intent.artistQuery ?? null, `artistQuery of "${evalCase.text}"`).toBe(evalCase.expect.artistQuery)
      }
      if ('seedTitle' in evalCase.expect) {
        expect(intent.seedTitle ?? null, `seedTitle of "${evalCase.text}"`).toBe(evalCase.expect.seedTitle)
      }
      if ('wantsMusic' in evalCase.expect) {
        expect(intent.wantsMusic, `wantsMusic of "${evalCase.text}"`).toBe(evalCase.expect.wantsMusic)
      }
    })
  }

  it('every real-failure case carries a note and date', () => {
    for (const evalCase of INTENT_EVAL_CASES) {
      if (evalCase.source !== 'real-failure') continue
      expect(evalCase.note, `${evalCase.id} must explain the failure`).toBeTruthy()
      expect(evalCase.addedAt, `${evalCase.id} must carry a date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
