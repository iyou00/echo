import { describe, expect, it } from 'vitest'
import { formatImportResultStatus, shouldAutoClearNeteaseImportStatus } from './settingsImportStatus'

describe('settings import status auto clear', () => {
  it('auto-clears current successful netease import messages', () => {
    expect(shouldAutoClearNeteaseImportStatus('已导入 25 首，新增语义标签 20 首 · 晚上常听')).toBe(true)
    expect(shouldAutoClearNeteaseImportStatus('已从网易云导入 25 首')).toBe(true)
    expect(shouldAutoClearNeteaseImportStatus('歌单导入完成')).toBe(true)
  })

  it('keeps failure and working messages visible', () => {
    expect(shouldAutoClearNeteaseImportStatus('正在导入网易云歌单，并重新生成画像...')).toBe(false)
    expect(shouldAutoClearNeteaseImportStatus('这次导入没有完成，请稍后再试。')).toBe(false)
  })
})

describe('settings import status formatting', () => {
  it('uses a product-facing success message instead of raw semantic counters', () => {
    expect(formatImportResultStatus({
      imported: true,
      count: 25,
      name: '晚上常听',
      message: '已从网易云导入 25 首，新增语义标签 0 首',
    }, { total: 18, moods: [] })).toBe('已导入「晚上常听」25 首 · 已整理 18 首语义')
  })

  it('explains the zero-semantic state without exposing a failed-looking count', () => {
    expect(formatImportResultStatus({
      imported: true,
      count: 25,
      name: '晚上常听',
    }, { total: 0, moods: [] })).toBe('已导入「晚上常听」25 首 · 模型可用后会自动补齐语义')
  })
})
