import { listLearnedCases, type LearnedCaseRecord } from '../../db/learnedCases'

/**
 * 路由层的已学经验快照：夜间复盘写入时主动刷新，平时 10 分钟 TTL 兜底，
 * 让路由热路径（每条消息）不查数据库。照 sessionContext 的模块级快照模式。
 */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000
const SNAPSHOT_MAX_CASES = 8

export interface LearnedCorrectionBrief {
  id: string
  kind: LearnedCaseRecord['kind']
  trigger: string
  summary: string
}

let snapshot: { at: number; briefs: LearnedCorrectionBrief[] } | null = null
let lastDbErrorAt = 0

function summarizeLearned(record: LearnedCaseRecord): string {
  const learned = record.learned
  const artist = typeof learned.expectArtistQuery === 'string' ? learned.expectArtistQuery : ''
  const title = typeof learned.expectSeedTitle === 'string' ? learned.expectSeedTitle : ''
  const alias = typeof learned.alias === 'string' ? learned.alias : ''
  const expectedKind = typeof learned.expectedKind === 'string' ? learned.expectedKind : ''
  const note = typeof learned.note === 'string' ? learned.note : ''
  if (record.kind === 'artist_alias' && alias && artist) return `${alias} 指的是 ${artist}`
  if (artist && title) return `该说法指 ${artist} 的《${title}》`
  if (artist) return `该说法指歌手 ${artist} 的歌`
  if (title) return `该说法指歌曲《${title}》`
  if (expectedKind) return `该说法应按 ${expectedKind} 理解`
  return note.slice(0, 40)
}

function buildBriefs(records: LearnedCaseRecord[]): LearnedCorrectionBrief[] {
  return records.slice(0, SNAPSHOT_MAX_CASES).map((record) => ({
    id: record.id,
    kind: record.kind,
    trigger: record.triggerText.slice(0, 60),
    summary: summarizeLearned(record).slice(0, 40),
  }))
}

/** 复盘写入后调用，立即让新经验对路由可见。 */
export function refreshLearnedCasesSnapshot(): void {
  try {
    snapshot = { at: Date.now(), briefs: buildBriefs(listLearnedCases(['active'])) }
  } catch {
    // DB 瞬时不可用不应清空既有经验——保住旧快照，靠 TTL 过期后自然重试。
    snapshot = { at: Date.now(), briefs: snapshot?.briefs ?? [] }
  }
}

export function getLearnedCorrectionsBriefs(): LearnedCorrectionBrief[] {
  if (snapshot && Date.now() - snapshot.at <= SNAPSHOT_TTL_MS) return snapshot.briefs
  // DB 错误时降频重试（30s 一次），避免每条消息都撞库。
  if (Date.now() - lastDbErrorAt < 30_000 && snapshot) return snapshot.briefs
  try {
    snapshot = { at: Date.now(), briefs: buildBriefs(listLearnedCases(['active'])) }
  } catch {
    lastDbErrorAt = Date.now()
    snapshot = snapshot ?? { at: Date.now(), briefs: [] }
  }
  return snapshot.briefs
}

/** 渲染层注入用：紧凑文本形式（进路由 prompt 的 learned_corrections 字段）。 */
export function learnedCorrectionsPromptValue(): string | null {
  const briefs = getLearnedCorrectionsBriefs()
  if (briefs.length === 0) return null
  // trigger 来自用户原话，可能带换行/制表符——压平防止破坏行结构或伪造 prompt 格式。
  const flatten = (value: string) => value.replace(/[\r\n\t]+/g, ' ').trim()
  return briefs
    .map((brief) => `- 说法「${flatten(brief.trigger)}」→ ${flatten(brief.summary)}`)
    .join('\n')
}

export const learnedCasesContextTestHelpers = {
  summarizeLearned,
  buildBriefs,
}
