import { ipcMain } from 'electron'
import { getSettings } from '../services/settings'
import { synthesize, testTts } from '../tts/client'
import { getWeather } from '../weather/client'
import { listeningSegmentAgent } from '../services/listeningAgent'
import { voiceLineAgent } from '../services/voiceAgent'
import { runAgent } from '../runtime/runtime'

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:generate', () => runAgent(voiceLineAgent, undefined, {
    phase: 'generate',
    total: 1,
    cancellable: true,
    uniqueKey: 'voice-line',
    messageForResult: () => '口播文案已生成。',
  }))
  ipcMain.handle('tts:synthesize', (_event, text: string) => synthesize(text))
  ipcMain.handle('tts:test', () => testTts())
  ipcMain.handle('weather:get', (_event, city?: string) => getWeather(city || getSettings().user.city))
  ipcMain.handle('listening:generateSegment', (_event, options?: { continuation?: boolean }) => runAgent(listeningSegmentAgent, options, {
    phase: 'generate',
    total: 4,
    cancellable: true,
    uniqueKey: 'listening-segment',
    isFailureResult: (segment) => Boolean(segment.error),
    messageForResult: (segment) => segment.error ?? '回声片段已生成。',
  }))
}
