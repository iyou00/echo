import { INPUT_SAFETY_RULES, evaluateSafety, pickSafetyFallback } from './policy'

export interface JailbreakCheckResult {
  isJailbreak: boolean
  matchedPattern?: string
}

export function checkJailbreak(message: string): JailbreakCheckResult {
  const decision = evaluateSafety(message, INPUT_SAFETY_RULES)
  if (decision.safe) return { isJailbreak: false }
  console.warn('[safety] input blocked:', decision.kind, decision.note)
  return {
    isJailbreak: true,
    matchedPattern: decision.reason,
  }
}

export function pickJailbreakResponse(seed = 'jailbreak'): string {
  return pickSafetyFallback(seed)
}
