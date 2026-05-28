import { stableDaySeed, stableHash } from '../../../shared/deterministic'

export { stableDaySeed, stableHash, stableInt, stableUnit } from '../../../shared/deterministic'

export interface RecommendationDeterminismContext {
  daySeed: string
}

export function createRecommendationDeterminismContext(date = new Date()): RecommendationDeterminismContext {
  return { daySeed: stableDaySeed(date) }
}

export function stableShuffle<T>(items: T[], seed: string, keyOf: (item: T, index: number) => string = (_item, index) => String(index)): T[] {
  return items
    .map((item, index) => ({
      item,
      order: stableHash(`${seed}:${keyOf(item, index)}`),
      index,
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ item }) => item)
}
