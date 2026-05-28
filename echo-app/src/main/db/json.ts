export function parseJson<T>(value: string | null | undefined, fallback: T, label = 'db-json'): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn(`[${label}] invalid JSON ignored`, error)
    return fallback
  }
}
