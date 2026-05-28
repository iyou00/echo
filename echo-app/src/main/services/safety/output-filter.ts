import { OUTPUT_SAFETY_RULES, evaluateSafety } from './policy'

export function checkOutputSafe(output: string): { safe: boolean; reason?: string } {
  const decision = evaluateSafety(output, OUTPUT_SAFETY_RULES)
  if (decision.safe) return { safe: true }
  console.warn('[safety] output filtered:', decision.kind, decision.note)
  return { safe: false, reason: decision.reason }
}
