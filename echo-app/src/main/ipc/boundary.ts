import { ipcMain, net } from 'electron'
import { getUiBoundaries } from '../services/uiBoundary'

export function registerBoundaryIpc(): void {
  ipcMain.handle('boundary:get', () => getUiBoundaries(net.isOnline()))
}
