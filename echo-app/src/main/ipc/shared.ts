import { BrowserWindow } from 'electron'
import type { Settings } from '../../types/ipc'

export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

export function maskSettings(settings: Settings): Settings {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? '••••••' : '',
    },
  }
}
