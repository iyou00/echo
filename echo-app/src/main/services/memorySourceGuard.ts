const MEMORY_SOURCE_PREFIX = /我(?:还)?记得|你(?:之前|刚才)(?:说|告诉过我|提过)|你(?:说过|告诉过我|提过)|你明确说|你纠正(?:过)?我/

function leakPattern(maxGap: number, tail: string): RegExp {
  return new RegExp(`(?:${MEMORY_SOURCE_PREFIX.source}).{0,${maxGap}}(?:${tail})`)
}

const DEFAULT_LEAK_PATTERN = leakPattern(36, '不喜欢|少推|别总|别老|不是|纠正|画像|数据|轨迹|记忆')

export function hasExplicitMemorySource(value: string): boolean {
  return MEMORY_SOURCE_PREFIX.test(value)
}

export function hasMemorySourceLeak(value: string, options: { maxGap?: number; tail?: string } = {}): boolean {
  if (options.maxGap === undefined && options.tail === undefined) return DEFAULT_LEAK_PATTERN.test(value)
  return leakPattern(
    options.maxGap ?? 36,
    options.tail ?? '不喜欢|少推|别总|别老|不是|纠正|画像|数据|轨迹|记忆',
  ).test(value)
}
