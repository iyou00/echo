import { ipcMain, net } from 'electron'
import { getCloseReadiness, getUiBoundaries } from '../services/uiBoundary'
import { createUiBoundary } from '../../shared/uiBoundary'
import type { UiBoundaryCode } from '../../types/ipc'

function forcedBoundary(): UiBoundaryCode | null {
  const code = process.env.ECHO_E2E_BOUNDARY ?? ''
  if (process.env.ECHO_E2E !== '1' || !code) return null
  return code as UiBoundaryCode
}

export function registerBoundaryIpc(): void {
  ipcMain.handle('boundary:get', () => {
    const forced = forcedBoundary()
    if (forced) return [createUiBoundary(forced)]
    const forcedOffline = process.env.ECHO_E2E === '1' && process.env.ECHO_E2E_SCENARIO === 'offline'
    return getUiBoundaries(!forcedOffline && net.isOnline())
  })
  ipcMain.handle('boundary:getCloseReadiness', () => getCloseReadiness())
}
