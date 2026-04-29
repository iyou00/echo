# 技术栈 + Windows 开发环境

> 目标读者有两类:**负责开发的 AI**(Cursor / Codex / Claude Code)+ **不懂代码的产品经理(用户本人)**。
> 所以这份文档既讲"用什么"也讲"为什么",方便用户看懂 AI 在干什么。

## 技术选型一览

| 层 | 选择 | 原因 |
|---|---|---|
| 桌面壳 | **Electron** | Windows / macOS / Linux 全通;生态成熟;AI 对它熟悉 |
| 语言 | **TypeScript** | 前后端同一门语言;LLM SDK 对 TS 支持最完整 |
| 前端框架 | **React** | 生态最大;和 HTML 原型同构最顺 |
| 样式 | **Tailwind CSS** | 快;设计 tokens 容易映射 |
| 构建 | **Vite + electron-vite** | 启动快;dev / prod 打包简单 |
| 后台(主进程) | **Node.js**(Electron 主进程) | 常驻跑定时任务、调 LLM、操作 SQLite |
| LLM 调用 | **原生 `fetch`** + **OpenAI 兼容协议** | 不用 SDK · 自己写薄客户端(~200 行)· 端点在设置里随时改 |
| 本地存储 | **SQLite** (`better-sqlite3`) | 零配置;备份 = copy 一个文件;关系型适合品味档案 |
| 定时任务 | **node-cron** | 跑音忆日记生成、主动推送 |
| 音乐数据 | **`@neteasecloudmusicapienhanced/api`** · Node.js 包,**直接 import 到主进程**,不启额外服务 | 社区维护的 Binaryify NeteaseCloudMusicApi 接力版 · 接口最全 + TS ready + 内置解灰 |
| 播放 | **HTML5 `<audio>` 标签** | Electron 内置支持;v0.1 够用 |
| TTS(v0.3+) | 待定,候选:微软 Edge TTS(免费)/ ElevenLabs(收费好听) | |

## 为什么**不**用这些

- ❌ **Claude Agent SDK / pi-ai / openai SDK** — Echo 对 LLM 的需求只是"流式聊天 + tool use",约 200 行 fetch 代码就能写完,且能直接接任何 OpenAI 兼容的第三方端点(DeepSeek/Kimi/Moonshot/智谱等)。SDK 反而是黑盒 + 多一层依赖
- ❌ **OpenClaw / Hermes Agent** — 它们是消息平台 bot 形态,和 Echo 的桌面独立 UI 需求错配
- ❌ **Tauri** — 比 Electron 更轻,但生态小;当前阶段 Electron 更稳

## 架构总览(一句话)

**一个 Electron app,主进程常驻跑后台服务,渲染进程跑 React UI,两者通过 IPC 通信。**

详细架构看 `specs/architecture.md`。

---

## Windows 开发环境搭建(给用户/AI 一步步做)

### 前置:已装好的东西

用户已装:
- [x] Node.js(需要 v20+ 版本;`node -v` 可验证)

### 还需要装:

1. **Git**
   - 下载:https://git-scm.com/download/win
   - 作用:版本控制,让 AI 能看 commit 历史

2. **VS Code 或 Cursor**(推荐 Cursor,因为它内嵌 AI)
   - Cursor:https://cursor.sh
   - VS Code:https://code.visualstudio.com

3. **pnpm**(比 npm 快很多)
   - 装:`npm install -g pnpm`

4. **Python**(`better-sqlite3` 在 Windows 编译时需要)
   - 下载:https://python.org(3.10+)
   - 装的时候勾上 "Add Python to PATH"

5. **Visual Studio Build Tools**(原生 C++ 编译依赖)
   - 下载:https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - 装的时候选 "Desktop development with C++"
   - 📌 这步不装,`better-sqlite3` 可能装不上

### 验证:

```bash
node -v      # 应显示 v20.x 或更高
pnpm -v      # 应显示版本号
python --version  # 应显示 3.10+
git --version     # 应显示版本号
```

### 密钥准备

- **LLM 提供商账号 + API Key**
  - 任选一个 OpenAI 兼容服务,例如:
    - DeepSeek:https://platform.deepseek.com(便宜,中文友好)
    - Kimi(Moonshot):https://platform.moonshot.cn
    - 智谱:https://open.bigmodel.cn
    - OpenRouter(转售各种 Claude/GPT):https://openrouter.ai
    - 或任何"Claude API 中转"服务
  - 在他们后台创建 API Key
  - **不需要写到 .env 文件**——首次启动 Echo 后在**设置页**填入,加密存到本地 SQLite
  - 后续随时可在设置页切换提供商

- **网易云登录**(v0.2 接 API 时必需)
  - 用户首次启用音乐播放时,在 app 内**扫码登录**自己的网易云账号
  - 登录拿到的 cookie 存在本地 SQLite,加密(用 Electron 的 `safeStorage`)
  - 不存密码,只存 cookie。cookie 失效用户重新扫码即可
  - v0.1 不需要,v0.2 才接

---

## 项目结构预览(v0.1)

```
echo-app/
├─ package.json
├─ electron.vite.config.ts
├─ src/
│   ├─ main/                   # Electron 主进程(Node.js 环境)
│   │   ├─ index.ts            # 入口
│   │   ├─ db/                 # SQLite 封装
│   │   ├─ llm/                # LLM 客户端(原生 fetch + OpenAI 兼容协议)+ prompt 组装
│   │   ├─ netease/            # 网易云桥接(直接 import @neteasecloudmusicapienhanced/api)
│   │   │   ├─ auth.ts         # 扫码登录 + cookie 管理
│   │   │   └─ music.ts        # 搜索 / 取播放链接 / 歌单 / 听歌历史
│   │   ├─ services/
│   │   │   ├─ chat.ts         # 聊天主逻辑
│   │   │   ├─ recommender.ts  # 推荐引擎
│   │   │   ├─ yinyi.ts        # 音忆生成
│   │   │   └─ taste.ts        # 品味档案演化
│   │   └─ scheduler.ts        # node-cron 定时任务
│   ├─ preload/                # Electron preload(桥接)
│   └─ renderer/               # React UI(浏览器环境)
│       ├─ App.tsx
│       ├─ components/
│       ├─ pages/
│       │   ├─ Chat.tsx        # 主对话界面
│       │   ├─ Voice.tsx       # 语音模式
│       │   ├─ EchoProfile.tsx # Echo 主页
│       │   ├─ Yinyi.tsx       # 音忆日记
│       │   └─ Queue.tsx       # 列表页(队列 + Echo 备选)
│       └─ styles/tokens.css   # 视觉 tokens(从 design/tokens.md 同步)
├─ prompts/                    # System prompt 等(可改不重编译)
│   ├─ system.md
│   ├─ scenario-100.md
│   └─ yinyi-writer.md
└─ data/                       # 用户数据(本地持久化)
    └─ echo.db                 # SQLite 文件,可直接备份
```

## 常用命令(v0.1 完成后)

```bash
pnpm install        # 装依赖
pnpm dev            # 开发模式(带热更新)
pnpm build          # 打包成 exe
pnpm typecheck      # 类型检查
```

---

## 网易云数据层 · 已知风险与缓解

使用 `@neteasecloudmusicapienhanced/api` 是一个 **务实但有风险** 的选择。开发前必须知晓:

### 风险

1. **法律灰色地带** —— 非官方 API,网易云可随时变更接口或封 cookie
2. **接口稳定性** —— 依赖社区维护,大版本接口可能微变
3. **解灰功能** —— 触及版权,**不能商业化、不能上 App Store**;仅作个人工具
4. **cookie 失效** —— 用户 cookie 有有效期,定期需重新登录

### 缓解策略

1. **存储抽象层** —— 在 `main/netease/` 内部封装,业务层只调 `searchTrack()`、`getPlayUrl()` 这种业务 API。**未来要换 Spotify / Apple Music 时,只动这一层**
2. **优雅降级** —— 接口失败时:
   - 推歌降级:Echo 改为"我推这首,但播不出来,你可以去网易云听"——不影响对话体验
   - 不弹技术错误,Echo 用人话告诉用户
3. **cookie 加密存储** —— 用 Electron `safeStorage` API 加密,绑定操作系统钥匙串
4. **版本锁** —— `package.json` 里锁住具体版本,大升级前手动测试再升

### 长期方向

v0.4+ 候选:**让用户选音乐源**(网易云 / Spotify / Apple Music / 本地文件)。Spotify 和 Apple Music 是真正的合规接入,只是国内用户少。
