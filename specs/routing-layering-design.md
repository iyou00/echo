# 推荐链路分层设计 · 翻译器的正确位置

状态：**决策已敲定**（2026-08-28），待确认后实施
作者：AI 助手（基于代码勘察，非文档推断）
定位：**修订** `specs/translate-architecture.md` 的 Phase 1 集成方式。翻译制本身的方向不变，
本稿解决的是"翻译器应该插在链路的哪一层、它的输出该覆盖谁"。

**要解决的问题（用户原话）**：用户提问无论是什么——要音乐的、闲聊的、其他需求的——
要么转成对应的搜索词，要么给出相应的回复；**哪怕不是音乐也要有回复**；**要考虑多国语言**。

> 本文所有结论均以代码行号为依据，可逐条复核。凡与 `translate-architecture.md` 冲突处，以本文为准
> （那份文档写于翻译器落地之前，未考虑链路里已有的确定性层）。

---

## 0. 一句话结论

Echo 原有的架构哲学是**确定性优先、LLM 兜底**（快速通道、先例匹配、本地库优先都是这个思路的产物）。
翻译器被插在了最前面，**破坏了这一分层**——它抢在三个确定性/学习层之前执行。

修复方向不是推翻翻译制，而是**把翻译器放回它该在的层**：

```
静态回复 → 语言闸门 →[中文] 快速通道(确定性) → 先例匹配(学到的) → 翻译器(LLM)
                    →[非中文] ─────────────────────────────→ 翻译器(LLM)
                                                                ↓ 失败
                                                          旧路由(LLM 兜底)
```

三条原则：
1. **确定性优先**——能用规则和已学到的经验解决的，不问 LLM
2. **中文路径归中文，非中文全交给 LLM**——中文正则层只服务中文（决策 3）
3. 翻译器的输出要**合并进**确定性层的结果，而不是**覆盖**它

外加一条硬要求：**任何输入都必须有出路**——要音乐的给搜索词，不要音乐的给回复，绝不失语。

---

## 1. 现状：真实调用顺序

以 `sendPipeline.ts` 与 `skills/intent/chat.ts` 为准。

```
handleStaticReply()                        sendPipeline.ts:550   ── 静态回复（取消/停止…）
companionResponseBrief                     sendPipeline.ts:552   ── 陪伴语气（确定性）
│
├─ translateUserInput()                    sendPipeline.ts:567   ★ 翻译器，一次 LLM
│     └─ 命中 searchQuery → 组装 ChatIntent，链路结束（跳过下面全部）
│
└─ routeChatIntentWithLlm()                sendPipeline.ts:596   ── 仅当上面没命中
      ├─ detectEmotionMusicRequest()       chat.ts:1245          ── 快速通道，确定性，0 LLM
      ├─ groundRouterEntities()            chat.ts:1251          ── 实体 grounding，异步
      ├─ matchLearnedPrecedent()           chat.ts:1256          ── 先例匹配，确定性，0 LLM
      └─ inferChatRouteWithLlm()           chat.ts:1276          ── 分类路由，一次 LLM
```

**关键事实**：下面三层的执行，都以"翻译器没命中 searchQuery"为前提。

---

## 2. 问题清单（按严重度）

### P0-1 · 翻译器抢跑，绕过三个确定性/学习层

翻译器一旦返回非空 searchQuery，下列机制**全部不执行**：

| 被绕过的层 | 位置 | 后果 |
|---|---|---|
| 情绪+音乐快速通道 | `chat.ts:1245` | **今早（fef57fe）修的"烦躁"类输入，从 0 次 LLM 退回 1 次 LLM，且从确定性退回看模型心情** |
| 确定性先例匹配 | `chat.ts:1256` | **梦境自进化（learned_cases）学过的纠正不再生效**，命中数不再累加，"同样的错不犯第二次"的机制被架空 |
| 实体 grounding | `chat.ts:1251` | 歌手/歌名的核验不再执行 |

严重性说明：先例匹配被绕过是本稿认为**最严重**的一条。它是 Echo 唯一会随时间变聪明的机制
（`.zcode/plans/plan-sess_158fbc4e.md`：夜间复盘提取纠正 → 次日生效）。翻译器抢在它前面，
等于让系统永远学不会——每次都重新问 LLM 同一个已经被纠正过的问题。

### P0-2 · kind 被强制覆盖，丢掉三个下游分支

翻译命中时，`sendPipeline.ts:578-587` 无条件覆盖 `kind`：

```ts
kind: artist||title ? (title ? 'direct_song' : 'artist_request') : 'mood_request'
```

被丢掉的：

| 分支 | 为什么严重 |
|---|---|
| `similar_to_track` | **翻译分支永远不会产出这个 kind**，于是"来点像这首的""这首好听，再来点类似的"落到 `mood_request` → `searchModeForChatIntent`（`recommendationCandidates.ts:44-50`）返回 `generic` 而非 `similar-to-track` → **基于当前曲目的相似推荐整条失效**，退化成普通关键词搜索 |
| `feedback_current_track` | 用户对**当前播放**的反馈被改成 `mood_request`：① `candidateStage.ts:107-111` 依赖它决定是否按反馈重选；② 同上，失去 `similar-to-track` 管线（`recommendationCandidates.ts:48`）；③ `sendPipeline.ts:758` 的"当前曲目反馈"路径不再触发 |
| `clarification_needed` | 同名歌多版本时本该追问；被改成 `direct_song` 后，`sendPipeline.ts:695` 的追问分支（要求 `kind === 'clarification_needed'`）不再触发，直接放一首可能是错的歌 |
| `weather` / `identity` / `out_of_scope` | 正常情况下翻译器不会把这些判成音乐。但**误判时会绕过**——`sendPipeline.ts:685-694` 的三个分支直接失效，"今天天气怎么样"可能被拿去搜歌 |

> 补充：`direct_song` 这条没丢。`recommendationCandidates.ts:64` 判 `directSongRequest` 时也看
> `chatIntent.seedTitle`，而翻译分支在抽到 title 时会置 `kind='direct_song'`，所以点歌链路仍然完好。

### P1-1 · intent 算了不用

`translateUserInput` 返回的自然语言 intent 在 `sendPipeline.ts` 完全被丢弃，只用 searchQuery。

### P1-2 · 非音乐输入打两次 LLM

翻译返回 `searchQuery: null` 时（"你好"），仍会再调一次 `routeChatIntentWithLlm`。

---

## 3. 一处自我修正（重要）

我在上一轮口头判断里说过："用户的原话在路由层被压缩掉了，回复层再也看不到'被领导骂了'。"

**这个说法是错的。** 复核结果：

- `responseStage.ts:126` → `streamChatReply({ userText: trimmed, ... })`
- `responseStream.ts:274` → `buildChatContext(options.userText, ...)`

**回复 LLM 拿到的就是用户原话**，加上候选歌曲、陪伴语气、画像、天气等。它看得到"被领导骂了"。
`responseStage.ts:57-60` 甚至有针对"被骂/心情不好"的正则兜底文案，进一步证明原话是可达的。

所以 intent 的价值**不是**补回丢失的信息，而是下面三件更具体的事：

1. **消歧后的理解**：多轮里"再来几首""换一首"这类指代，翻译器已结合 `musicSession` 解出来了
   （"用户想继续听陈默之的歌"）。让回复 LLM 拿原话 + 上下文去猜，不如直接告诉它。
2. **意图与推荐结果的一致性**：推荐出了安静的歌，回复却在聊别的——intent 能让两者对齐。
3. **非音乐路径下替代 kind 的作用**（见 P1-2 的解法）。

这个修正直接影响优先级：intent 接入（P1-1）不是"救命"级别，而是"体验一致性"级别。
**它不该排在 P0 前面。**

---

## 4. 影响面矩阵

### 4.1 受影响的 downstream 分支（改动必须回归）

**A. 决定走哪条管线 / 走不走（改 kind 会直接改变行为）**

| 消费点 | 位置 | 依赖 |
|---|---|---|
| 搜索管线选择 | `recommendationCandidates.ts:44-50` | `direct_song`/`clarification_needed`→`direct-song`；`similar_to_track`/`feedback+more_like_this`→`similar-to-track`；其余→`generic` |
| 是否抓候选 | `recommendationCandidates.ts:62-68` | kind + `seedTitle` + `wantsMusic` |
| 是否跑推荐 | `candidateStage.ts:104-113` | `wantsMusic` + kind 排除表 |
| 相似推荐参考 | `candidateStage.ts:212, 248, 297` | `mood_request` / `similar_to_track` |
| 当前曲目反馈 | `candidateStage.ts:33,199`；`sendPipeline.ts:758` | `feedback_current_track` |
| 多轮承接 | `sendPipeline.ts:658, 734` | `pending_reply` |

**B. 非音乐分支（改 kind 会让这些失效）**

| 消费点 | 位置 | 依赖 |
|---|---|---|
| 天气回复 | `sendPipeline.ts:685` | `kind === 'weather'` |
| 身份问题 | `sendPipeline.ts:693` | `kind === 'identity'` |
| 越界拒绝 | `sendPipeline.ts:694` | `kind === 'out_of_scope'` |
| 同名歌追问 | `sendPipeline.ts:695` | `kind === 'clarification_needed'` + `needsClarification` |

**C. 只读/次要（改了影响很小）**

| 消费点 | 位置 | 说明 |
|---|---|---|
| 会话记忆 | `responseStage.ts:169` | 仅持久化 `intentKind`，不分支 |
| 排斥信号去重 | `sendPipeline.ts:360` | `feedback_current_track` 时跳过一次重复记录 |
| 先例匹配自校验 | `learnedPrecedentMatcher.ts:46-49` | 校验学到的 case 是否自带足够实体 |

### 4.2 好消息：kind 的实际影响面远小于原设计文档的估计

`translate-architecture.md` §3.1 标记删除 `ChatIntentKind` 为**"高危——下游大量判断"**。
实测分层如下：

- `chat.ts` 路由器内部约 **52 处** `kind ===`，全是路由自己的归一化与校验逻辑（**不用动**）
- 散落到 `services/chat/` 下游的约 **20 处**，即上表 A/B/C 三组

结论：**弱化 kind 可行，但不能一次性删**。可行路径是——先在 Phase B 做到"kind 保真"
（确定性层的判断不被翻译结果覆盖），把下游这 20 处的正确性守住；
路由内部那 52 处属于 Phase 2 的清理范围，与本次改动解耦。

⚠️ 需要强调：这 20 处里，**上表 A 组是会改变实际行为的**（决定走哪条搜索管线），
比原设计文档估计的"只是些分类判断"要重。`similar_to_track` 与 `feedback_current_track`
两个 kind 尤其关键——它们各自对应一条独立的推荐管线，丢掉就是整条管线失效，不是降级。

### 4.3 测试影响

| 测试 | 情况 |
|---|---|
| `evalCases.test.ts` | 11 条评测用例（5 条 `real-failure`），跑的是**确定性路径**（`classifyFallbackChatIntent` + 上下文承接）。**当前不覆盖翻译器**（规约明确"勿混入网络依赖"）。任何改动确定性层的动作都会撞到它——这正好是我们想要的回归网 |
| `inputTranslator.test.ts` | 14 条，仅覆盖翻译器自身。不涉及链路顺序 |
| `routeChatIntentWithLlm` | **无任何测试直接覆盖**（无 mock）。好消息：调整调用顺序几乎不会弄坏测试；坏消息：也没有测试保护我们 |

⚠️ 最后一个是真空：链路顺序目前**零测试覆盖**。Phase A 应补上。

---

## 5. 最优解

### 5.1 新的分层（核心改动）

```
① handleStaticReply                    确定性   不变
② 语言闸门 containsCJK                  确定性   新增；非中文直接跳到 ④
③ 快速通道 + 先例匹配（仅中文）          确定性/学到的   从 chat.ts 内部提到 sendPipeline
④ 翻译器 translateUserInput             LLM      ②③ 都没命中时（含全部非中文）
⑤ 旧路由 routeChatIntentWithLlm         LLM      仅当 ④ 失败
```

**为什么要有语言闸门**：确定性层的正则全是中文的——
`detectEmotionMusicRequest` 匹配 `烦|躁|焦虑|…`（`chat.ts:1205-1206`），
`classifyFallbackChatIntent` 的 `MUSIC_ACTION_PATTERN` 匹配 `歌|音乐|推荐|来一首…`。
对英文、日文输入它们既匹配不上、也不该参与决策。
翻译器是 LLM，**天然多语言**——非中文交给它才是对的。

这道闸门让"多语言"和"确定性优先"不再打架：中文走中文的最佳路径，非中文走翻译器。
（代码里目前没有 CJK 检测工具，需在 `services/recommendation/language.ts` 新增。）

需要的新导出：`chat.ts` 的 `detectEmotionMusicRequest` 目前是私有函数（`:1203`），需 export。
`matchLearnedPrecedent` 已是导出函数，可直接用。

### 5.2 合并而非覆盖

翻译命中时，组装 ChatIntent 的规则改为：

| 字段 | 取值规则 |
|---|---|
| `kind` | **确定性层（`classifyFallbackChatIntent`）说了算**——若它给出 `feedback_current_track` / `similar_to_track` / `clarification_needed` / `weather` / `identity` / `out_of_scope`，**一律保留**（这六个各自对应独立管线或分支）；否则用翻译结果推导 |
| `wantsMusic` | 确定性层为 `false` 时尊重（防止误判把闲聊拿去搜歌） |
| `seedTitle` / `artistQuery` | 翻译器优先（`entities`），但**先过确定性层的同名歌追问判断** |
| `searchQuery` | 翻译器优先 |
| `intentDescription` | 翻译器的 `intent`，**新增字段，透传到回复层** |

### 5.3 非音乐路径：区分"说不是音乐"和"翻译失败"

这是 P1-2 的解法，也是两种被混为一谈的情况：

| 情况 | 当前 | 建议 |
|---|---|---|
| 翻译**失败**（抛错 / JSON 解析不出 / abort） | 回退旧路由 | **不变**，回退旧路由（该花的花） |
| 翻译**成功但** `searchQuery: null` | 回退旧路由（第 2 次 LLM） | **不再回退**。用 `classifyFallbackChatIntent` 拿 kind（确定性，0 LLM），挂上 `intentDescription` 直接进回复生成 |

可行性依据：`classifyFallbackChatIntent`（`chat.ts:1308-1482`）已能确定性产出
`identity` / `weather` / `out_of_scope` / `casual_chat` / `feedback_current_track` / `clarification_needed`，
覆盖了下游需要的绝大多数非音乐分支。**唯一缺口是 `pending_reply`**（只有 LLM 路由会产出）。

`pending_reply` 缺口评估：它要求 `routeSource === 'llm'`（`sendPipeline.ts:658`）。
但翻译器只在"没有 pendingIntentContext"时才跑（`sendPipeline.ts:566`），
而 `pending_reply` 主要服务于"上文有未决实体"的承接——两者重叠面很小。
**建议：先做，同时埋点记录 translator 判定非音乐后旧路由原本会给出什么 kind，跑一周看分布再定。**

### 5.4 intent 接入回复生成（P1-1）

- `ChatIntent` 增加 `intentDescription?: string`（`translate-architecture.md` §3.4 已预留此字段）
- 翻译分支赋值
- `responseStage` → `streamChatReply` 的 prompt 里，作为"系统对用户此刻的理解"注入

注意：这是**增强**不是**替换**——回复 LLM 仍然读用户原话，intent 只是多给一份消歧后的理解。

---

## 6. 决策记录（已敲定）

用户目标：**任何输入都要有出路**——要音乐的转成搜索词，不要音乐的也要有回应；且要考虑多语言。
以下按此目标逐条敲定，可推翻但需明确理由。

### 决策 1 · 快速通道只保留"用户已经明说想要什么"的映射

分歧点：快速通道（`chat.ts:1210`）把"心里堵得慌"译成 `安静 舒缓 轻音乐`，
翻译 prompt 的 few-shot 译作 `宣泄 节奏`。

**这不是二选一，是快速通道越界了。** 快速通道按**单个情绪词**匹配，看不到整句：

- "心里堵得慌，**想听点能把这口气散掉的音乐**" → 该宣泄
- "心里堵得慌，**想安静一会儿**" → 该安抚

同一个"堵"字，两种完全相反的需求。关键词匹配无法区分，**这件事本来就不该由快速通道决定**。

**决策**：把需要推测的映射从快速通道移除，交还给翻译器；只保留"用户已经把想要的说出来了"的部分。

| 情绪 | 处置 | 理由 |
|---|---|---|
| 烦/躁/焦虑/压力/堵/憋/闷/生气/火大/暴躁/不爽 | **移出快速通道 → 翻译器** | 安抚还是宣泄取决于整句，必须看上下文 |
| 难过/伤心/低落/想哭 | 保留 → `治愈 温暖 轻柔` | 用户已表达需要被照顾 |
| 累/疲/困/没精神 | 保留 → `提神 轻快 活力` | 目标明确 |
| 开心/高兴/兴奋 | 保留 → `轻快 活力` | 目标明确 |
| 放松/安静/舒缓 | 保留 → `安静 舒缓` | 用户已经明说了要什么 |
| 治愈/温暖 | 保留 → `治愈 温暖` | 同上 |

净效果：快速通道仍然覆盖"目标明确"的情绪（**今早的修复保住**），
而模棱两可的负面情绪回到翻译器——正是它该发挥作用的地方。

### 决策 2 · 非音乐路径不再二次调用 LLM，但必须出回复

翻译说"不是音乐"时，用 `classifyFallbackChatIntent` 拿 kind（确定性、0 LLM），
挂上 `intentDescription` 直接进回复生成。理由与可行性见 §5.3。

**附加约束（用户明确要求"哪怕不是音乐也要给出相应的回复"）**：
回复生成必须产出内容。现有兜底链是
`streamChatReply` → 失败 → `friendlyError` / `emptyModelReply`（`responseStage.ts:141-159`）。
`emptyModelReply` 在无歌时返回"我刚才走神了一下"——**这正是历史上"走神"的出处**。
因此额外要求：无候选歌曲时的兜底文案不得是"走神"，需改为能承接用户状态的表述
（承认没接住 + 接住用户的情绪 + 给下一步），并区分「没听懂」与「没找到歌」两种情况。

### 决策 3 · 多语言：中文走中文路径，非中文一律走翻译器

| 层面 | 决策 | 依据 |
|---|---|---|
| 路由 | 非中文跳过全部中文正则层，直接进翻译器（见 §5.1 语言闸门） | 正则只认中文，不匹配也不该匹配 |
| 搜索词 | **保持中文关键词**。音源是网易云，中文检索命中率更高 | `keywordFromIntent` 会把 `languageKeyword` 并入 |
| 艺人名/歌名 | **保留原始写法，不翻译**。`system.md:62` 已有"中英文不要互译"，需同步写进翻译 prompt | 避免"Taylor Swift"→"泰勒·斯威夫特"导致搜不到 |
| 语种偏好 | 用户明说要某语种歌曲时（"来首日语歌"），`detectMusicLanguage` 已能识别（`language.ts:91`），其 `searchTerms` 会并入搜索词；**翻译器不得覆盖此信号** | 现有机制可用，只需保证不被冲掉 |
| 回复语言 | `prompts/system.md` **新增一条**：用用户当前使用的语言回复 | 目前 system prompt 完全没提语言，靠模型自然对齐，不可靠 |

### 已知缺口（本轮不解决，记录在案）

`detectMusicLanguage` 识别的是**显式语种名**（"日语歌" / "Japanese songs"），
识别不出**用户说话所用的语言**（英文说 "I'm feeling down" 返回 undefined）。
决策 1/3 的分层已让这类输入落到翻译器，所以不阻塞；
若后续要按用户语言调整回复语气或搜索语种，再单独扩展。

---

## 7. 分阶段实施

| Phase | 内容 | 风险 | 独立性 |
|---|---|---|---|
| **A** | 分层归位：新增 CJK 语言闸门；快速通道 + 先例匹配提到翻译器之前（仅中文） | 低 | 可单独先发 |
| **A2** | 快速通道收窄：把「烦/躁/堵/憋/闷/生气」等需推测的映射移出，交还翻译器（决策 1） | 低 | 依赖 A |
| **B** | kind 保真：确定性层的六个分支不被翻译结果覆盖（§5.2） | 中 | 依赖 A |
| **C** | 非音乐不再二次调用 + 兜底文案改掉"走神"（决策 2）+ 埋点观测 | 中 | 依赖 A |
| **D** | 多语言：CJK 闸门（A 已含）+ 翻译 prompt 加"艺人名保留原文" + `system.md` 加"用用户的语言回复"（决策 3） | 低（纯 prompt + 一处闸门） | D 的 prompt 部分独立 |
| **E** | intent 接入回复生成（§5.4） | 低（纯增强） | 独立，可随时做 |

**建议顺序：A → A2 → B → D → C → E**
（C 需要埋点数据，放后面；E 是增强，随时可插队）

### 回滚策略

- 总开关：`chat.translateRouter`（已实现，见 `types/ipc.ts`、`db/settings.ts`）
- A/A2/B 会改变"翻译命中时"的行为，建议各一个独立提交，便于二分
- A2 是纯删减（快速通道少匹配几类），即使判断错了也只是"多走一次 LLM"，不会答错
- C 建议同一 flag 下再加一层：只有埋点显示 `pending_reply` 占比极低时才默认开启
- D 的 prompt 改动若效果不佳，直接回滚文件即可（记得 `prompts/store.ts` 已登记内嵌）

### 验证方式

1. `evalCases.test.ts`（11 例）必须通过——它是确定性层的回归网
2. `inputTranslator.test.ts`（14 例）必须通过
3. **新增**：链路顺序测试——快速通道/先例匹配命中时，翻译器**不应被调用**（当前零覆盖）
4. **新增**：六个"不可覆盖 kind"的回归用例——
   `clarification_needed` / `feedback_current_track` / `similar_to_track` /
   `weather` / `identity` / `out_of_scope`，各断言翻译命中时 kind 不被改写
5. **新增**：`searchModeForChatIntent` 用例——"来点像这首的"必须得到 `similar-to-track`（当前会退化成 `generic`）
6. 真机手测清单（每项一句话 + 期望）：
   - 烦躁/心里堵/放松/安静/陈默之/来一首/今天天气/你好（原设计文档的 8 例）
   - "心里堵得慌，想听点能把这口气散掉的音乐"（→ 宣泄向，不应是纯安抚）
   - "心里堵得慌，想安静一会儿"（→ 安抚向，与上一句必须给出不同结果）
   - "这首不好听，换一首"（当前播放反馈 → 应按反馈重选）
   - "这首好听，再来点类似的"（→ 必须走 similar-to-track）
   - "播放《主角》"多版本（→ 必须追问）
   - "再来几首"（无 pendingIntent 的多轮承接）
7. **多语言手测**（决策 3）：
   - `I'm feeling down, play me something` → 出歌，且**回复用英文**
   - `I'm so stressed, give me a song` → 出歌（不得落入中文正则层被判闲聊）
   - `落ち込んでる、元気出る曲` → 出歌，回复用日文
   - `Taylor Swift 的歌` → 艺人名保留原文，不得译成"泰勒·斯威夫特"
   - `来首日语歌` → 搜索词必须带上语种关键词（现有 `detectMusicLanguage` 机制）
   - `今天天气怎么样` / `你好` → **必须出回复**，且不得出现"走神"文案
8. 埋点：`translator_null_kind_distribution`——翻译判非音乐后，旧路由原本会分到什么 kind

---

## 8. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | 快速通道收窄后（决策 1），负面情绪类多花一次 LLM | 高（必然） | 延迟略增 | 可接受：换来的是"堵得慌"能分出宣泄/安抚；且这是翻译器本来就该干的活 |
| 2 | 先例匹配上提后误伤（学到的 case 本身是错的） | 低 | 错误纠正被固化 | 已有 `learned_cases` 的佐证与衰减机制 |
| 3 | `pending_reply` 在 Phase C 后丢失 | 中 | 多轮承接退化 | 埋点观测后再切默认；必要时保留"疑似承接"时回退旧路由 |
| 4 | kind 保真后翻译结果与确定性层打架 | 低 | 边缘输入行为不一致 | 明确优先级表（§5.2），写进 `evalCases` |
| 5 | ~~快速通道与翻译 prompt 结论不一致~~ | — | — | **已通过决策 1 解决**：需推测的映射移出快速通道 |
| 6 | CJK 闸门误判（中日文混排、纯英文歌名） | 低 | 该走快速通道的走了翻译器 | 只影响是否多花一次 LLM，不影响正确性；取"含中日韩字符即视为中文路径"的宽松判据 |
| 7 | 翻译器对小语种理解差 | 中 | 非中文（尤其日/韩/泰语）翻译质量不稳 | Phase D 的真机清单要覆盖日/英；若某语种明显差，再考虑为该语种加显式提示 |
| 8 | 用户明确要某语种歌曲时，翻译器给的 searchQuery 冲掉语种信号 | 中 | 要日语歌结果搜出中文歌 | `keywordFromIntent` 已并入 `languageKeyword`；需补测试锁定该行为 |

---

## 9. 附：待处理的文档债

`PRD.md` 的进度清单仍停留在 v0.1 mockup 阶段，与代码（v0.2.0，已有风信/梦境自进化/品味指纹）
严重脱节，本次已被误当作事实依据。建议：

- `PRD.md` 顶部加一行：进度部分已过期，链路以 `specs/` 下的链路文档 + 代码为准
- 本文件 + `specs/translate-architecture.md` 作为推荐链路的现行文档
