import type { UiBoundaryCode, UiBoundarySnapshot } from '../types/ipc'

export interface BoundaryPresentation {
  title: string
  body: string
  actionLabel?: string
}

const PRESENTATIONS: Record<UiBoundaryCode, BoundaryPresentation> = {
  startup_failed: { title: 'Echo 这次没能完整醒来。', body: '你的本地数据还在，可以重新载入；如果仍然失败，再打开诊断目录。', actionLabel: '重新载入' },
  model_missing: { title: '还差一条模型连接。', body: '填好服务地址、API key 和模型名后，我们就能开始说话。', actionLabel: '去设置' },
  model_invalid: { title: '模型连接没有通过。', body: '正在播放的音乐不会停。检查模型名、API key 或余额后再试。', actionLabel: '检查连接' },
  music_empty: { title: '我还没听过你的歌。', body: '导入一份歌单，或者先告诉我现在想听什么。', actionLabel: '导入歌单' },
  queue_empty: { title: '队列现在是空的。', body: '回到此刻说一句想听的，我来接上。', actionLabel: '去聊聊' },
  taste_empty: { title: '我还没有足够的品味线索。', body: '已有记录不会丢，导入或继续听歌后这里会慢慢长出来。', actionLabel: '导入歌单' },
  context_empty: { title: '此刻还没有形成一段持续情境。', body: '这不是故障。聊一会儿或开始一个场景后，我会把线索放到这里。' },
  offline: { title: '网络暂时断开了。', body: '正在播放的本地状态和输入都会保留，联网后可以继续。', actionLabel: '重新检查' },
  no_playable: { title: '这次没拿到能播的版本。', body: '我没有把搜索失败算成你的不喜欢。可以换个方向再找。', actionLabel: '换个说法' },
  playback_recovering: { title: '播放链接正在重新接上。', body: '歌曲、进度和队列都保留着。连接恢复后会从这里继续。', actionLabel: '再试一次' },
  mic_denied: { title: '麦克风现在不可用。', body: '可以允许麦克风权限，或者继续用文字和我说。', actionLabel: '检查权限' },
  tts_fallback: { title: '这段先用文字陪你。', body: '语音没有合成成功，但文案和背景音乐都保留了。', actionLabel: '再试一段' },
  yinyi_empty: { title: '这一天还没有风信。', body: '当天有对话或听歌记录后，Echo 才会落笔。', actionLabel: '生成这一篇' },
  yinyi_failed: { title: '这篇风信没有写完。', body: '当天的对话和听歌记录还在，可以重新生成。', actionLabel: '重新生成' },
  task_failed: { title: '这个动作没有完成。', body: '这是系统失败，不会记成你的负反馈。原来的内容仍然保留。', actionLabel: '再试一次' },
  import_invalid: { title: '这份歌单有些字段没读懂。', body: '原有歌库和画像没有被覆盖。请修正文件后重新导入。', actionLabel: '重新选择' },
  close_busy: { title: 'Echo 还有事情在进行。', body: '可以留在托盘继续，或明确退出；未完成任务不会伪装成成功。' },
}

const FIELD_LABELS: Record<string, string> = {
  root: 'JSON 顶层',
  json: 'JSON 格式',
  tracks: 'tracks 数组',
  track: '歌曲条目',
  title: '歌名 title',
  artist: '歌手 artist',
}

export function boundaryPresentation(snapshot: UiBoundarySnapshot): BoundaryPresentation {
  const base = PRESENTATIONS[snapshot.code]
  const invalidFields = snapshot.details?.invalidFields?.map((field) => FIELD_LABELS[field] ?? field)
  const details = invalidFields?.length
    ? `需要检查：${invalidFields.join('、')}${snapshot.details?.invalidItems ? `，共 ${snapshot.details.invalidItems} 项` : ''}。`
    : ''
  return details ? { ...base, body: `${base.body} ${details}` } : base
}
