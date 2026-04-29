# Feature · 播放器(Playback)

> **核心定位**:Echo 的播放器**不是**这个产品的卖点,但**必须做到位**——
> 一旦体验掉档(播不了、卡顿、音质差),整个"懂你的朋友"幻觉就破了。
>
> **对应 UI**:`design/main-view.html`(底部播放条)、`design/queue.html`(队列)
> **对应代码模块**:`src/main/netease/music.ts`、`src/renderer/components/Player.tsx`、`src/renderer/components/Wave.tsx`
> **依赖**:`@neteasecloudmusicapienhanced/api`、`features/recommendation.md`

---

## 1 · 这个功能要做什么

**v0.1**:歌曲只是"卡片",点击不实际播放——卡片上有个占位的播放图标但点了无效或弹"v0.2 才能放"

**v0.2**:真正能播放——
- 从网易云搜歌、取链接、HTML5 audio 播放
- 底部播放条 + 实时音浪 + 分段进度条
- 队列管理(增删改查、拖拽排序)
- 播放行为反馈到 TasteProfile

**v0.3**:补 polish——
- 静音 / 音量 / 倍速
- 桌面通知集成播放控制(媒体快捷键)
- "播放历史"成为独立页面

## 2 · 用户故事

| # | 我作为用户 | 想要 | 这样我就能 |
|---|---|---|---|
| US-1 | 普通用户 | 在对话里点歌曲卡片立刻播放 | 一气呵成不切页面 |
| US-2 | 普通用户 | 底部固定一个播放条,任何页面都能控制 | 在写音忆的时候能切歌 |
| US-3 | 普通用户 | 看到实时音浪反映当前歌曲 | 视觉和听觉同步 |
| US-4 | 普通用户 | 队列里能拖拽调整顺序、移除、清空 | 管理我的播放列表 |
| US-5 | 普通用户 | 关闭主窗口后播放继续(后台播放) | 边做事边听 |
| US-6 | 普通用户 | 切到其他播放器后这边自动暂停(可选) | 不打架 |
| US-7 | 普通用户 | 网络不稳时知道是网络问题不是 app 问题 | 不会怪 Echo |
| US-8 | 普通用户 | 网易云没登录时友好提示去登录 | 知道下一步做什么 |

## 3 · 架构概览

```
[渲染进程 React Player.tsx]
   │
   ├─ HTML5 <audio> 标签 → 实际音频解码 + 播放
   ├─ Web Audio API → 接 <audio> 拿实时频谱 → 渲染音浪
   │
   └─ IPC → 主进程
              │
              ├─ netease/music.ts:getPlayUrl(trackId)
              │     ↓ 返回真实流媒体 URL
              ├─ 监听 'window-all-closed' → 不退出 → 后台继续播
              └─ 监听媒体快捷键(v0.3+)
```

**关键决策**:
- **<audio> 在渲染进程**(不在主进程)—— Electron 的渲染层是 Chromium,音频解码原生支持
- **网易云调用在主进程** —— 涉及 cookie / API,渲染进程不接触敏感数据
- **音频流 URL 跨进程传递,不传二进制** —— 主进程拿到 URL 后通过 IPC 传给渲染,渲染让 `<audio>` 自己拉流

## 4 · 数据流 · 一首歌从推荐到播放

```
[用户在对话里点 track card 的播放按钮]
    │
    ▼
[Player.tsx onClick]
    │
    ├─ 当前在播 → 加到队列尾
    └─ 当前没播 → 立刻播放(走下面)
    │
    ▼
[IPC: playback.play({ trackId })]
    │
    ▼
[主进程 playback.ts:resolveAndPlay()]
    │
    ├─ 1. 查 netease/music.ts:getPlayUrl(trackId)
    │      └─ 内部调 song_url_v1 接口,处理解灰
    │
    ├─ 2. 拿到 stream URL(http/https,有时效)
    │
    └─ 3. 通过 IPC 推给渲染进程
    │
    ▼
[渲染进程 Player.tsx:setSource(url)]
    │
    ├─ <audio src={url} autoplay />
    ├─ Web Audio API 接管 → 输出频谱给 Wave.tsx
    │
    ▼
[歌曲开始播放]
    │
    ├─ 进度条更新
    ├─ 音浪跳动
    └─ 每秒发心跳给主进程(用于 30 秒后写入听歌记录)
```

## 5 · 网易云调用细节

### 5.1 取播放链接

```typescript
// src/main/netease/music.ts
import { song_url_v1 } from '@neteasecloudmusicapienhanced/api';

export async function getPlayUrl(trackId: string): Promise<PlayUrlResult> {
  const cookie = await auth.getCookie();
  if (!cookie) {
    return { ok: false, kind: 'NOT_LOGGED_IN' };
  }
  
  try {
    const res = await song_url_v1({
      id: trackId,
      level: 'standard',     // standard / higher / exhigh / lossless
      cookie,
    });
    
    const data = res.body?.data?.[0];
    if (!data?.url) {
      return { ok: false, kind: 'NO_URL', message: '版权问题或地区限制' };
    }
    
    return {
      ok: true,
      url: data.url,
      durationMs: data.time,
      bitrate: data.br,
      expiresAt: Date.now() + 20 * 60 * 1000,  // URL 一般 20-30 分钟过期
    };
  } catch (e) {
    return { ok: false, kind: 'NETWORK_ERROR', message: humanize(e) };
  }
}
```

### 5.2 解灰(灰歌处理)

部分 VIP / 下架歌曲走"解灰"路径——`@neteasecloudmusicapienhanced/api` 启用 `ENABLE_GENERAL_UNBLOCK` 后会自动从其他源(如 QQ / 酷狗)拿替代流媒体。

**v0.1**:不开解灰(避免引入额外风险)
**v0.2**:用户设置里加一个"启用解灰(实验性)"开关,默认关
**v0.3+**:观察使用情况决定是否默认开

### 5.3 URL 过期处理

网易云返回的 URL 一般 20-30 分钟过期。如果一首长歌恰好播到一半 URL 失效:

- `<audio>` 会触发 `error` 事件
- Player.tsx 调主进程刷新一次 URL
- 重新设置 `<audio src>` 并 seek 到原来位置
- 用户看到极短卡顿(~500ms),但不会断

队列里**未来要播的歌**不预先取 URL,**要播的下一首**在前一首播到 80% 时预取(避免连播间隙)。

## 6 · 播放器 UI 行为(对应 design/main-view.html 底部播放条)

### 6.1 状态机

```
[idle / 队列空]
   │
   ▼
[loading · 取 URL 中]  ←─── 用户点播放按钮
   │
   ▼
[playing] ──pause/click─→ [paused]
   │                          │
   │                          └─resume─┐
   │                                   ↓
   ├──end of track──→ [next] → [loading] → [playing]
   │
   ├──error──→ [error · 弹友好提示] → 自动跳下一首
   │
   └──user click track──→ [loading]
```

### 6.2 控制按钮

底部播放条始终显示(任何页面都在),5 个元素从左到右:

1. **当前歌曲信息**(标题 + 艺人 · 等宽字体)
2. **音浪图**(36 根竖线 · 实时频谱)
3. **上一首 / 暂停-播放 / 下一首** 按钮
4. **进度条**(分段 30 段 · 当前 vs 总时长)
5. **(v0.3 候选)** 音量、循环模式、队列展开按钮

### 6.3 实时音浪 · Web Audio API

```typescript
// Wave.tsx 大致逻辑
const audio = document.querySelector<HTMLAudioElement>('#player');
const ctx = new AudioContext();
const source = ctx.createMediaElementSource(audio);
const analyser = ctx.createAnalyser();
analyser.fftSize = 64;  // 32 个频段(36 根条但中间几根可以是均值)

source.connect(analyser);
analyser.connect(ctx.destination);

function tick() {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  // 把 32 个频段映射到 36 根条
  // 每根条的高度 = data[i] / 255 (0-1)
  requestAnimationFrame(tick);
}
```

**性能预算**:60fps · CPU 占用 < 2%(Chromium 的 Web Audio 是硬件加速的,问题不大)

**特殊状态**:
- 暂停时:音浪保持上一帧,不归零(美观)
- Echo 在说话时(语音模式或 TTS · v0.3):音浪用**主色**而不是绿,做"双声道"区分
- idle / 没在放:音浪保持低幅扁平动画(像呼吸)

### 6.4 进度条 · 30 段

```typescript
const segments = 30;
const filled = Math.floor((currentTime / duration) * segments);
// 渲染 30 个 <span>,前 filled 个用主色,后面用 border 色
```

**点击 / 拖拽 seek**:
- 点击某一段 = seek 到对应百分比
- 拖拽时显示一个微小的时间气泡 hover

### 6.5 加载态

歌曲切换 → URL 还没拿到时:
- 标题 / 艺人保留上一首,但加 30% 透明度 + 一个旋转的小 dot
- 音浪保持上一帧
- 进度条变灰

加载超过 3 秒:文字提示"网络好像有点慢…",10 秒还没好就报错。

## 7 · 队列(Queue)管理

### 7.1 队列类型

Echo 内部有**两个队列**:

| 队列 | 用途 |
|---|---|
| `currentQueue` | 当前正在播 + 接下来要播的 |
| `echoStash` | Echo 准备的"备选歌单"(对应 design/queue.html 中"Echo 给你准备的"卡片) |

`echoStash` 由 recommender.ts 在用户进列表页时**临时**生成(不持久化),3 张卡片对应 3 个不同的情境主题。点其中一张的"播放" → 整张接到 `currentQueue` 末尾。

### 7.2 队列状态

```typescript
interface PlaybackState {
  current: Track | null;
  position: number;           // ms
  duration: number;           // ms
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  queue: Track[];             // 不含 current,从下一首开始
  loop: 'none' | 'one' | 'all';   // v0.3+
  shuffle: boolean;            // v0.3+
}
```

### 7.3 队列操作

| 操作 | 行为 |
|---|---|
| 添加到队列尾 | `queue.push(track)` |
| 添加到队列头(下一首播) | `queue.unshift(track)` |
| 立刻播放 | `current = track; queue = []`(替换)or `queue.unshift(track)` 然后 next() |
| 移除 | `queue.splice(index, 1)`,如果 current 被移除则自动 next |
| 拖拽排序 | 重排 queue 数组 |
| 清空队列 | `queue = []`(不影响 current) |

### 7.4 拖拽排序实现

用 HTML5 原生 `draggable` API,**不引入** react-dnd 这类重库。
原型已经在 `design/queue.html` 实现了基础版,React 版用 `react-grid-dnd` 或者直接 wrap HTML5 API。

## 8 · 播放行为反馈到 TasteProfile

每首歌播放结束(或被切),记一条 `tracks_listened`,然后调 `taste.ts:applySignal()`:

| 行为 | TasteProfile 信号 |
|---|---|
| 听完(>= 80% 时长 OR 收尾切下一首) | `played` —— 加 affinity / weight |
| 半路切歌(< 30% 时长) | `skipped` —— 减 affinity |
| 同一首 24h 内循环 >= 3 次 | `looped` —— 标 candidate signature |
| Echo 推的被秒切 | `rejected_recommendation` —— 调低 discovery |
| 用户主动播了一首 Echo 没推过的 | `self_picked` —— 加 discovery |

**心跳频率**:渲染进程每 5 秒发一次心跳给主进程(包含 currentTime),主进程在歌曲切换 / 暂停 / 退出时记录最终听到了哪里。
**不在每次心跳都写 DB**——只在状态变化时写。

## 9 · 后台播放

Electron 默认"主窗口关了就退出 app"。Echo 反过来:

```typescript
// main/index.ts
app.on('window-all-closed', () => {
  // 不退出,主进程继续跑
  // 系统托盘图标常驻(v0.3+,先无图标也能跑)
});

app.on('before-quit', () => {
  // 用户从托盘明确退出时,保存当前播放状态
  saveSnapshot({ track, position, queue });
});
```

**关键问题**:窗口关了之后,**渲染进程的 `<audio>` 不在了,音频也停了**。这是 Electron 的硬限制。

两个解决方案:

**方案 A · v0.2 简单做法 · "关窗口=最小化"**
- 关窗口的 X 按钮拦截 → 改成最小化到托盘
- 用户必须从托盘"退出"才真正关 app
- 优点:简单,音频继续播
- 缺点:用户期望关 = 关,需要教育

**方案 B · v0.3+ 完整做法 · "BackgroundFetch / 主进程播放"**
- 关窗口后,把当前 stream URL + position 转交给主进程
- 主进程用 Node 的 audio 库继续播(选项:`node-speaker`、 `ffplay`)
- 用户重开窗口时无缝接回渲染进程
- 优点:符合用户习惯
- 缺点:Node audio 库都不那么稳,Windows 兼容性各异

**v0.1 / v0.2 选 A**(关窗口 = 最小化到托盘 / 不关闭),v0.3 评估方案 B。

## 10 · 失败模式

| 场景 | 处理 |
|---|---|
| 网易云未登录 | track card 上加锁图标 + 点击弹"先去设置里登录?" |
| 取 URL 接口报错 | track card 显示"播不出来,我推这首但版权问题",卡片标灰,自动跳下一首 |
| URL 过期(中途) | 静默重取一次,seek 回原位置 |
| 解灰失败(开了解灰但找不到替代源) | 同"取 URL 报错" |
| 网络断开 | 顶部出现一条 banner "网络断了,Echo 等你回来",已加载部分继续放完 |
| 同时打开了网易云客户端在放歌 | 不主动暂停对方,允许两边都在响——用户自己处理 |
| `<audio>` 解码失败(罕见) | 跳下一首 + 日志记错 |
| 队列空 | 底部播放条隐藏 / 折叠 |

## 11 · 性能预算

| 指标 | 目标 |
|---|---|
| 点播放 → 实际出声 | 网络好时 < 1.5s,差时 < 4s |
| 切歌(已加载) | < 100ms |
| 音浪渲染 | 60fps · CPU < 2% |
| 队列拖拽 | 视觉立即响应,无掉帧 |
| 后台播放 CPU 占用 | < 1% (idle 状态) |

## 12 · v0.1 范围切分

### v0.1(MVP)· 不接网易云
- [x] track card 在对话里展示
- [x] 卡片上的播放按钮**显示**但点击只弹"v0.2 解锁"
- [x] 底部播放条 UI(占位 · 不真播)
- [x] 队列页面 UI(展示用)

### v0.2 · 真播放
- [ ] 网易云登录 + cookie 加密存储
- [ ] song_url_v1 接入
- [ ] HTML5 audio 播放
- [ ] 实时音浪(Web Audio API)
- [ ] 队列增删改查 + 拖拽排序
- [ ] 听歌行为反馈到 TasteProfile
- [ ] 后台播放(方案 A · 最小化到托盘)
- [ ] URL 过期自动续

### v0.3+
- [ ] 解灰开关
- [ ] 系统媒体快捷键集成
- [ ] 音量 / 循环 / shuffle
- [ ] 后台播放方案 B(主进程播)
- [ ] 播放历史独立页面

## 13 · IPC 接口

```typescript
// 渲染 → 主
playback.resolveUrl(trackId): Promise<PlayUrlResult>
playback.recordSignal({ trackId, kind, position, duration }): Promise<void>
playback.saveSnapshot(state): Promise<void>      // 退出前保存
playback.loadSnapshot(): Promise<PlaybackState | null>  // 启动恢复

// 主 → 渲染
'playback:url-refreshed' → { trackId, url }      // URL 续期
'playback:command' → { kind: 'play' | 'pause' | 'next' | 'prev' }   // 来自系统媒体快捷键 (v0.3+)
```

## 14 · 测试场景

| 场景 | 预期 |
|---|---|
| v0.1 点 track card 播放按钮 | 弹友好提示 "播放功能 v0.2 解锁" |
| v0.2 已登录,点播放 | 1.5 秒内出声,音浪开始跳 |
| v0.2 未登录,点播放 | 弹"先去登录"引导 |
| 一首歌播到 28 分钟,URL 过期 | 自动续期,seek 回 28 分,体感无感 |
| 拖拽队列里第 3 首到第 1 位 | 立刻生效,下一首播这个 |
| 关闭主窗口 | 应用最小化到托盘,音乐继续 |
| 从托盘退出 | 保存当前状态,下次启动恢复到这首歌(暂停态) |
| 听完 3 遍同一首歌 | 这首被标 candidate signature_track |
| 网易云推荐了一首歌但版权下架 | 卡片显示"播不出来",对话不中断 |
