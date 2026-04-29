/// <reference types="vite/client" />

import type { EchoApi } from './types/ipc'

declare global {
  interface Window {
    echo?: EchoApi
    ipcRenderer?: {
      on(channel: string, listener: (...args: unknown[]) => void): unknown
      off(channel: string, listener: (...args: unknown[]) => void): unknown
      send(channel: string, ...args: unknown[]): void
      invoke(channel: string, ...args: unknown[]): Promise<unknown>
    }
  }
}

export {}
