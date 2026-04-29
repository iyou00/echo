# Feature · 品味档案(Taste Profile)

> **核心理念**:Echo 对 Ta 的理解,由 Echo 自己慢慢"观察"出来,不靠问卷。
> 档案是 Echo 主页的数据源,也是每次对话 / 推荐 / 音忆的**基础输入**。
>
> **对应 UI**:`design/profile.html`(展示)、`design/settings.html`(编辑入口)
> **对应代码模块**:`src/main/services/taste.ts`、`src/main/db/taste.ts`、`src/renderer/pages/EchoProfile.tsx`
> **依赖**:`samples/artist-genre-seed.json`(种子)、`chat.md:update_taste` 工具(自然学习入口)

---

## 1 · 这个功能要做什么

持续维护一份**关于用户的结构化理解**(`TasteProfile`),它:

1. **冷启动**:用户首次导入歌单后,Echo 先**读**歌单+ 听歌记录,
   然后**对话式确认**"我看到的你是不是这样"
2. **被动演化**:用户每次听歌、切歌、循环、接受/拒绝 Echo 推荐,都会给档案打分
3. **主动纠正**:用户在对话里说"我不喜欢 X 了",Echo 通过 `update_taste` 工具写回档案
4. **周期性重写**:每周日凌晨,Echo 用 LLM 重新写一遍"**Echo 的画像**"——主页最上面那段话

## 2 · 数据结构

完整结构在 `specs/data-model.md` 的 `TasteProfile` interface,这里只讲**字段的演化逻辑**:

| 字段 | 冷启动初值 | 演化来源 |
|---|---|---|
| `genres[]` | 歌单 + 听歌记录统计 + 艺人→genre 种子映射 | 听歌频次 + 切歌率 + `update_taste` |
| `artists[]` | 歌单中出现的全部艺人,按听歌次数降序 | 听歌频次 + loop count + 切歌率 |
| `moods[]` | 空,等待行为数据 | 听歌时段 + 用户对话里的情绪词 |
| `discovery_appetite` | 0.5(中性) | 看用户对 Echo 推的"新艺人" vs "已知艺人"的接受率 |
| `anti_patterns[]` | 种子(`artist-genre-seed.json`)中的 `anti_patterns_guess` | 用户切歌 5+ 次的艺人/流派 |
| `signature_tracks[]` | 歌单里听歌次数 top 7 | 用户标 loved / 反复循环的 |
| `echo_portrait` | LLM 基于以上字段生成 | 每周日重写 |

## 3 · 状态机 · 冷启动的完整流程

```
[用户首次安装]
     │
     ▼
[设置页填 LLM + 测试通过]
     │
     ▼
[设置页 / 主对话引导页显示]"给我看看你的歌单吧"
     │
     ┌──────┴───────┐
     │              │
  导入 JSON     扫码登录(v0.2)
     │              │
     └───┬──────────┘
         ▼
[taste.ts · buildInitialProfile()]
     │
     ├─ 步骤 1:从歌单 + 听歌记录提取艺人频次
     ├─ 步骤 2:艺人 → genre 映射(查 artist-genre-seed.json)
     ├─ 步骤 3:标记未知艺人(echo_should_ask=true)
     ├─ 步骤 4:生成初版 TasteProfile + 初版 echo_portrait
     └─ 步骤 5:存入 SQLite
         │
         ▼
[触发 Echo 在对话里**主动打招呼** + 确认]
     │
     │   "我粗粗看了你的歌单。你听得挺杂:林俊杰、海洋Bo、
     │    一点 K-pop,还有 Pink 和 Bieber——不偏冷门的那种。
     │    你歌单里有几个艺人我还不太熟(陈默之、银河快递),
     │    改天你有空聊聊他们。"
     │
     ▼
[用户回应 → 后续对话]
     │
     ▼
[正常状态 · 持续演化]
```

## 4 · 演化算法

### 4.1 事件 → 档案变更的映射表

每次记录一个用户行为,`taste.ts:applySignal()` 按表处理:

| 事件 | 档案字段 · 如何变 |
|---|---|
| 听歌 > 80% 完成 | `artists[a].affinity += 0.02`(capped at 1)<br>`genres[g].weight += 0.01` |
| 听歌 < 30% 就切 | `artists[a].affinity -= 0.03`<br>连续 5 次 → 移到 `anti_patterns` |
| 循环 >= 3 次同一首 | 标记此首为 candidate `signature_track` |
| Echo 推荐被接受 + 听完 | `discovery_appetite += 0.005`<br>对应 genre.weight += 0.01 |
| Echo 推荐被秒切 | `discovery_appetite -= 0.005` |
| 主动搜索新艺人 | `discovery_appetite += 0.01` |
| `update_taste(like_artist, X)` | `artists[X].affinity = max(current, 0.7)` |
| `update_taste(unlike_artist, X)` | `artists[X].affinity = min(current, 0.3)` · 连续两次 → 移到 anti_patterns |
| `update_taste(event_started, ...)` | 写 `events` 表,不动 taste_profile |
| `update_taste(correct_assumption, ...)` | 写 `events` 表,下次 portrait 重写时考虑 |

### 4.2 衰减

人的品味会变。**不衰减 = Echo 永远活在半年前的你**。

每周日凌晨 3:00 跑 `decayTaste()`:

```typescript
for (const artist of taste.artists) {
  const daysSinceLastPlayed = daysBetween(artist.last_played, today);
  if (daysSinceLastPlayed > 90) {
    artist.affinity *= 0.9;   // 90 天没听,衰减 10%
  }
  if (artist.affinity < 0.15 && daysSinceLastPlayed > 180) {
    moveToArchive(artist);     // 半年没听且 affinity 低,移到归档(不显示在主页,不进推荐)
  }
}
```

### 4.3 冲突消解

用户行为可能矛盾(嘴上说不喜欢,实际又在听):

| 情况 | 怎么办 |
|---|---|
| `update_taste` 说"不喜欢 X",但最近 7 天听过 X 3 次 | 以 `update_taste` 为准,但在 events 里记一条"用户嘴上不喜欢 X 但还在听",下次对话 Echo 可以温和调侃 |
| 同一艺人 "like" 和 "unlike" 先后出现 | 以时间最近者为准 |
| 多设备同步(v0.4+)冲突 | last-write-wins + 冲突日志 |

## 5 · `echo_portrait` · 主页那段话怎么写

这段话是品味档案的"灵魂",也是 Echo 主页的 C 位。用户每周看一次,不能干巴巴。

### 5.1 生成时机

- **冷启动**:初版,基于歌单导入后立刻生成
- **每周日凌晨**:基于过去一周的行为重写
- **用户手动**:Echo 主页右上角一个小刷新按钮(藏着点),强制重写

### 5.2 生成 prompt

见 `prompts/portrait-writer.md`(下一步会创建)。核心约束:

- 150-200 字
- 衬线段落感(而不是列表)
- 体现"Echo 看见了 Ta 的**变化**"(对比上周/上个月)
- 不能只说"你喜欢 X"(这是数据),要说"你在 Y 时爱听 X"(这是洞察)

### 5.3 范例(基于你真实品味)

> "你喜欢旋律性强、情感直白的东西——林俊杰和海洋Bo 是你这周的两个轴心,
> 他们完全不像却又都在你这儿。你最近对 Charlie Puth 接受度比上个月高了,
> 我看你晚上常放。K-pop 是你的'白天电池',但你没给我一个具体喜欢的组合——
> 改天记得告诉我。
>
> 讨厌的类型我还在摸索,目前看来你不太碰实验电子和古典纯器乐——对吗?"
>
> — Echo · 写于 2026.04.27

**好在哪**:
- 提到**具体艺人**,不是抽象 genre
- 发现了**对比**(林俊杰和海洋Bo 不像但都爱)
- 提到**变化**(比上个月接受度高)
- 提出**问题**(K-pop 具体哪个组合、讨厌的类型),把问题沉淀到主页的"Echo 问你"区
- 不堆标签,像一段真实的观察

## 6 · "Echo 问你" 区 · 主页底部的问题

主页有个互动区(design/profile.html 第 7 章)。问题从哪来?

### 6.1 问题生成源

按优先级:

1. **`echo_should_ask: true` 的艺人**(来自种子)
   - 例:"陈默之我不太熟,你怎么形容他的歌?"
2. **用户在 K-pop 等模糊领域的占位**
   - 例:"你说喜欢 K-pop,具体是哪几个组合?"
3. **统计上的矛盾**
   - 例:"林俊杰你收藏很多但《修炼爱情》一首没有,是故意的吗?"
   - 例:"Bieber 你一个月前还切得很凶,最近怎么又听了?"
4. **Echo 的主观观察**(LLM 在写 portrait 时附带产出)
   - 例:"你最近迷上 city pop,是因为这风格本身,还是在怀念什么?"

### 6.2 显示规则

- 一次最多显示 **3 个**问题
- 用户点"回答" → 打开一个简化的对话弹窗(不是跳到主对话页,避免打断)
- 用户回答后,答案以 `user` 消息注入到主对话历史 + 触发 `update_taste`
- 用户点"跳过" → 当前问题 7 天内不再显示(避免骚扰)

### 6.3 问题存储

```sql
CREATE TABLE taste_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,                    -- 'unknown_artist' | 'modality_gap' | 'contradiction' | 'observation'
  content TEXT NOT NULL,
  context_json TEXT,            -- 回答后 update_taste 的参数
  status TEXT DEFAULT 'pending',-- pending | answered | skipped | expired
  expires_at DATETIME,
  answered_at DATETIME,
  answered_content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 7 · summary 字段 · 给对话用的

`taste_profile.summary` 是一段**精简版 200 字**给 LLM 作为 system context 用的。

**不是 `echo_portrait`**(那段是给用户看的,有情感);这个是给 LLM 读的,信息密度高。

例(基于你真实品味):

```
用户口味宽,不偏冷门。华语:林俊杰(top1,抒情技术派)、海洋Bo(治愈说唱,近期爆款)、
南征北战(励志说唱,情境性强)。欧美:Charlie Puth / Bieber / Pink(主流 pop + R&B,近期接受度上升)。
K-pop:喜欢但具体组合未知(需要问)。活跃事件:工作焦虑(4/15 起)。
Echo 推歌的"安全区":旋律性 + 情感直白,不要太冷门。尝鲜度 0.5。
```

`summary` 由 `portrait-writer.md` prompt 的同一次调用生成,但输出两段:给用户看的 portrait + 给 LLM 用的 summary。

## 8 · IPC 接口

```typescript
// 渲染 → 主
taste.get(): Promise<TasteProfile>                    // 完整档案
taste.getQuestions(n?: number): Promise<Question[]>   // 获取待回答问题
taste.answerQuestion(id: number, content: string): Promise<void>
taste.skipQuestion(id: number): Promise<void>
taste.regeneratePortrait(): Promise<void>             // 手动刷新主页那段话
taste.reinit(): Promise<void>                         // 核选项 · 清空重来
taste.importPlaylist(json): Promise<{ trackCount: number; unknownArtists: string[] }>

// 主 → 渲染(广播)
'taste:changed'    → { field: string }      // 触发 UI 局部刷新
'taste:question:new' → { question: Question }
```

## 9 · 失败模式

| 场景 | 处理 |
|---|---|
| 导入的歌单里艺人数 > 500,大量未知 | 不一次全问用户,把未知艺人按听歌频次排序,每周只激活 top 3 到 taste_questions |
| `update_taste` 被 LLM 乱调(比如每次都触发) | 主进程层有**冷却**:同一 `target` 同一天最多写 2 次;`correct_assumption` 每天最多 1 次 |
| 用户纠正 Echo 的某个观察但 Echo 下次又重犯 | `update_taste(correct_assumption, ...)` 写入 events 表,weight=1.0,注入到下次 portrait prompt 作为硬约束 |
| portrait 生成失败 | 保留上一版,不显示错误 |
| 演化到某个极端(比如 anti_patterns 爆增 50 条) | 管理员触发 reinit,或者 v0.2 加"软重置"——只保留 top 10 anti_pattern,其他归档 |

## 10 · v0.1 范围切分

### v0.1 必须:
- [x] 从导入歌单构建初版档案
- [x] 艺人 / genre 频次统计
- [x] `update_taste` 反馈写入
- [x] 主页展示(profile.html 已画)
- [x] 每日 LLM 初版 portrait 生成(日终跑一次)
- [x] "Echo 问你"区基础(从 echo_should_ask + 占位问题加载)
- [x] 重新初始化(设置页入口)
- [x] 打开艺人映射表编辑(设置页入口)

### v0.2:
- [ ] 行为反馈(听完/切歌)实时打分
- [ ] 衰减
- [ ] 周日凌晨重写 portrait
- [ ] 统计矛盾检测 → 自动生成问题
- [ ] 网易云 user_record 接入,更丰富历史

### v0.3+:
- [ ] 季度/年度回顾(基于 TasteProfile 历史快照)
- [ ] 多人格切换(为不同场景养不同的 Echo)
- [ ] 档案导出可视化报告

## 11 · 测试场景

| 场景 | 预期 |
|---|---|
| 导入 100 首歌单 | 5s 内构建完档案,主页有内容 |
| 种子里有的艺人(林俊杰) | genre 自动填对 |
| 种子里没有的艺人("某独立歌手") | 加入"Echo 问你"问题池 |
| 对话里说"我不喜欢 X 了",重开 app 查主页 | X 的 affinity 降了 / 移到 anti_patterns |
| 连续 90 天没听某艺人 | affinity 自然衰减 |
| 手动点"重新认识你" | 档案清空,触发引导重来 |
| 直接编辑 artist-genre-map.json 保存 | 不重启,下次推荐立刻用新映射 |
| "Echo 问你"区 3 个问题都跳过 | 7 天内不再显示,补新问题 |

## 12 · 一个冷启动的完整样例

```
Day 0 · 用户首次导入歌单(320 首)

[taste.ts:buildInitialProfile()]
解析歌单 → 识别 47 个艺人 → 查 artist-genre-seed.json
  ├─ 已知 12 个(林俊杰 / 海洋Bo / Pink / Bieber / Charlie Puth / ...)
  ├─ K-pop 组合占位 1 个 → 生成问题:"具体是哪几个组合"
  └─ 未知 34 个 → 按听歌次数排,top 3 进问题池(陈默之 / 银河快递 / ...)

初版 TasteProfile:
  genres: [华语流行 0.45, 华语说唱 0.22, pop 0.18, R&B 0.15]
  artists: [林俊杰 0.75, 海洋Bo 0.62, Charlie Puth 0.58, ...]
  discovery_appetite: 0.5
  signature_tracks: [top 7 播放次数]
  echo_portrait: (LLM 生成)
  
触发 Echo 在主对话里说:
  "我粗看了你的歌单。你听得挺杂——林俊杰、海洋Bo、一点 Pink 和 Bieber,
   不偏冷门。有几个艺人我还不太熟,改天聊聊。K-pop 你喜欢哪个组合?
   BLACKPINK、TWICE 还是别的?"

Day 1-6 · 用户日常用

每次听歌/对话 → applySignal() 增量更新 artists / genres 权重
每次 update_taste 工具调用 → 对应字段调整
"Echo 问你" 区的 3 个问题可能被点开,回答写入

Day 7 · 周日凌晨

[scheduler]
decayTaste()  → 超过 90 天没听的衰减 10%
regeneratePortrait() → 用这周的数据重写 echo_portrait + summary
  portrait 新版本:
    "你这周对 Charlie Puth 比上周更热——我数了一下,听了 8 次,上周才 3 次。
     林俊杰依然是你的第一,海洋Bo 掉下来一点(你说过听腻了一阵,我记得)。
     ..."
```

---

## 13 · 一个关键设计决策:**Echo 不做"个性测试"**

很多 AI 产品一上来让用户做问卷:"你喜欢什么类型的音乐?"。Echo 不这么做。

原因:
- 用户不会诚实答(会写"我喜欢小众独立"结果天天听抖音热歌)
- 用户自己都不知道自己到底喜欢什么
- 问卷 = 客服体验,和 Echo 的"朋友"人设冲突

Echo 的方式:**看你听了什么,然后问你一两个关键问题就够了**。剩下的它自己观察。

这就是为什么"Echo 问你"区只有 3 个问题、只问 `echo_should_ask` 的——**它问的问题自己解决不了,剩下的让它自己看**。
