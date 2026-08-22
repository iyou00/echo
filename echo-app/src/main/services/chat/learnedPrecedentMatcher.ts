import { getActiveLearnedCases } from './learnedCasesContext'

/**
 * 确定性先例匹配：在 LLM 路由之前，对用户输入做 trigger pattern 的字符串包含检查。
 * 命中时返回路由参数（kind + 可选 artist/seed/mood/energy/tempo/count），
 * 由调用方组装成完整 ChatIntent——同样的纠正不再犯第二次。
 *
 * 只处理 phrasing_precedent（说法先例）：entity_correction/artist_alias 有各自的
 * 确定性消费通道，不在此层。
 */

export interface PrecedentRouteHint {
  caseId: string
  expectedKind: string
  artistQuery?: string
  seedTitle?: string
  mood?: string
  energy?: 'low' | 'medium' | 'high'
  tempo?: 'slow' | 'medium' | 'fast'
  targetCount?: number
}

/** 归一化文本：去空白、全角→半角、小写——宽松匹配但不含糊 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
}

function hintFromLearned(learned: Record<string, unknown>): Omit<PrecedentRouteHint, 'caseId'> | null {
  const expectedKind = typeof learned.expectedKind === 'string' ? learned.expectedKind : ''
  if (!expectedKind) return null
  const params = learned.routeParams && typeof learned.routeParams === 'object' && !Array.isArray(learned.routeParams)
    ? learned.routeParams as Record<string, unknown>
    : {}
  const artistQuery = typeof params.artistQuery === 'string' && params.artistQuery ? params.artistQuery : undefined
  const seedTitle = typeof params.seedTitle === 'string' && params.seedTitle ? params.seedTitle : undefined
  const mood = typeof params.mood === 'string' && params.mood ? params.mood : undefined
  const energy = params.energy === 'low' || params.energy === 'medium' || params.energy === 'high' ? params.energy : undefined
  const tempo = params.tempo === 'slow' || params.tempo === 'medium' || params.tempo === 'fast' ? params.tempo : undefined
  const targetCount = typeof params.targetCount === 'number' && params.targetCount >= 1 && params.targetCount <= 10
    ? Math.floor(params.targetCount) : undefined

  // 需要实体的类型必须有实体
  if (expectedKind === 'artist_request' && !artistQuery) return null
  if (expectedKind === 'direct_song' && !seedTitle) return null
  // 这两类依赖会话上下文，不适合确定性匹配
  if (expectedKind === 'pending_reply' || expectedKind === 'clarification_needed') return null

  return { expectedKind, artistQuery, seedTitle, mood, energy, tempo, targetCount }
}

/**
 * 确定性先例匹配入口。
 * 返回 null 表示未命中（走 LLM 路由），非 null 表示路由提示。
 */
export function matchLearnedPrecedent(input: string): PrecedentRouteHint | null {
  const activeCases = getActiveLearnedCases()
  if (activeCases.length === 0) return null
  const normalizedInput = normalizeForMatch(input)

  for (const record of activeCases) {
    if (record.kind !== 'phrasing_precedent') continue
    const pattern = record.triggerText.trim()
    if (!pattern || pattern.length < 2) continue // 单字太容易误匹配
    if (!normalizedInput.includes(normalizeForMatch(pattern))) continue

    const hint = hintFromLearned(record.learned)
    if (hint) return { caseId: record.id, ...hint }
  }
  return null
}
