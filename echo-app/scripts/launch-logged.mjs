// 带日志捕获启动 Echo（调试端口 9222，stdout/stderr 落盘）
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const exe = process.env.LOCALAPPDATA + '\\Programs\\Echo\\Echo.exe'
const out = fs.openSync(process.argv[2] ?? 'artifacts/live-capture/echo-main.log', 'w')
const child = spawn(exe, ['--remote-debugging-port=9222'], { detached: true, stdio: ['ignore', out, out] })
child.unref()
console.log('launched pid', child.pid)
