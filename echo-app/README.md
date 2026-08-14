# Echo App

Echo 的 Electron + React + TypeScript 桌面客户端。

## 开发环境

- Node.js 20+
- Python 3，仅在 `better-sqlite3` 需要本地编译时使用
- Windows 安装包由 NSIS 生成

`better-sqlite3` 必须匹配当前 Electron ABI，因此是项目级依赖，不能安全地共用全局二进制。`npm install` 会自动探测系统 Python 或 Codex 工作区 Python，并将原生模块重建为当前 Electron 版本。Vitest 同样使用 Electron 的 Node 运行时，不需要手工切换 ABI。

## 常用命令

```bash
npm install
npm run dev
npm test
npm run verify
npm run release:verify
```

- `npm run verify`：lint、全量测试、生产构建和 Electron 真窗口截图验收。
- `npm run dist`：完整验证后生成 `release/Echo-Setup-<version>.exe`。
- `npm run release:verify`：生成安装包，并真实验证安装、打包版首次启动、覆盖更新和卸载。

## 发布行为

- 安装：使用可选择目录的 NSIS 安装器，创建桌面和开始菜单入口。
- 更新：当前采用下载新版 Setup 后原位置覆盖安装；相同 `appId` 保持安装身份，用户设置、画像和聊天数据不会被覆盖。尚未接入发布服务器，因此当前版本不声称支持联网自动更新。
- 卸载：交互卸载会询问是否删除本地数据，默认保留；静默卸载始终保留用户数据。程序目录会完整清除。
- 隐私：prompt 源文件不会以独立目录放入安装目录；密钥由 Electron `safeStorage` 加密保存。

产品规格位于上一级目录的 `specs`、`features`、`prompts` 和 `design`。
