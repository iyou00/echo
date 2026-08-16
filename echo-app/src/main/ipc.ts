import { registerAppWindowIpc } from './ipc/appWindow'
import { registerBoundaryIpc } from './ipc/boundary'
import { registerCareIpc } from './ipc/care'
import { registerChatIpc } from './ipc/chat'
import { registerHealthIpc } from './ipc/health'
import { registerNeteaseIpc } from './ipc/netease'
import { registerPlaybackIpc } from './ipc/playback'
import { registerQueueIpc } from './ipc/queue'
import { registerRecommendationIpc } from './ipc/recommendation'
import { registerRuntimeIpc } from './ipc/runtime'
import { registerSceneIpc } from './ipc/scene'
import { registerSettingsIpc } from './ipc/settings'
import { registerTasteIpc } from './ipc/taste'
import { registerVoiceIpc } from './ipc/voice'
import { registerYinyiIpc } from './ipc/yinyi'
import { registerStageContextIpc } from './ipc/stageContext'
import { registerLearnedCasesIpc } from './ipc/learnedCases'

export { broadcast, maskSettings } from './ipc/shared'

export function registerIpc(): void {
  registerBoundaryIpc()
  registerRuntimeIpc()
  registerSettingsIpc()
  registerHealthIpc()
  registerChatIpc()
  registerTasteIpc()
  registerYinyiIpc()
  registerQueueIpc()
  registerSceneIpc()
  registerStageContextIpc()
  registerLearnedCasesIpc()
  registerRecommendationIpc()
  registerPlaybackIpc()
  registerAppWindowIpc()
  registerVoiceIpc()
  registerCareIpc()
  registerNeteaseIpc()
}
