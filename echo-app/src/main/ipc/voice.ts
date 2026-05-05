import { ipcMain } from 'electron'
import { getSettings } from '../services/settings'
import { generateVoiceLine } from '../services/voice'
import { synthesize, testTts } from '../tts/client'
import { getWeather } from '../weather/client'
import { generateListeningSegment } from '../services/listening'

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:generate', () => generateVoiceLine())
  ipcMain.handle('tts:synthesize', (_event, text: string) => synthesize(text))
  ipcMain.handle('tts:test', () => testTts())
  ipcMain.handle('weather:get', (_event, city?: string) => getWeather(city || getSettings().user.city))
  ipcMain.handle('listening:generateSegment', (_event, options?: { continuation?: boolean }) => generateListeningSegment(options))
}
