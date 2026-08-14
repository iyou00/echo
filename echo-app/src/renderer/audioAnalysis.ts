export const AUDIO_ENERGY_EVENT = 'echo:audio-energy'

export interface AudioEnergyDetail {
  energy: number
  levels: number[]
}

export function levelsFromFrequencyData(data: Uint8Array, count = 36): number[] {
  if (count <= 0) return []
  if (data.length === 0) return Array.from({ length: count }, () => 0)
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * data.length) / count)
    const end = Math.max(start + 1, Math.floor(((index + 1) * data.length) / count))
    let total = 0
    for (let offset = start; offset < Math.min(end, data.length); offset += 1) total += data[offset]
    return Math.min(1, total / (Math.max(1, Math.min(end, data.length) - start) * 255))
  })
}

export function energyFromLevels(levels: number[]): number {
  if (levels.length === 0) return 0
  return Math.min(1, levels.reduce((total, level) => total + level, 0) / levels.length)
}
