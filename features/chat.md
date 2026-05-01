# Feature · 絮语(Chat)

> **核心地位**:Echo 的"聊天"是整个产品的中枢神经——它把**人格、记忆、推荐、播放**四件事串起来。其他 feature(风信、品味档案、语音模式)都是它的延伸。
>
> **对应 UI**:`design/main-view.html`
> **对应代码模块**:`src/main/services/chat.ts`、`src/main/llm/*`、`src/main/db/conversations.ts`、`src/renderer/pages/Chat.tsx`

---

## 1 · 这个功能要做什么

让用户和 Echo 用文字聊天,Echo 的回复:
- 体现 Echo 人格(`prompts/system.md`)
- 基于用户的品味档案、最近事件、对话历史给出回应
- 在合适时机推荐歌曲(以**带 Echo 小注的卡片**形式嵌在消息里)
- 流式输出(逐字显示),不是一次性蹦出来

## 2 · 用户故事

| # | 我作为用户 | 想要 | 这样我就能 |
|---|---|---|---|
| US-1 | 普通用户 | 在主界面输入框打字给 Echo 发消息 | 和它聊天 |
| US-2 | 普通用户 | 看到 Echo 一字一字回我(不是一下子蹦) | 感觉像真人在打字 |
| US-3 | 普通用户 | Echo 在合适的时候自动嵌一首歌的卡片 | 不用切到推荐页面 |
| US-4 | 普通用户 | 在 Echo 回复中点歌曲卡片 | 直接播放 |
| US-5 | 普通用户 | 重新打开 app 时能看到之前的对话历史 | 不会断片 |
| US-6 | 普通用户 | 网络断了或 LLM 出错时能看到友好的错误提示 | 不会被技术错误吓到 |
| US-7 | 普通用户 | 等待 Echo 回复时能取消(比如打字时改主意了) | 不被卡住 |

## 3 · 输入(Inputs)

### 3.1 用户主动输入

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 用户文字消息(必填,1-2000 字符) |
| `timestamp` | ISO 8601 | 客户端时间 |

### 3.2 系统自动注入(由 chat.ts 拼装)

每次调 LLM 时,主进程会从数据库捞这些拼到 prompt 里:

```typescript
interface ChatContext {
  // 来自 prompts/system.md
  systemPrompt: string;

  // L1 · 长期品味摘要(从 taste_profile.summary 字段)
  tasteProfileSummary: string;     // 200 字以内人话

  // L2 · 中期事件(weight > 0.3 且未过期的)
  activeEvents: Array<{
    content: string;
    weight: number;
    started_at: string;
  }>;

  // L3 · 最近对话(最多 15 轮 = 30 条消息)
  recentMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>;

  // L3 · 对话压缩摘要(更早的对话被压缩成的)
  conversationSummary?: string;

  // 当前情境
  currentContext: {
    datetime: string;       // ISO 8601
    weekday: string;        // "周五"
    timeOfDay: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'late_night';
    weather?: string;       // 可选,后期对接天气 API
    daysSinceFirstUse: number;  // 用户已用了多少天
  };
}
```

## 4 · 输出(Outputs)

LLM 调用使用**流式输出 + 工具调用混合模式**。

### 4.1 流式文本

普通对话内容,流式逐字传到渲染进程显示。

### 4.2 推荐歌曲(通过 tool use 触发)

Echo 推歌走**双工具流程**(详见 `features/recommendation.md`):

1. **`find_tracks`** —— LLM 描述想要的"气质"(vibe / mood / genre / artist),
   recommender.ts 在候选池中检索,返回 3-5 首带 `ref` 的候选
2. **`play_tracks`** —— LLM 从候选中挑 1-3 首,加小注,真正"推出去"

**为什么两步**:防 LLM 直接幻觉歌名。LLM 只描述气质,不直接产生歌名;真实歌曲数据完全由 recommender 控制。

主进程接到 `play_tracks` 后:
1. 把 `ref` 解析回真实 trackId
2. 通过 `netease/music.ts:searchTrack()` 拿到播放链接(v0.2 起)
3. 把 track card 数据通过 IPC 推给渲染进程,在对应消息位置渲染

### 4.3 自然学习(隐式工具 `update_taste`)

当用户在对话里**自然地**告诉 Echo 一些品味变化,Echo 应在对话同时调用一个隐式工具,
把这些变化写入品味档案,**不打扰对话流**。

```typescript
{
  name: 'update_taste',
  description: `当用户在对话中自然地表达品味变化时,后台静默调用这个工具记录。
**不要因此中断对话**——你照常回应用户,但同时调用这个工具留下记录。
典型场景:
- "我最近不太喜欢 X 了" → 把 X 从喜欢列表移到 anti_pattern
- "我新发现了 Y,挺喜欢" → 把 Y 加入 emerging_artists / emerging_genres
- "考研结束了" / "工作搞定了" → 标记对应 event 为已结束
- "这种感觉的歌再多来点" → 强化上一次推荐的 vibe 标签`,
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['like_artist', 'unlike_artist', 'like_genre', 'unlike_genre',
               'event_started', 'event_ended', 'reinforce_vibe', 'correct_assumption']
      },
      target: { type: 'string', description: '艺人名 / 流派名 / event 描述 / vibe 描述' },
      strength: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      note: { type: 'string', description: '可选,用户原话片段,留作日后回看' }
    },
    required: ['kind', 'target']
  }
}
```

主进程接到 `update_taste` 后:
- `like/unlike_artist` → 更新 `taste_profile.artists[].affinity`
- `like/unlike_genre` → 更新 `taste_profile.genres[].weight`
- `event_started/ended` → 写 `events` 表
- `reinforce_vibe` → 写 `taste_profile.signals`
- `correct_assumption` → 同时记录到 `events` 让后续对话知道用户做过纠正

**关键约束**:
- LLM 调这个工具时**不告诉用户**——这是 Echo 的"内化"动作,像朋友默默记住你说的话,不是客服式的"已为您记录"
- UI 上**不显示**工具调用过程(对用户透明)
- 但用户进 Echo 主页时能看到品味档案确实变了

### 4.4 输出消息结构(存数据库)

```typescript
interface AssistantMessage {
  id: number;
  role: 'assistant';
  content: string;        // 纯文本回复
  meta: {
    recommended_tracks?: Array<{
      title: string;
      artist: string;
      note?: string;
      netease_id?: string;
      play_url?: string;
      search_status: 'found' | 'not_found' | 'multiple_matches';
    }>;
    llm_meta: {
      model: string;          // 实际调用的模型名,例:"deepseek-chat" / "claude-opus-4-7" / 任何用户在设置里配的
      input_tokens: number;
      output_tokens: number;
      duration_ms: number;
    };
  };
  created_at: string;
}
```

## 5 · 状态机(消息发送的全过程)

```
[用户输入] 
     │
     ▼
[idle] ──user-send──► [user_message_saving] ──ok──► [llm_streaming]
                                                          │
                            ┌─────────────────────────────┤
                            │                             │
                       (text chunk)              (tool_use: find_tracks / play_tracks)
                            │                             │
                            ▼                             ▼
                  [render text incrementally]   [search_tracks_in_netease]
                            │                             │
                            └──────────────┬──────────────┘
                                           ▼
                                  [llm_continue/finish]
                                           │
                                           ▼
                                [assistant_message_saving]
                                           │
                                           ▼
                                        [idle]
```

### 关键说明

- **流式**:渲染进程要实现"打字机效果",不是等全部回完才渲染
- **工具调用**:LLM 中途可以调 `find_tracks` 检索 + `play_tracks` 真推,主进程并行处理,卡片**插入**到那条消息的合适位置(详见 `features/recommendation.md`)
- **取消**:用户可以在 `[llm_streaming]` 阶段按 Esc 或点取消 → 主进程 abort 当前 fetch + 保存"被取消"标记到数据库

## 6 · 失败模式与降级

| 失败场景 | Echo 的反应 | 技术处理 |
|---|---|---|
| **LLM API 超时 / 网络错误** | "我这会儿好像走神了,你刚说的我没接住,再说一遍?" | 自动重试 1 次,失败后保存错误消息;不计入对话历史 |
| **LLM 返回空内容** | "(没说话——我先想想,你接着说)" | 当成"Echo 沉默",不强行编内容 |
| **API Key 无效** | "我连不上自己脑子。去设置里看看 API key?" | 弹设置页,引导用户配置 |
| **token 超额** | "我们今天聊得太多了,我有点累。明天再继续好吗?" | 软限制,提示用户调整或等待 |
| **工具调用 - 搜歌失败** | 卡片显示:"我推这首,但播不出来" + 一行 Echo 的话 | 不影响对话本身,只是卡片状态变 `not_found` |
| **工具调用 - 搜歌结果有歧义** | 默认取第一个结果,卡片下方加"不是这首?换一个" | 用户可以纠正,纠正动作回写 LLM 让它学会 |
| **数据库写入失败** | 用户看到消息正常显示,但下次启动可能丢 | 后台日志记错,提示用户重启;不打断当前会话 |
| **用户输入超长(>2000 字)** | "这么长我得分两口气听,你要不分两次发?" | 客户端拦截,不发 LLM |
| **用户连发太快(<1s 内 3 条)** | 不响应,等用户停下 | 客户端去抖 |

## 7 · 关键算法

### 7.1 上下文窗口管理

现代 LLM 上下文虽然大,但每次都塞最大上限**贵且慢**。策略:

```
最近 15 轮原文(role + content)
+ 之前的对话压缩成的 conversationSummary(<= 1500 字)
+ TasteProfile.summary (<= 300 字)
+ active_events(每条 <= 100 字,通常 < 5 条)
+ system prompt(固定,~1500 字)
+ current_context(<= 200 字)
─────
≈ 总输入 4000-8000 tokens 之内,绝大多数情况 5000 以内
```

### 7.2 何时压缩对话

定时任务每天凌晨 3 点跑:
- 找 `conversations` 表中超过 30 天的连续对话
- 用 LLM 压缩成一段摘要,写入 `conversation_summaries` 表
- 原对话**不删**(只是不再注入到 prompt),用户翻历史时仍能看到

### 7.3 推荐歌曲的去重

防止 Echo 反复推同一首歌(尤其是用户刚拒绝过):
- 主进程在最终拼 prompt 时,**附加一段隐式提示**:"以下歌曲最近 7 天你已经推过了,除非用户明确要求,不要再推:[歌名列表]"
- 这段不放进 system prompt(避免污染人格),而是作为 user 消息的前缀注入

## 8 · UI 行为细节

### 8.1 输入框

- 默认占位符:`和 Echo 说点什么...`
- Enter 发送 / Shift+Enter 换行
- 发送后输入框立刻清空,**不等 LLM 回复**(否则用户会以为卡了)
- 用户消息**立刻**渲染到对话区,标记为"已发送";不等数据库写入完成

### 8.2 Echo "正在打字" 指示

- LLM 流式开始前的等待期(最多 1-3 秒),底部状态栏显示一个微动效:`Echo 正在想…`
- 文字开始流出后,正在打字的气泡**底部**有一个 1px 高的呼吸光带(主色 `--ayin-600`),表示还没完
- 流式结束后光带消失,完成态

### 8.3 歌曲卡片插入位置

LLM 的输出**可能交错**:
```
"14:22 了你这个点该困了吧——"
[tool_use: find_tracks(...)] → 候选返回
[tool_use: play_tracks(...)]  → 卡片渲染
"海洋Bo 这首是 2023 年那波治愈说唱里写得最稳的一首。"
```

渲染策略:
- 文本部分按流顺序追加
- 工具调用产出的卡片**作为独立块**插入到当前文本流的位置
- 卡片有自己的"加载态":搜歌时显示骨架屏,搜到后填入

### 8.4 滚动行为

- 默认:新消息出现时**自动滚到底**
- 但若用户已往上滚了(查历史),不强制滚——只在底部弹一个"↓ 1 条新消息"按钮

## 9 · IPC 接口(主进程 ↔ 渲染进程)

```typescript
// 渲染 → 主
chat.send({ text: string }): Promise<{ messageId: number }>
chat.cancel(messageId: number): Promise<void>
chat.loadHistory({ before?: string, limit?: number }): Promise<Message[]>

// 主 → 渲染(事件流)
'chat:stream:start'  → { messageId, role: 'assistant' }
'chat:stream:chunk'  → { messageId, delta: string }
'chat:stream:tool'   → { messageId, tool: 'find_tracks' | 'play_tracks', state: 'searching' | 'ready', tracks: [...] }
'chat:stream:end'    → { messageId, finalMessage: AssistantMessage }
'chat:stream:error'  → { messageId, error: { kind: string, friendlyText: string } }
```

## 10 · v0.1 范围切分

### v0.1 必须:

- [x] 文字对话 + 流式输出
- [x] 对话历史持久化 + 重启恢复
- [x] 上下文注入(TasteProfile.summary + activeEvents + recentMessages)
- [x] **歌曲推荐(tool use)但不实际播放** —— 卡片显示歌名/艺人/小注,点击无效或显示"v0.2 才能放"
- [x] 失败模式 1-9 的友好提示
- [x] 取消机制

### v0.1 不做:

- [ ] 真正的播放(v0.2 接 netease 后)
- [ ] 对话压缩定时任务(v0.1 数据量小不需要,v0.2 加)
- [ ] 推荐去重(v0.2 加)
- [ ] 主动消息(早晨问好等,v0.3)

## 11 · 测试场景(给开发自测用)

| 场景 | 预期 |
|---|---|
| 第一次启动,空数据库,发"hi" | Echo 简短回应,不推歌(没素材) |
| 导入歌单后发"推几首慢的" | LLM 调 `find_tracks` → recommender 返回候选 → LLM 调 `play_tracks` 选 3 首,带小注 |
| 发"最近只想听抖音热歌" | Echo 委婉劝阻,不直接给推荐 |
| 发"你不要再说话了" | Echo 让步,简短 ack,不再推歌 |
| 连续聊 50 轮后重启 app | 历史完整恢复,prompt 输入仍在 8K tokens 内 |
| 拔网线后发消息 | 友好错误提示,不崩 |
| 发 3000 字长文本 | 客户端拦截,提示分两次 |
| Echo 流式中途按 Esc | 立即停止,已显示部分保留为半截消息 |

## 12 · 可观测性 / 日志

每次 LLM 调用打 log(只在主进程,不传渲染):
```
[chat] req msg_id=87 input_tokens=4231 prompt_hash=ab12...
[chat] tool_use find_tracks → 5 candidates
[chat] tool_use play_tracks → 3 tracks rendered
[chat] netease search "向云端" 海洋Bo → found id=2096317893
[chat] resp msg_id=87 output_tokens=312 duration=2840ms
```

**绝不记录**用户消息原文到日志文件——隐私优先。日志只用于调试性能/失败模式,不留对话内容。
