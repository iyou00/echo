export function stableHash(input: string): number {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function stableUnit(seed: string): number {
  return stableHash(seed) / 0xffffffff
}

export function stableInt(seed: string, maxExclusive: number): number {
  const max = Math.max(1, Math.floor(maxExclusive))
  return stableHash(seed) % max
}

export function stableDaySeed(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function stableChoice<T>(items: readonly T[], seed: string, fallback: T): T {
  return items[stableInt(seed, items.length)] ?? fallback
}
