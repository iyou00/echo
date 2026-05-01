# 架构 + 数据流

## 核心架构(一图看懂)

```
┌─────────────────────────────────────────────────────────┐
│              Electron App(桌面应用)                    │
│                                                         │
│   ┌─────────────────┐     ┌──────────────────────────┐ │
│   │  Renderer       │◄──► │  Main Process            │ │
│   │  (React UI)     │ IPC │  (常驻 · Node.js 环境)   │ │
│   │                 │     │                          │ │
│   │  - 5 个页面     │     │  - LLM 调用              │ │
│   │  - 对话气泡     │     │  - SQLite 读写           │ │
│   │  - 播放器       │     │  - 网易云 API(import)   │ │
│   │  - 音浪 / 波形  │     │  - 定时任务              │ │
│   └─────────────────┘     └──────────┬───────────────┘ │
│                                      │                  │
└──────────────────────────────────────┼──────────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              │                        │                          │
              ▼                        ▼                          ▼
    ┌──────────────────┐    ┌──────────────────┐      ┌──────────────────┐
    │  SQLite 本地     │    │  LLM 提供商      │      │  网易云服务器    │
    │                  │    │                  │      │                  │
    │  - 品味档案      │    │  原生 fetch 调用 │      │  通过非官方 SDK  │
    │  - 对话历史      │    │  OpenAI 兼容协议 │      │  直接 import     │
    │  - 风信 / 听歌   │    │  端点可配置      │      │  - 搜歌/播放/歌单│
    │  - cookie(加密)│    │  (DeepSeek 等) │      │  - 用户听歌历史  │
    └──────────────────┘    └──────────────────┘      └──────────────────┘
```

> **网易云数据层架构**:`@neteasecloudmusicapienhanced/api` 包**直接 import 到主进程**,
> 以函数调用方式使用——**不**启动本地 HTTP 服务、**不**额外占端口、**不**起独立子进程。
> 用户启动 app 时不会看到任何"启动服务"的过程。这一层的封装见 `main/netease/`。


## 为什么 Electron 双进程这么重要

Electron 天生是**双进程**:
- **主进程**(Node.js 环境):可以读文件、跑定时器、调 API、操作数据库
- **渲染进程**(浏览器环境):只能画 UI,不能直接碰系统资源

**Echo的"常驻感"来自主进程:**
- 你关掉主窗口,主进程默认还活着(我们设置成这样)
- 定时任务在主进程跑 → 到了晚上 22:00 即使窗口关着,风信也能生成
- 下次打开窗口,读库显示今天的风信

**渲染进程只负责 UI,不直接干重活:**
- 用户点"推荐一首歌" → IPC 发消息给主进程
- 主进程:读品味档案 → 调 LLM → 存对话 → 返回结果
- 渲染进程收到结果,画出来

## 主进程的模块划分

```
main/
├─ index.ts             # 入口,启动所有服务
├─ ipc.ts               # IPC 路由表(UI ↔ 主进程)
│
├─ db/                  # 存储层
│   ├─ schema.ts        # 表定义(详见 data-model.md)
│   ├─ taste.ts         # TasteProfile 读写
│   ├─ conversations.ts # 对话历史读写
│   ├─ events.ts        # 中期事件记忆
│   └─ yinyi.ts         # 风信历史
│
├─ llm/                 # LLM 调用层
│   ├─ client.ts        # LLM HTTP 客户端封装(原生 fetch + OpenAI 兼容)
│   ├─ prompt.ts        # prompt 组装(读 prompts/*.md + 拼上下文)
│   └─ stream.ts        # 流式响应(给前端实时打字)
│
├─ services/            # 业务层
│   ├─ chat.ts          # 聊天主逻辑
│   ├─ recommender.ts   # 推歌:决定推什么 + 为什么
│   ├─ yinyi.ts         # 风信生成
│   ├─ taste.ts         # 品味档案演化(从行为推断)
│   ├─ scenario.ts      # 语音模式的 100 字文案生成
│   └─ settings.ts      # 设置读写 + apiKey 加密 + 测试 LLM 连接
│
├─ netease/             # 网易云桥接(直接 import @neteasecloudmusicapienhanced/api)
│   ├─ auth.ts          # 扫码登录 + cookie 加密存取(safeStorage)
│   └─ music.ts         # searchTrack / getPlayUrl / getPlaylist / getUserHistory
│                       # ↑ 业务封装,屏蔽 SDK 细节,方便日后切换音乐源
│
└─ scheduler.ts         # node-cron:风信(从 settings.yinyi.generateAt 读时间)、主动推送
```

## 渲染进程的页面划分

```
renderer/pages/
├─ Chat.tsx          # 絮语(对应 design/main-view.html)
├─ Voice.tsx         # 语音模式(对应 design/voice-mode.html)
├─ EchoProfile.tsx   # Echo 主页 ≈ 品味档案(点头像进入,对应 design/profile.html)
├─ Yinyi.tsx         # 风信日记(对应 design/yinyi.html)
├─ Queue.tsx         # 列表(对应 design/queue.html)
└─ Settings.tsx      # 设置(从 EchoProfile 右上角齿轮进入,对应 design/settings.html)
```

## 核心数据流举例

### 场景 1:用户打开Echo,发"推荐几首安静的"

```
1. 用户点开 app
   → 渲染进程启动,调 IPC 拿最近对话历史
   → 画出对话界面

2. 用户输入"推荐几首安静的",回车
   → 渲染进程 IPC 调 main.chat.send(message)

3. 主进程 chat.ts:
   a. 存用户消息到 conversations
   b. 组装 prompt:
      - system = prompts/system.md(Echo人格)
      - context = TasteProfile + 最近 5 条消息 + 当前时间 + 中期事件
      - user = "推荐几首安静的"
   c. 调 LLM(从 settings 读 baseUrl/apiKey/model · OpenAI 兼容协议),带流式输出
   d. 流式把 LLM 输出回传渲染进程(逐字显示)
   e. LLM 返回结构化歌曲推荐(由 prompt 规定 JSON 格式)
   f. 每首歌通过 netease/music.ts 搜索,拿到真实歌曲 ID 和播放链接
   g. 把带播放链接的卡片推给渲染进程

4. 渲染进程:
   - 逐字显示Echo的话
   - 在话里嵌歌曲卡片
   - 用户点播放 → audio 播放 → 底部音浪更新
```

### 场景 2:每晚 22:00 生成风信

```
1. scheduler.ts 到点,调 services/yinyi.ts
2. yinyi.ts:
   a. 读今天的对话历史 + 播放记录 + 品味变化
   b. 组装 prompt:prompts/yinyi-writer.md + 今日数据
   c. 调 LLM,生成一段对话型日记
   d. 存入 yinyi 表
   e. 通过 IPC 发给渲染进程(如果开着窗口):弹通知"今日风信已出"
```

### 场景 3:用户点顶部头像进主页

```
1. 渲染进程 IPC 调 main.taste.get()
2. 主进程读 SQLite 返回 TasteProfile JSON
3. 渲染进程渲染结构化视图:
   - 流派权重条
   - 钟爱艺人 top 10
   - 代表曲目 7 首
   - 它写给你的一段话(缓存的,上次生成时存的)
```

## Echo"常驻"的具体配置

Electron 默认"最后一个窗口关了就退出 app"。Echo要反过来:

```typescript
// main/index.ts
app.on('window-all-closed', () => {
  // 不做任何事 → 主进程继续跑
  // (macOS 本来就这样;Windows 我们也这样处理)
})
```

要彻底退出只能从系统托盘图标右键 → 退出。

## 性能 / 成本注意

- **LLM 调用成本**:每次聊天大约 0.05 RMB 上下(以 DeepSeek 等中转为例;具体取决于所选模型和上下文长度)
- **上下文控制**:对话历史只拼最近 N 条到 prompt,太长的让 LLM 自己做中期摘要存 `events` 表
- **提前做压缩**:超过 30 条对话后,自动把更早的压缩成"事件摘要",原文归档
