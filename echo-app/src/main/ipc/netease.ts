import { ipcMain } from 'electron'
import { checkNeteaseQrLogin, createNeteaseQrLogin, getNeteaseLoginState, logoutNetease } from '../netease/auth'
import { importNeteasePlaylist, listNeteasePlaylists } from '../netease/music'

export function registerNeteaseIpc(): void {
  ipcMain.handle('netease:getLoginState', () => getNeteaseLoginState())
  ipcMain.handle('netease:createQrLogin', () => createNeteaseQrLogin())
  ipcMain.handle('netease:checkQrLogin', (_event, key: string) => checkNeteaseQrLogin(key))
  ipcMain.handle('netease:logout', () => logoutNetease())
  ipcMain.handle('netease:listPlaylists', () => listNeteasePlaylists())
  ipcMain.handle('netease:importPlaylist', (_event, id: string) => importNeteasePlaylist(id))
}
