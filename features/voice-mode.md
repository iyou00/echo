# Feature · 语音模式(Voice Mode)

> **核心理念**:Echo **会说话**。点一下输入框旁的语音按钮,Echo 用一段 100 字以内的
> 场景化文案"开口"——以此刻的时间、情境、最近的对话为底,像电台 DJ 那样和你说一句话。
>
> **对应 UI**:`design/voice-mode.html`
> **对应代码模块**:`src/main/services/scenario.ts`、`src/main/tts/*`、`src/renderer/pages/Voice.tsx`
> **依赖**:`prompts/scenario-100.md`、TTS 引擎(待选)
> **优先级**:v0.3(在絮语 + 推荐 + 风信稳定后)

---

## 1 · 这个功能要做什么

用户在主界面点麦克风按钮 → 进入语音模式全屏视图(抹茶绿底,衬线大字) → 
Echo 生成一段 70-100 字的此刻场景文案 → TTS 合成语音播放 → 
同时文字逐字"渐变展开"(已说 / 正在说 / 待说三段着色)→ 
说完后用户点"回 聊"返回絮语。

**这是 Echo 最有"灵气"的 feature**:它不像普通的 AI 助手"读你的指令、给你结果",
它是 Echo 主动在某一刻**对你说一段话**。

## 2 · 用户故事

| # | 我作为用户 | 想要 | 这样我就能 |
|---|---|---|---|
| US-1 | 普通用户 | 点语音按钮立刻看到 Echo 在"准备说话" | 不被白屏冷场 |
| US-2 | 普通用户 | 听到一段口语化的、有情境的、属于此刻的话 | 像有人在身边陪我 |
| US-3 | 普通用户 | 看到文字随说话逐字高亮 | 视听同步,加强"它在说话"的感觉 |
| US-4 | 普通用户 | 不喜欢的话能立刻关掉(点回聊) | 不被强制听完 |
| US-5 | 普通用户 | 同一时段多次点击不会得到一样的话 | 每次都是新的 |
| US-6 | 普通用户 | 网络不行 / TTS 失败时有降级 | 起码能看到文字 |

## 3 · 整体架构

```
[用户点麦克风按钮]
    │
    ▼
[Voice.tsx 进入全屏 + 显示"Echo 正在想…"]
    │
    ▼
[IPC: scenario.generate()]
    │
    ▼
[主进程 scenario.ts]
    │
    ├─ 1. 收集情境(时间、上次对话、品味摘要、活跃事件)
    ├─ 2. 调 LLM(用 prompts/scenario-100.md)→ 文本
    └─ 3. 把文本流式回传给渲染
    │
    ▼
[Voice.tsx 收到文本(可能流式)]
    │
    ├─ 文本完整后 → 调 TTS 合成
    │
    ▼
[TTS 引擎 · 输出音频流]
    │
    ▼
[渲染进程同时:
  ├─ 播放音频(<audio>)
  ├─ 文字按 timestamp 三段着色:已说/正在说/待说
  └─ 中央大音浪同步频谱
 ]
    │
    ▼
[结束 · 保持画面 · 等用户点"回 聊"返回絮语]
```

## 4 · 文案生成 · `scenario.ts`

详细 prompt 在 `prompts/scenario-100.md`,这里讲后端如何拼上下文。

### 4.1 输入

```typescript
interface ScenarioContext {
  // 当前情境
  datetime: string;          // ISO 8601
  weekday: string;
  timeOfDay: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'late_night';
  weather?: string;

  // 用户状态
  tasteProfileSummary: string;
  activeEvents: Array<{ content: string; weight: number }>;

  // 最近对话(只取最近 5 条)
  recentConversations: Array<{ role: string; content: string; createdAt: string }>;

  // 当前播放(如果有)
  currentlyPlaying?: { title: string; artist: string };

  // 历史去重 · 最近 7 天的 scenario 文案,避免重复
  recentScenarios: Array<{ content: string; generatedAt: string }>;

  daysSinceFirstUse: number;
}
```

### 4.2 输出

70-100 字纯文本(单段,不分段)。**LLM 不返回结构化数据**,scenario 不像风信那么大,简单。

### 4.3 多样性

每个 timeOfDay 在 7 天内生成的 scenario 文案放在 `recentScenarios` 里注入回 prompt,
告诉 LLM"这些近期说过,别重复"。

### 4.4 失败模式

| 场景 | 处理 |
|---|---|
| LLM 超时 | 降级到本地预设池(20 条左右无个性化的通用文案,如"嘿,这会儿挺安静的,陪我听几首?") |
| LLM 返回超长 | 后端裁剪到 100 字,在最近的句号 / 逗号截断 |
| LLM 返回 < 30 字 | 接受(过短也是一种风格)|

## 5 · TTS · 关键技术决策

### 5.1 候选方案对比

| 方案 | 成本 | 中文质量 | 集成难度 | 可控性 |
|---|---|---|---|---|
| **微软 Edge TTS**(免费) | 免费,无 token 限制 | ★★★★★(zh-CN 几个声音都自然) | ★★ 用 `edge-tts` npm 包 | 声音切换简单 |
| **ElevenLabs** | 收费(几美分一次) | ★★★★★ 但**中文支持新且贵** | ★★ REST API | 自定义声音(克隆) |
| **OpenAI TTS** | 收费 | ★★★★ 中文不错但有英语腔 | ★ 已有 SDK | 标准 |
| **Web Speech API** | 完全免费 · 浏览器原生 | ★★(机械感强) | ★ 一行代码 | 低 |
| **本地 TTS 引擎**(Coqui / Bark) | 免费 | 看模型,可极好 | ★★★★ 装巨型模型 + GPU 推理 | 高,但重 |

### 5.2 推荐方案

**v0.3 · 微软 Edge TTS** 起步。

理由:
- **完全免费 + 无限量**(技术上是逆向 Edge 浏览器的接口,稳定运行 5+ 年)
- **中文自然度顶尖**(`zh-CN-XiaoxiaoNeural`、`zh-CN-XiaoyiNeural` 等)
- 开源 npm 包成熟(`edge-tts`)
- 不消耗 LLM 配额,与 chat 解耦
- 风险:微软哪天关接口 → 立即降级到 Web Speech API 兜底

**v0.4+ 候选:**
- 让用户在设置里选 TTS 引擎
- 支持自定义角色(克隆用户朋友的声音?——这个伦理上要慎重)

### 5.3 选音色

Echo 应该有一个**默认角色音色**。我建议从 Edge TTS 提供的几个中文声音里挑:

| 候选 | 风格 | 是否合 Echo 人设 |
|---|---|---|
| `zh-CN-XiaoxiaoNeural` | 年轻女性,亲切 | ★★★ 有点偏甜 |
| `zh-CN-XiaoyiNeural` | 年轻女性,温和 | ★★★★ 接近 |
| `zh-CN-YunyangNeural` | 中年男性,新闻播音 | ★(不像朋友) |
| `zh-CN-YunxiNeural` | 年轻男性,轻松 | ★★★ |
| `zh-CN-XiaohanNeural` | 年轻女性,叙事感 | ★★★★★ **首选** |
| `zh-CN-XiaomoNeural` | 年轻女性,故事讲述 | ★★★★ |

**v0.3 默认 `zh-CN-XiaohanNeural`**,设置里允许换。

### 5.4 SSML 控制(可选优化)

Edge TTS 支持 SSML 标签控制语速 / 停顿 / 语调。Echo 可以稍微调慢:

```xml
<speak version="1.0" xml:lang="zh-CN">
  <voice name="zh-CN-XiaohanNeural">
    <prosody rate="-5%">14 点 22 分,你这个点该犯困了吧。</prosody>
  </voice>
</speak>
```

不强制,**v0.3 先 plain text 跑通**,文字够好的话原生语调就足够。

## 6 · 文字三段着色 · 关键体验细节

这是语音模式**最讨喜**的视觉:文字随 TTS 朗读进度逐字变色。

### 6.1 实现思路

Edge TTS 调用时,**同时返回音频流和 word boundary 时间戳**:

```typescript
const tts = await edgeTTS.synthesize(text, voice);
// tts.audio: Buffer
// tts.timing: Array<{ text: string; offsetMs: number; durationMs: number }>
```

渲染进程拿到 timing → 按音频播放 currentTime 找到对应位置 → CSS 把字符分三段:

```typescript
// 简化逻辑
const currentMs = audio.currentTime * 1000;
const splitIndex = timing.findIndex(t => t.offsetMs > currentMs);
// 0..splitIndex-1 = 已说
// splitIndex = 正在说
// splitIndex+1.. = 待说
```

### 6.2 视觉规格(对应 design/voice-mode.html 已实现)

- **已说**:正常深绿(`--ayin-900`)
- **正在说**:主色高亮 + 加粗 + 一个微闪烁的小光标
- **待说**:深绿 22% 透明度

切换时**不要**突然变色 → 加 200ms `transition`,丝滑过渡。

### 6.3 没有 timing 信息的降级

某些 TTS 引擎(Web Speech API)给不了精确字级 timing。降级:
- 总时长 / 字数 = 平均每字毫秒
- 按线性比例推算
- 不完美但能用

## 7 · UI 行为(对应 design/voice-mode.html)

### 7.1 进入

- 主界面输入框右边的麦克风按钮 → 点击
- **过场动画**:抹茶绿背景从屏幕底部向上展开(~300ms)
- **加载态**:文字区显示三段灰底骨架 + 顶部状态栏 `E C H O · T H I N K I N G`
- 文案到位 → TTS 加载 → 进入 `S P E A K I N G`

### 7.2 进行中

- 顶部状态:`E C H O · S P E A K I N G` + 音频时长 `00:06 / 00:18`
- 中部:文字 + 中央大音浪(随 TTS 输出频谱跳动)
- 底部右侧:`回 聊` 按钮

### 7.3 结束

- 音频结束 → 状态栏变 `D O N E`
- 文字停留全亮(全部"已说"颜色)
- 用户点"回 聊"回到絮语页(或者继续待在语音页等下一次)

### 7.4 中断

用户在 TTS 进行中点"回 聊":
- 立刻停 TTS
- 不保存这次 scenario(用户没听完 = 不算"说过",不进 recentScenarios 去重)
- 退回絮语

## 8 · 此 feature 与其他 feature 的耦合

| 联动 | 说明 |
|---|---|
| 与 `chat` | scenario 不计入 `conversations` 表(它不是"对话",是"播报")。但**最近 5 条对话**会作为 scenario 的输入 |
| 与 `recommendation` | scenario 文案里**可以**提到一首歌("我推 X 给你"),但**不直接触发播放**——只口播。用户回到絮语页可以追问"放刚才那首" |
| 与 `taste-profile` | 不读取 / 不修改 |
| 与 `yinyi` | scenario 不进风信素材(它不是用户行为) |
| 与 `playback` | 语音模式期间**主播放器静音 / 暂停**(避免重叠);语音结束后恢复 |

## 9 · v0.3 范围切分

### v0.3 · MVP
- [x] 全屏视图(已画 design/voice-mode.html)
- [ ] scenario.ts · LLM 文案生成
- [ ] Edge TTS 接入 · 默认 XiaohanNeural
- [ ] 文字三段着色(基于 word boundary)
- [ ] 中央大音浪(基于 TTS 输出 stream 的频谱)
- [ ] 回聊退出
- [ ] 失败降级(TTS 挂了至少能看文字)

### v0.4+
- [ ] 设置里选音色
- [ ] SSML 调语速 / 停顿 (针对场景)
- [ ] 多语言(英文 / 日文场景)
- [ ] **逆向**:用户对着 Echo 说话(STT 输入 · 复杂度高)

## 10 · IPC 接口

```typescript
// 渲染 → 主
voice.generate(): Promise<{ text: string; ttsUrl: string; timing: TimingInfo[] }>
voice.cancel(): Promise<void>

// 主 → 渲染
'voice:streaming-text' → { delta: string }   // 流式文本(若用)
```

## 11 · 测试场景

| 场景 | 预期 |
|---|---|
| 14:00 点麦克风 | 出现"下午好" / "下午这个点"类语境的文案 |
| 23:30 点麦克风 | 文案是"晚安风格" / "深夜风格" |
| 同一时段连点 3 次 | 3 段文案各不相同(去重生效) |
| TTS 失败但 LLM 成功 | 显示文字,顶部状态变 "T E X T &nbsp; O N L Y" |
| 中途点回聊 | 立刻停止 + 不计入历史 |
| 网络断开 | 友好提示 "我连不上自己的声音了,先回聊吧" |
| 在播放音乐时点麦克风 | 主播放器淡出暂停 → Echo 说话 → 说完恢复 |
| 用户最近一直没说话(对话历史空) | 文案不提对话,只提时间和品味 |

## 12 · 性能预算

- 点击麦克风 → 看到第一个字:**< 2 秒**(LLM ~ 1.5s + TTS 启动 ~ 0.3s)
- TTS 音频内存占用:< 5MB(单段语音 ~ 100KB)
- 中央音浪渲染:60fps · CPU < 3%
- 整页全屏过场动画:300ms 内丝滑
