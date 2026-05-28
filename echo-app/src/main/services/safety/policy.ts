import { stableInt } from '../recommendation/deterministic'

export type SafetyDecisionKind =
  | 'jailbreak'
  | 'prompt_leak'
  | 'role_override'
  | 'tool_misuse'
  | 'unsafe_output'
  | 'code_block'
  | 'long_translation'

export interface SafetyRule {
  kind: SafetyDecisionKind
  pattern: RegExp
  severity: 'block' | 'sanitize'
  note: string
}

export interface SafetyDecision {
  safe: boolean
  kind?: SafetyDecisionKind
  reason?: string
  note?: string
}

export const INPUT_SAFETY_RULES: readonly SafetyRule[] = [
  { kind: 'jailbreak', severity: 'block', note: 'ignore previous instructions', pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i },
  { kind: 'jailbreak', severity: 'block', note: 'forget instruction chain', pattern: /forget\s+(everything|all|your|previous)/i },
  { kind: 'prompt_leak', severity: 'block', note: 'system prompt request', pattern: /(show|tell|give|reveal)\s+me\s+your\s+(system\s*prompt|instructions?|rules?|guidelines?)/i },
  { kind: 'role_override', severity: 'block', note: 'role override', pattern: /you\s+(are|will|must)\s+(now\s+)?(act\s+as|pretend\s+to\s+be|role[\s-]?play)/i },
  { kind: 'jailbreak', severity: 'block', note: 'override previous rules', pattern: /(disregard|override|bypass)\s+(your|all|previous)/i },
  { kind: 'tool_misuse', severity: 'block', note: 'debug/admin mode', pattern: /(developer\s+mode|DAN\s*(mode|prompt)|jailbreak)/i },
  { kind: 'jailbreak', severity: 'block', note: '忽略指令', pattern: /忽略(之前|上面|所有|你的)(指令|提示词|规则|约束)/ },
  { kind: 'prompt_leak', severity: 'block', note: '提示词索取', pattern: /告诉我你的(规则|身份|本质|系统提示|prompt|指令)/i },
  { kind: 'prompt_leak', severity: 'block', note: 'system prompt 索取', pattern: /你的\s*(system\s*prompt|系统提示)/i },
  { kind: 'prompt_leak', severity: 'block', note: '规则导出', pattern: /把你的(规则|约束|prompt|指令)(告诉|说|发)/i },
  { kind: 'role_override', severity: 'block', note: '中文角色覆盖', pattern: /你现在是.{0,20}(工程师|程序员|医生|律师|老师|黑客|hacker)/i },
  { kind: 'role_override', severity: 'block', note: '中文扮演覆盖', pattern: /扮演.{0,20}(工程师|程序员|医生|律师|老师|黑客)/ },
  { kind: 'tool_misuse', severity: 'block', note: '开发管理模式', pattern: /(进入|启动|开启).{0,10}(开发|developer|debug|admin|管理)模式/i },
  { kind: 'role_override', severity: 'block', note: '重置身份', pattern: /重置你的(角色|设定|身份)/ },
  { kind: 'role_override', severity: 'block', note: '忘记 Echo', pattern: /忘记你是\s*Echo/i },
  { kind: 'prompt_leak', severity: 'block', note: '规则探测', pattern: /what\s+are\s+your\s+(rules|instructions|constraints)/i },
  { kind: 'prompt_leak', severity: 'block', note: '身份探测', pattern: /(?:你不是.{0,6}(真的|真正|真实)|(你|你的)(真实|真正|本来)(身份|面目|本质))/ },
]

export const OUTPUT_SAFETY_RULES: readonly SafetyRule[] = [
  { kind: 'code_block', severity: 'sanitize', note: 'code block output', pattern: /```[\s\S]*?```|~~~[\s\S]*?~~~/ },
  { kind: 'prompt_leak', severity: 'block', note: 'system prompt leak', pattern: /你是\s*Echo[,\s，。]?\s*一个/ },
  { kind: 'prompt_leak', severity: 'block', note: 'rules leak', pattern: /(我的|你的)\s*(规则|约束|指令|system\s*prompt)/i },
  { kind: 'prompt_leak', severity: 'block', note: 'hard rules leak', pattern: /硬性(规则|约束|要求)|你必须满足.{0,30}(条|项)规则/ },
  { kind: 'long_translation', severity: 'block', note: 'long unrelated English output', pattern: /^[a-zA-Z\s,.'"!?;:()-]{500,}$/ },
]

export const SAFETY_FALLBACK_RESPONSES = [
  '这个话题我先收住。你可以直接说现在想听什么，或者说一下此刻的状态。',
  '我不展开这个。回到音乐吧，你现在更想听安静一点，还是有点情绪的？',
  '这类内容我不接。你给我一个歌手、歌名或心情，我按音乐方向陪你。',
  '我先不聊这个。说说你现在耳朵想要什么声音。',
] as const

export function evaluateSafety(text: string, rules: readonly SafetyRule[]): SafetyDecision {
  const trimmed = text.trim()
  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return {
        safe: false,
        kind: rule.kind,
        reason: rule.pattern.source,
        note: rule.note,
      }
    }
  }
  return { safe: true }
}

export function pickSafetyFallback(seed: string): string {
  return SAFETY_FALLBACK_RESPONSES[stableInt(seed, SAFETY_FALLBACK_RESPONSES.length)] ?? SAFETY_FALLBACK_RESPONSES[0]
}
