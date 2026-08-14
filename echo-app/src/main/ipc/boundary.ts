import { ipcMain, net } from 'electron'
import { getCloseReadiness, getUiBoundaries } from '../services/uiBoundary'

export function registerBoundaryIpc(): void {
  ipcMain.handle('boundary:get', () => getUiBoundaries(net.isOnline()))
  ipcMain.handle('boundary:getCloseReadiness', () => getCloseReadiness())
}
