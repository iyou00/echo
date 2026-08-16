// 以 Electron ABI 对用户数据库执行一条 UPDATE（ELECTRON_RUN_AS_NODE=1 electron scripts/db-update.cjs "SQL"）
// 仅用于本机验证：改完要恢复的值请记下来。
const Database = require('better-sqlite3')
const path = require('node:path')
const dbPath = path.join(process.env.APPDATA, 'echo-app', 'data', 'echo.db')
const db = new Database(dbPath)
const sql = process.argv[2]
const allowed = /^UPDATE /i.test(sql)
  || /^INSERT INTO learned_cases /i.test(sql)
  || /^DELETE FROM learned_cases /i.test(sql)
if (!sql || !allowed) {
  console.error('only UPDATE, or learned_cases INSERT/DELETE allowed')
  process.exit(1)
}
const result = db.prepare(sql).run()
console.log(JSON.stringify({ changes: result.changes }))
db.close()
