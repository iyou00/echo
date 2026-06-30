import type { ImportPlaylistResult, SemanticSummary } from '../../types/ipc'

export function formatImportResultStatus(result: ImportPlaylistResult, summary: SemanticSummary | null): string {
  if (!result.imported) return result.message ?? '导入失败'
  const name = result.name?.trim()
  const base = name ? `已导入「${name}」${result.count} 首` : `已导入 ${result.count} 首`
  if (!summary) return `${base} · 语义统计稍后刷新`
  if (summary.total > 0) return `${base} · 已整理 ${summary.total} 首语义`
  return `${base} · 模型可用后会自动补齐语义`
}

export function shouldAutoClearNeteaseImportStatus(status: string): boolean {
  return /^已(?:从网易云)?导入/.test(status.trim()) || /导入完成/.test(status)
}
