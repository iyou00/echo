import type { WindowSizePreset } from '../types/ipc'

export interface WindowSize {
  width: number
  height: number
}

export const DEFAULT_WINDOW_SIZE_PRESET: WindowSizePreset = 'standard'

export const WINDOW_SIZE_PRESETS: Readonly<Record<WindowSizePreset, WindowSize>> = {
  compact: { width: 1152, height: 720 },
  standard: { width: 1280, height: 800 },
  large: { width: 1440, height: 900 },
}

export function isWindowSizePreset(value: unknown): value is WindowSizePreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WINDOW_SIZE_PRESETS, value)
}

export function normalizeWindowSizePreset(value: unknown): WindowSizePreset {
  return isWindowSizePreset(value) ? value : DEFAULT_WINDOW_SIZE_PRESET
}

export function windowSizeForPreset(value: unknown): WindowSize {
  return WINDOW_SIZE_PRESETS[normalizeWindowSizePreset(value)]
}
