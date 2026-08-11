import { ipcMain } from 'electron'
import {
  checkNeteaseQrLogin,
  createNeteaseQrLogin,
  getNeteaseLoginState,
  importNeteaseCookie,
  loginNeteaseWithCaptcha,
  logoutNetease,
  sendNeteaseCaptcha,
} from '../netease/auth'
import { importNeteasePlaylist, listNeteasePlaylists } from '../netease/music'

export function registerNeteaseIpc(): void {
  ipcMain.handle('netease:getLoginState', () => getNeteaseLoginState())
  ipcMain.handle('netease:createQrLogin', () => createNeteaseQrLogin())
  ipcMain.handle('netease:checkQrLogin', (_event, key: string) => checkNeteaseQrLogin(key))
  ipcMain.handle('netease:sendCaptcha', (_event, phone: string) => sendNeteaseCaptcha(phone))
  ipcMain.handle('netease:loginWithCaptcha', (_event, phone: string, captcha: string) => loginNeteaseWithCaptcha(phone, captcha))
  ipcMain.handle('netease:importCookie', (_event, cookie: string) => importNeteaseCookie(cookie))
  ipcMain.handle('netease:logout', () => logoutNetease())
  ipcMain.handle('netease:listPlaylists', () => listNeteasePlaylists())
  ipcMain.handle('netease:importPlaylist', (_event, id: string) => importNeteasePlaylist(id))
}
