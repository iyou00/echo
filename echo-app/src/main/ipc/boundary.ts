import { ipcMain, net } from 'electron'
import { getCloseReadiness, getUiBoundaries } from '../services/uiBoundary'

export function registerBoundaryIpc(): void {
  ipcMain.handle('boundary:get', () => {
    const forcedOffline = process.env.ECHO_E2E === '1' && process.env.ECHO_E2E_SCENARIO === 'offline'
    return getUiBoundaries(!forcedOffline && net.isOnline())
  })
  ipcMain.handle('boundary:getCloseReadiness', () => getCloseReadiness())
}
