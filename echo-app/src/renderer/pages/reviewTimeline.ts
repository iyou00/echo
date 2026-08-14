import type { AgentActionSummary, ChatMessage, QueueHistoryDay } from '../../types/ipc'

export interface ReviewTimelineItem {
  id: string
  occurredAt: string
  kind: 'conversation' | 'listening' | 'agent'
  label: string
  title: string
  detail?: string
  tone: 'user' | 'echo' | 'music' | 'system'
}

const originLabels: Record<AgentActionSummary['origin'], string> = {
  chat: '絮语',
  listening: '连续回声',
  scene: '场景',
  care: '主动关心',
  playback: '播放',
}

const actionLabels: Record<AgentActionSummary['actionType'], string> = {
  reply: '回应了你',
  clarify: '向你确认',
  play: '开始播放',
  adjust_music: '调整了音乐',
  speak_then_play: '说完后接上音乐',
  silent_play: '安静地接上音乐',
  stay_silent: '选择没有打扰',
  safety_guidance: '给出安全提醒',
}

export function buildReviewTimeline(
  messages: ChatMessage[],
  history: QueueHistoryDay[],
  actions: AgentActionSummary[],
): ReviewTimelineItem[] {
  const conversation = messages.map<ReviewTimelineItem>((message) => ({
    id: `chat-${message.id}`,
    occurredAt: message.createdAt,
    kind: 'conversation',
    label: message.role === 'user' ? '你' : 'Echo',
    title: message.content || (message.tracks?.length ? `推荐了 ${message.tracks.length} 首歌` : '留下了一段回应'),
    detail: message.tracks?.map((track) => `${track.artist} · ${track.title}`).join(' / '),
    tone: message.role === 'user' ? 'user' : 'echo',
  }))

  const listening = history.flatMap((day) => day.tracks.map<ReviewTimelineItem>((track, index) => ({
    id: `listening-${day.date}-${track.id ?? track.neteaseId ?? `${track.artist}-${track.title}`}-${index}`,
    occurredAt: track.queueStatusAt ?? track.recommendedAt ?? `${day.date}T12:00:00`,
    kind: 'listening',
    label: '听过',
    title: track.title,
    detail: `${track.artist}${track.queueStatus === 'completed' ? ' · 已听完' : track.queueStatus === 'skipped' ? ' · 已跳过' : ''}`,
    tone: 'music',
  })))

  const agent = actions.map<ReviewTimelineItem>((action) => {
    const outcome = action.outcomes[0]
    return {
      id: `agent-${action.id}`,
      occurredAt: action.finishedAt ?? action.plannedAt,
      kind: 'agent',
      label: originLabels[action.origin],
      title: actionLabels[action.actionType],
      detail: action.status === 'failed'
        ? '这次没有执行完成，不会算作你的反馈。'
        : outcome?.polarity === 'system'
          ? '系统结果，不计入你的偏好。'
          : outcome
            ? `已记录 ${outcome.type}`
            : undefined,
      tone: action.status === 'failed' || outcome?.polarity === 'system' ? 'system' : 'echo',
    }
  })

  return [...conversation, ...listening, ...agent]
    .filter((item) => !Number.isNaN(Date.parse(item.occurredAt)))
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
}
