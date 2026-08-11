export function escapePromptData(value: string): string {
  return value
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
}

export function safePromptJson(value: unknown): string {
  return escapePromptData(JSON.stringify(value ?? null, null, 2))
}
