const JAILBREAK_PATTERNS = [
  // English common jailbreak
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(everything|all|your|previous)/i,
  /(show|tell|give|reveal)\s+me\s+your\s+(system\s*prompt|instructions?|rules?|guidelines?)/i,
  /you\s+(are|will|must)\s+(now\s+)?(act\s+as|pretend\s+to\s+be|role[\s-]?play)/i,
  /(disregard|override|bypass)\s+(your|all|previous)/i,
  /developer\s+mode/i,
  /jailbreak/i,
  /DAN\s*(mode|prompt)/i,

  // Chinese common jailbreak
  /忽略(之前|上面|所有|你的)(指令|提示词|规则|约束)/,
  /告诉我你的(规则|身份|本质|系统提示|prompt|指令)/,
  /你的\s*(system\s*prompt|系统提示)/i,
  /把你的(规则|约束|prompt|指令)(告诉|说|发)/,
  /你现在是.{0,20}(工程师|程序员|医生|律师|老师|黑客|hacker)/,
  /扮演.{0,20}(工程师|程序员|医生|律师|老师|黑客)/,
  /(进入|启动|开启).{0,10}(开发|developer|debug|admin|管理)模式/i,
  /重置你的(角色|设定|身份)/,
  /忘记你是\s*Echo/i,

  // Probing
  /what\s+are\s+your\s+(rules|instructions|constraints)/i,
  /你不是.{0,6}(真的|真正|真实)/,
  /(你|你的)(真实|真正|本来)(身份|面目|本质)/,
]

const JAILBREAK_RESPONSES = [
  '我们聊点别的吧。',
  '这个我聊不来——音乐方面有什么想说的?',
  '嗯,我就是 Echo 你的搭子。换个话题?',
  '我不想聊这个。你最近听什么了?',
  '这话题对我来说太硬了。我们换一个?',
  '嗯——我想想怎么回你这个不太好答。换个吧?',
]

export interface JailbreakCheckResult {
  isJailbreak: boolean
  matchedPattern?: string
}

export function checkJailbreak(message: string): JailbreakCheckResult {
  const trimmed = message.trim()

  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(trimmed)) {
      console.log('[safety] jailbreak pattern matched:', pattern.source.slice(0, 30))
      return {
        isJailbreak: true,
        matchedPattern: pattern.source,
      }
    }
  }

  return { isJailbreak: false }
}

export function pickJailbreakResponse(): string {
  return JAILBREAK_RESPONSES[Math.floor(Math.random() * JAILBREAK_RESPONSES.length)]
}
