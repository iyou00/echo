// 以 Electron ABI 只读查询用户数据库（ELECTRON_RUN_AS_NODE=1 electron scripts/db-query.cjs）
const Database = require('better-sqlite3')
const path = require('node:path')
const dbPath = path.join(process.env.APPDATA, 'echo-app', 'data', 'echo.db')
const db = new Database(dbPath, { readonly: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
console.log('tables:', tables.join(', '))

const query = process.argv[2]
if (query) {
  const rows = db.prepare(query).all()
  console.log(JSON.stringify(rows, null, 1))
}
