# 「LLM 翻译制」架构改造 · 技术开发文档

状态：设计稿（2026-08-28，待用户批准后实施）

---

## 1. 问题陈述

现有推荐链路建立在「先分类再执行」上：LLM 把用户输入塞进固定枚举
（mood_request / artist_request / casual_chat...），分类失败 = 整条链路报废。
无论怎么加规则、怎么优化 prompt，都无法覆盖人类表达的无限性。

「心里堵得慌」不是特例——是分类制架构的必然缺陷。

## 2. 目标架构：翻译制

```
用户说任何话
    ↓
LLM（一次调用）输出三个字段：
  searchQuery: "安静 舒缓"           ← 搜索词（null = 非音乐）
  intent: "用户心情烦躁想听安静的歌"   ← 自然语言意图
  entities: { artist, title }       ← 如有具体歌手/歌名
    ↓
searchQuery 存在？
  是 → 推荐 → 格式化回复
  否 → 用 intent 生成对话回复
```

**核心原则**：LLM 只做翻译（语言 → 搜索词），系统只做执行（搜索 → 推荐 → 回复）。
不再有分类枚举、不再有 kind 判断、不再有规则映射表。

## 3. 改动范围与影响分析

### 3.1 要删除的

| 组件 | 现位置 | 删除理由 | 影响评估 |
|---|---|---|---|
| ChatIntentKind 枚举 | chat.ts L40-60 | 翻译制不需要 kind | **高危**——下游大量 `isMusicExecutionKind(kind)` 判断 |
| keywordFromIntent 三层规则 | recall.ts L230-290 | searchQuery 直接消费 | **低**——只有一个消费者 |
| moodSearchKeywords 硬编码 | recall.ts L290-330 | LLM 翻译替代 | **低**——纯兜底，可留作降级 |
| 路由 prompt 的 31 条规则 | chat.ts L895-950 | 换为翻译 prompt | **中**——prompt 重写 |
| classifyFallbackChatIntent | chat.ts L1266+ | 快速通道 + LLM 兜底替代 | **中**——rule-based fallback 路径 |
| applyInferredChatRoute | chat.ts L1084+ | 不再有 route 概念 | **高**——pendingIntent 依赖此路径 |
| InferredChatRoute 接口 | chat.ts L85+ | 同上 | **中** |

### 3.2 要新增的

| 组件 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| `translateUserInput()` | 新文件 `services/chat/translator.ts` | 单一 LLM 调用，输出 searchQuery + intent + entities | llm/client |
| `executeSearchQuery()` | `services/chat/executor.ts` | 拿 searchQuery 调推荐引擎 | recommendation/recall |
| `generateConversationalReply()` | `services/chat/converser.ts` | 拿 intent 生成非音乐回复 | plannedReply.ts 重构 |
| 翻译 prompt | `prompts/input-translator.md` | 指导 LLM 如何翻译 | — |

### 3.3 要保留的（不动）

| 组件 | 位置 | 保留理由 |
|---|---|---|
| 情绪+音乐快速通道 | chat.ts `detectEmotionMusicRequest` | LLM 失败时的确定性兜底 |
| 确定性先例匹配 | learnedPrecedentMatcher.ts | 学到的纠正不依赖 LLM |
| pendingIntent 多轮澄清 | pendingIntents.ts | 澄清流程与分类无关 |
| 本地库优先 | recall.ts `localLibraryArtistTracks` | 网络失败时的本地搜索 |
| companionResponse | companionResponse.ts | 人格层不动 |
| agent-soul.md | prompts/ | 人格定义不动 |
| 推荐引擎（fetchCandidates） | recommendation/ | 执行层不动，只换输入源 |
| 评分系统（scoring） | recommendation/ | 与路由无关 |
| musicSession 跟踪 | sessionContext.ts | 多轮音乐话题跟踪保留 |

### 3.4 要修改的（保留但重构）

| 组件 | 改什么 | 兼容策略 |
|---|---|---|
| sendPipeline.ts | 用 translateUserInput 替代 routeChatIntentWithLlm | 保留旧路由作为 feature flag 降级路径 |
| candidateStage.ts | 接收 searchQuery 替代 RecommendationIntent | 适配层转换 |
| responseStage.ts | 接收 intent 字符串替代结构化 intent | 自然语言描述替代枚举 |
| ChatIntent 接口 | 加 searchQuery + intentDescription 字段 | 向下兼容（kind 保留但可选） |

## 4. 上下文联动（与翻译制同步建设）

### 4.1 短期（Phase 1 一起做）

| 改动 | 实现 | 影响文件 |
|---|---|---|
| recentDialog 扩容 | 4 条/100 字 → 8 条/200 字 | sendPipeline.ts L490-495, chat.ts L580 |
| searchQuery 生成带上下文 | 翻译 prompt 中包含 recentDialog | prompts/input-translator.md |
| musicSession 扩展 | 从单一歌手扩展到最近音乐话题 | sessionContext.ts |

### 4.2 中期（Phase 2）

| 改动 | 实现 | 依赖 |
|---|---|---|
| 对话摘要激活 | 每天结束时总结当天对话 → conversation_summaries | 已有表结构，需填数据 |
| 启动时注入摘要 | 下次启动把摘要注入翻译 prompt 的 context | conversation_summaries → translator prompt |
| 情绪连续性 | 最近 2-3 轮情绪标签串联，翻译时知道是延续 | 需要情绪标记存储 |

## 5. 实施分批

### Phase 1：翻译制核心（最小可行）

**改什么**：新写 `translateUserInput()` + 翻译 prompt + 替换 sendPipeline 的路由调用。

**不改什么**：推荐引擎、评分、人格、快速通道、先例匹配全部不动。

**兼容策略**：feature flag `translateRouter.enabled`，关闭时回退到旧路由。
上线前在 flag 后面 A/B 对比两种路由的推荐成功率。

**验证方式**：
- 同一组测试输入（烦躁/心里堵/放松/安静/陈默之/来一首/今天天气）双路由对比
- E2E 全矩阵（walk-all + walk-listening）
- 手动真机验证所有情绪表达

**预估改动量**：3 个新文件 + 2 个修改文件 ≈ 500 行新增 + 100 行修改。

### Phase 2：删除旧路由 + 上下文扩容

**前提**：Phase 1 稳定运行 1 周，推荐成功率 ≥ 旧路由。

**改什么**：删除 classifyFallbackChatIntent + applyInferredChatRoute + 路由 prompt。
扩展 recentDialog。激活 conversation_summaries。

**预估改动量**：删除 ~800 行 + 修改 ~200 行。

### Phase 3：完善对话层

**改什么**：情绪连续性跟踪 + 启动摘要注入 + 对话生成优化。

## 6. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | LLM 翻译质量不稳定 | 中 | searchQuery 质量下降 | 快速通道兜底 + 情绪模式 fallback |
| 2 | 非音乐输入被误翻译为音乐 | 低 | 用户说「你好」结果推歌 | prompt 明确「不确定就不填 searchQuery」|
| 3 | 艺人/歌名提取回归 | 低 | 「陈默之」搜不到 | 本地库优先已修 + entities 提取保留 |
| 4 | pendingIntent 多轮澄清断裂 | 中 | 澄清后无法继续 | Phase 1 保留旧路由的 pendingIntent 路径 |
| 5 | 回复生成质量下降 | 低 | responseStage 失去结构化 intent | intent 字符串信息量可能 > 枚举 |
| 6 | LLM 延迟增加 | 低 | 一次调用 vs 现有路由一次 | 调用次数不变，只是 prompt 更简单 |
| 7 | 非音乐对话退化 | 中 | casual_chat 路径失去结构化分类 | Phase 1 保留旧路径处理非音乐 |
| 8 | E2E 大量断言依赖 kind | 高 | E2E 需要重写 | Phase 1 保留 kind 字段（由翻译结果推导）|

## 7. 翻译 Prompt 设计（核心）

```
你是 Echo 的输入翻译器。用户说任何话，你翻译成系统可执行的操作。

输出 JSON，只有三个字段：

searchQuery: 2-4 个适合在音乐平台搜索的中文关键词，空格分隔。
             如果用户不是在要音乐，填 null。
             把情绪/场景翻译成搜索词，不照抄原话。
             「烦躁想静静」→ "安静 舒缓"
             「被骂了来首歌」→ "治愈 轻快"
             「陈默之的新歌」→ "陈默之"

intent: 一句话描述用户想要什么（自然语言，不用枚举值）。
        "用户心情烦躁，想听安静的歌" / "用户想听特定歌手的最新歌曲" / null

entities: { "artist": "陈默之", "title": null }
          如果用户提到具体歌手或歌名就填，否则 null。

规则：
- searchQuery 是给搜索引擎看的，用名词和形容词，不用句子
- 不确定用户是否要音乐时，searchQuery 填 null（宁可不推不乱推）
- 上下文里已有 musicSession 的 artistQuery 时，如果用户在承接话题，searchQuery 要带上该歌手
- intent 是给回复生成看的，要具体（不是"music_request"而是"用户想听周杰伦的歌"）

recentDialog 里有最近的对话历史，参考它来判断用户是在开启新话题还是承接上文。
```

## 8. 与现有系统的边界

| 边界 | 翻译制侧 | 现有系统侧 | 数据流 |
|---|---|---|---|
| 推荐引擎 | 只传 searchQuery + entities | fetchCandidates 内部逻辑不变 | searchQuery → keywordFromIntent → netease |
| 评分系统 | 不接触 | scoring.ts 用 track semantic 评分 | 不变 |
| 人格层 | 不接触 | agent-soul + companionResponse | 不变 |
| 回声/风信 | 不接触 | 独立管道 | 不变 |
| 品味页 | 不接触 | 画像系统 | 不变 |
| learned_cases | 保留 | 确定性先例匹配继续工作 | 先例命中时跳过翻译 |

## 9. 成功指标

| 指标 | 旧路由基线 | 目标 | 度量方式 |
|---|---|---|---|
| 情绪音乐请求成功率 | ~60%（烦躁✅ 心里堵❌） | ≥90% | 手动测试 10 种情绪表达 |
| 非音乐请求误推率 | ~5% | ≤3% | 「你好」「今天天气」等不应出歌 |
| 平均响应延迟 | ~12s | ≤12s | 翻译 + 搜索时间 |
| 「走神」出现率 | ~10% | ≤1% | 走神 = 0 结果 + 0 回复 |
