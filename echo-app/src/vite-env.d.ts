/// <reference types="vite/client" />

import type { EchoApi } from './types/ipc'

declare global {
  interface Window {
    echo?: EchoApi
  }
}

export {}
