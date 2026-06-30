type ProfileTaskState = 'idle' | 'importing' | 'ok' | 'fail'

interface RuntimeTaskLike {
  kind: string
  status: string
  updatedAt: string
}

interface SemanticBackfillResultLike {
  tagged: number
  skipped: number
}

export interface SemanticProfileRefreshDeps {
  refreshStructuredProfile(): Promise<unknown>
  regeneratePortrait(): Promise<unknown>
  refreshProfile(): Promise<unknown>
  setProfileState(state: ProfileTaskState): void
  setProfileStatus(status: string): void
  friendlyError(error: unknown, fallback: string): string
}

export function shouldRefreshProfileForSemanticTask(task: RuntimeTaskLike, mountedAtMs: number): boolean {
  if (task.kind !== 'semantic-analysis' || task.status !== 'succeeded') return false
  const updatedAtMs = new Date(task.updatedAt).getTime()
  return Number.isFinite(updatedAtMs) && updatedAtMs >= mountedAtMs
}

export function shouldRefreshProfileAfterSemanticBackfill(result: SemanticBackfillResultLike): boolean {
  return result.tagged > 0
}

export function semanticBackfillResultStatus(result: SemanticBackfillResultLike): string {
  if (result.tagged > 0) return ''
  if (result.skipped > 0) return ''
  return '还没有导入歌曲，先导入歌单后再整理语义。'
}

export async function refreshProfileAfterSemanticUpdateAction(deps: SemanticProfileRefreshDeps): Promise<boolean> {
  deps.setProfileState('importing')
  deps.setProfileStatus('Echo 正在把新的语义整理进画像...')
  let portraitError: unknown = null
  try {
    await deps.refreshStructuredProfile()
  } catch (error) {
    deps.setProfileState('fail')
    deps.setProfileStatus(deps.friendlyError(error, '语义已更新，结构画像这次没有整理好。'))
    return false
  }

  try {
    await deps.regeneratePortrait()
  } catch (error) {
    portraitError = error
  }

  try {
    await deps.refreshProfile()
  } catch (error) {
    deps.setProfileState('fail')
    deps.setProfileStatus(deps.friendlyError(error, '画像已更新，页面这次没有刷新出来。'))
    return false
  }

  deps.setProfileState('ok')
  deps.setProfileStatus(portraitError
    ? deps.friendlyError(portraitError, '语义已更新，画像文案稍后再写。')
    : '画像已跟随语义更新')
  return true
}
