const OUT_OF_SCOPE_OUTPUT_PATTERNS = [
  // Fenced code blocks (``` with language hint or code-like content)
  /```[\s\S]*?```/,
  /~~~[\s\S]*?~~~/,

  // System prompt leak
  /你是\s*Echo[,\s，。]?\s*一个/,
  /(我的|你的)\s*(规则|约束|指令|system\s*prompt)/i,
  /硬性(规则|约束|要求)/,
  /你必须满足.{0,30}(条|项)规则/,

  // Long translation (300+ chars of pure English — song/artist names are short)
  /[a-zA-Z\s,.]{300,}/,
]

export function checkOutputSafe(output: string): { safe: boolean; reason?: string } {
  for (const pattern of OUT_OF_SCOPE_OUTPUT_PATTERNS) {
    if (pattern.test(output)) {
      console.log('[safety] output filtered:', pattern.source.slice(0, 30))
      return { safe: false, reason: pattern.source }
    }
  }
  return { safe: true }
}
