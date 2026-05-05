import { ipcMain } from 'electron'
import { cancel, loadRecent, send } from '../services/chat'

export function registerChatIpc(): void {
  ipcMain.handle('chat:send', (event, text: string) => send(text, event.sender))
  ipcMain.handle('chat:loadRecent', (_event, limit?: number) => loadRecent(limit))
  ipcMain.handle('chat:cancel', () => cancel())
}
