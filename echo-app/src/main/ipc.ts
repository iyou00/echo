import { registerAppWindowIpc } from './ipc/appWindow'
import { registerCareIpc } from './ipc/care'
import { registerChatIpc } from './ipc/chat'
import { registerHealthIpc } from './ipc/health'
import { registerNeteaseIpc } from './ipc/netease'
import { registerPlaybackIpc } from './ipc/playback'
import { registerQueueIpc } from './ipc/queue'
import { registerRecommendationIpc } from './ipc/recommendation'
import { registerSceneIpc } from './ipc/scene'
import { registerSettingsIpc } from './ipc/settings'
import { registerTasteIpc } from './ipc/taste'
import { registerVoiceIpc } from './ipc/voice'
import { registerYinyiIpc } from './ipc/yinyi'

export { broadcast, maskSettings } from './ipc/shared'

export function registerIpc(): void {
  registerSettingsIpc()
  registerHealthIpc()
  registerChatIpc()
  registerTasteIpc()
  registerYinyiIpc()
  registerQueueIpc()
  registerSceneIpc()
  registerRecommendationIpc()
  registerPlaybackIpc()
  registerAppWindowIpc()
  registerVoiceIpc()
  registerCareIpc()
  registerNeteaseIpc()
}
