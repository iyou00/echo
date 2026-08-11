import { describe, it, expect, beforeAll } from 'vitest'
import type { EchoApi } from '../types/ipc'
import { friendlyOperationError } from '../shared/runtimeRecovery'
import { ECHO_API_CONTRACT, assertEchoApiContract, assertEchoApiReadContract } from './mockContract'

beforeAll(() => {
  if (typeof window === 'undefined') {
    globalThis.window = { setTimeout: setTimeout.bind(globalThis) } as unknown as Window & typeof globalThis
  }
})

async function getMock(): Promise<EchoApi> {
  const { getEchoApi } = await import('./api')
  return getEchoApi()
}

const namespaces = Object.keys(ECHO_API_CONTRACT) as Array<keyof EchoApi>

describe('mockContract structural checks', () => {
  it('every namespace exists on mockEcho', async () => {
    const mock = await getMock()
    for (const namespace of namespaces) {
      expect(mock[namespace], `missing namespace: ${namespace}`).toBeDefined()
      expect(typeof mock[namespace], `namespace ${namespace} should be an object`).toBe('object')
    }
  })

  it('every method exists and is a function', async () => {
    const mock = await getMock()
    for (const [namespace, methods] of Object.entries(ECHO_API_CONTRACT) as Array<[keyof EchoApi, readonly string[]]>) {
      const section = mock[namespace] as Record<string, unknown>
      for (const method of methods) {
        expect(typeof section[method], `${namespace}.${method} should be a function`).toBe('function')
      }
    }
  })

  it('feedback.record accepts track, action, context', async () => {
    const mock = await getMock()
    const result = await mock.feedback.record(
      { id: 'test', title: 'Test Song', artist: 'Test Artist' },
      'more_like_this',
      'chat context',
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('more_like_this')
  })

  it('taste.applySignal accepts kind and payload', async () => {
    const mock = await getMock()
    const result = await mock.taste.applySignal('like_artist', { target: 'test' })
    expect(result).toBeDefined()
  })

  it('taste.correctMemory accepts note', async () => {
    const mock = await getMock()
    const result = await mock.taste.correctMemory('我不喜欢电子音墙')
    expect(result.ok).toBe(true)
    expect(result.message).toBeTruthy()
  })

  it('taste.answerQuestion accepts id and answer', async () => {
    const mock = await getMock()
    const result = await mock.taste.answerQuestion(1, '我喜欢华语流行')
    expect(result.ok).toBe(true)
  })

  it('settings.onChanged stores listener and fires on update', async () => {
    const mock = await getMock()
    const received: Array<{ path: string; value: unknown }> = []
    const unsub = mock.settings.onChanged((payload) => received.push(payload))
    await mock.settings.update('user.city', '深圳')
    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received.some((item) => item.path === 'user.city')).toBe(true)
    unsub()
  })

  it('settings.onChanged fires on updateBatch', async () => {
    const mock = await getMock()
    const received: Array<{ path: string; value: unknown }> = []
    const unsub = mock.settings.onChanged((payload) => received.push(payload))
    await mock.settings.updateBatch([
      { path: 'user.city', value: '上海' },
      { path: 'tts.speed', value: 1.2 },
    ])
    expect(received.length).toBe(1)
    expect(received[0].path).toBe('settings.batch')
    expect(received[0].value).toEqual({ paths: ['user.city', 'tts.speed'] })
    unsub()
  })

  it('listening.generateSegment accepts options', async () => {
    const mock = await getMock()
    const result = await mock.listening.generateSegment({ continuation: true })
    expect(result.text).toBeTruthy()
    expect(result.track).toBeDefined()
    expect(result.generatedAt).toBeTruthy()
    await expect(mock.listening.endSession(result.sessionId)).resolves.toEqual({ ok: true })
  })

  it('health.get includes storage service', async () => {
    const mock = await getMock()
    const health = await mock.health.get()
    const services = health.map((item) => item.service)
    expect(services).toContain('storage')
  })

  it('health.check includes storage service', async () => {
    const mock = await getMock()
    const health = await mock.health.check()
    const services = health.map((item) => item.service)
    expect(services).toContain('storage')
  })
})

describe('assertEchoApiContract', () => {
  it('passes for mockEcho', async () => {
    const mock = await getMock()
    expect(() => assertEchoApiContract(mock, 'mockEcho')).not.toThrow()
  })

  it('throws for incomplete API', () => {
    expect(() => assertEchoApiContract({} as unknown as EchoApi, 'empty')).toThrow(/contract mismatch/)
  })
})

describe('assertEchoApiReadContract', () => {
  it('passes for mockEcho', async () => {
    const mock = await getMock()
    await expect(assertEchoApiReadContract(mock, 'mockEcho')).resolves.toBeUndefined()
  })
})

describe('friendlyOperationError', () => {
  it('removes Electron IPC details from user-facing failures', () => {
    const error = new Error("Error invoking remote method 'scene:play': Error: fetch failed")
    expect(friendlyOperationError(error)).toBe('网络连接没有接通，请检查网络后再试。')
  })

  it('keeps scene failures concise without Electron IPC prefixes', () => {
    const error = new Error("Error invoking remote method 'scene:play': Error: Echo 这次没找到能播的歌。")
    expect(friendlyOperationError(error, '场景启动失败，可以再试一次。')).toBe('场景启动失败，可以再试一次。')
  })

  it('maps expired music login to a recovery action', () => {
    expect(friendlyOperationError(new Error('网易云 cookie 已过期'))).toBe('网易云登录已经失效，请重新登录网易云。')
  })
})
