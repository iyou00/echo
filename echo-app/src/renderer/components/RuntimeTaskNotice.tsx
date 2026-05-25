import type { RuntimeTaskSnapshot } from '../../types/ipc'
import { runtimeErrorMessage } from '../../shared/runtimeRecovery'
import { groupRuntimeTasksForDisplay } from '../hooks/useRuntimeTasks'
import { pageLabels } from '../labels'

interface RuntimeTaskNoticeProps {
  task: RuntimeTaskSnapshot | null
  title?: string
  onCancel?: (id: string) => void
}

interface RuntimeTaskListProps {
  tasks: RuntimeTaskSnapshot[]
  limit?: number
  onCancel?: (id: string) => void
}

const runtimeKindLabels: Record<string, string> = {
  'chat-send': '絮语回复',
  'playlist-import': '文件歌单导入',
  'netease-playlist-import': '网易云歌单导入',
  'semantic-analysis': '歌曲语义分析',
  recommendation: '歌曲推荐',
  'scene-playback': '场景播放',
  'voice-line': '口播文案',
  'listening-segment': '回声片段',
  'yinyi-generate': pageLabels.yinyi,
  'care-ping': '主动关心',
  'taste-refresh': '口味画像',
  'scheduler-catchup': '启动补偿',
}

export function runtimeKindLabel(kind: string): string {
  return runtimeKindLabels[kind] ?? kind
}

export function runtimeStatusLabel(task: RuntimeTaskSnapshot): string {
  if (task.status === 'running') return '运行中'
  if (task.status === 'succeeded') return '完成'
  if (task.status === 'canceled') return '取消'
  return '失败'
}

export function runtimeTaskMessage(task: RuntimeTaskSnapshot): string {
  if (task.status === 'failed') return runtimeErrorMessage(task.errorKind, task.error ?? task.message ?? '任务失败')
  if (task.status === 'canceled') return task.message ?? '任务已取消'
  return task.message ?? task.phase
}

export function runtimeProgressPercent(task: RuntimeTaskSnapshot): number {
  if (task.total <= 0) return task.status === 'running' ? 18 : 100
  return Math.max(5, Math.min(100, Math.round((task.current / task.total) * 100)))
}

export function runtimeTaskTime(task: RuntimeTaskSnapshot): string {
  const date = new Date(task.updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function runtimeTaskMeta(task: RuntimeTaskSnapshot): string {
  const parts = [
    task.parentTaskId ? '子任务' : '',
    task.sourceName,
    task.phase,
    runtimeTaskTime(task),
  ].filter(Boolean)
  return parts.join(' · ')
}

export function RuntimeTaskNotice({ task, title, onCancel }: RuntimeTaskNoticeProps) {
  if (!task) return null
  return (
    <div className={`runtime-task runtime-task-notice ${task.status}`} aria-live="polite">
      <div className="runtime-task-head">
        <div>
          <div className="runtime-task-title">{title ?? runtimeKindLabel(task.kind)}</div>
          <div className="runtime-task-meta">{runtimeTaskMeta(task)}</div>
        </div>
        <div className={`runtime-task-status ${task.status}`}>{runtimeStatusLabel(task)}</div>
      </div>
      <div className="runtime-task-message">{runtimeTaskMessage(task)}</div>
      <div className="runtime-task-bar">
        <span style={{ width: `${runtimeProgressPercent(task)}%` }} />
      </div>
      {task.errorKind && task.status === 'failed' && (
        <div className="runtime-task-error">错误类型: {task.errorKind}</div>
      )}
      {task.status === 'running' && task.cancellable && onCancel && (
        <button className="btn sec runtime-task-cancel" type="button" onClick={() => onCancel(task.id)}>
          取消
        </button>
      )}
    </div>
  )
}

export function RuntimeTaskList({ tasks, limit = 6, onCancel }: RuntimeTaskListProps) {
  const visibleGroups = groupRuntimeTasksForDisplay(tasks).slice(0, limit)
  if (visibleGroups.length === 0) return null
  return (
    <div className="runtime-task-list" aria-live="polite">
      {visibleGroups.map(({ task, children }) => (
        <div className={`runtime-task ${task.status}`} key={task.id}>
          <div className="runtime-task-head">
            <div>
              <div className="runtime-task-title">{runtimeKindLabel(task.kind)}</div>
              <div className="runtime-task-meta">{runtimeTaskMeta(task)}</div>
            </div>
            <div className={`runtime-task-status ${task.status}`}>{runtimeStatusLabel(task)}</div>
          </div>
          <div className="runtime-task-message">{runtimeTaskMessage(task)}</div>
          <div className="runtime-task-bar">
            <span style={{ width: `${runtimeProgressPercent(task)}%` }} />
          </div>
          {task.errorKind && task.status === 'failed' && (
            <div className="runtime-task-error">错误类型: {task.errorKind}</div>
          )}
          {task.status === 'running' && task.cancellable && onCancel && (
            <button className="btn sec runtime-task-cancel" type="button" onClick={() => onCancel(task.id)}>
              取消
            </button>
          )}
          {children.length > 0 && (
            <div className="runtime-task-children">
              {children.map((child) => (
                <div className={`runtime-task-child ${child.status}`} key={child.id}>
                  <div>
                    <div className="runtime-task-child-title">{runtimeKindLabel(child.kind)}</div>
                    <div className="runtime-task-meta">{runtimeTaskMeta(child)}</div>
                  </div>
                  <div className={`runtime-task-status ${child.status}`}>{runtimeStatusLabel(child)}</div>
                  {child.status === 'running' && child.cancellable && onCancel && (
                    <button className="btn sec runtime-task-child-cancel" type="button" onClick={() => onCancel(child.id)}>
                      取消
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
