import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './renderer/theme/tokens.css'
import './renderer/theme/shell.css'
import './renderer/theme/core.css'
import './renderer/theme/profile.css'
import './renderer/theme/queue.css'
import './renderer/theme/yinyi.css'
import './renderer/theme/voice.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
