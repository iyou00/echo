# Feature · 推荐引擎(Recommendation)

> **核心问题**:Echo 决定推一首歌时,它从哪里"想"出这首歌?如何保证它推的歌**真的能在用户的歌单里找到 / 真的能播**?
>
> **对应代码模块**:`src/main/services/recommender.ts`
> **依赖**:`features/chat.md`(tool use 入口)、`netease/music.ts`(搜歌)、`taste_profile`(品味数据)

---

## 1 · 核心抉择:Echo 怎么"知道"该推什么?

这是整个推荐引擎的设计原点。有三种路线,Echo 选 **C(混合)**——

### 路线 A · 让 LLM 凭训练知识自由推荐
- LLM 自己想"用户喜欢 city pop,我推 Plastic Love"
- **优点**:不需要做候选池
- **缺点**:**幻觉灾难**——LLM 编出根本不存在的歌名;推的歌用户歌单里没有,搜不到只能扔掉;每次推的可能用户已经听腻

### 路线 B · 给 LLM 完整候选池,让它从中挑
- 把用户歌单 + 听歌历史塞进 prompt,LLM 在已知集合里挑
- **优点**:推的歌一定能搜到、一定符合用户范围
- **缺点**:歌单大就爆 token(1000 首歌 ≈ 30K tokens);**LLM 永远只能推用户已听过的,失去发现感**

### ✅ 路线 C · 双轨混合(Echo 的方案)

**分两步走,LLM 决定"路数",代码检索具体歌:**

```
LLM 决定"我现在想推什么气质 / 风格 / 情境"
            ↓
       生成 query(自然语言或结构化标签)
            ↓
   recommender.ts 用这个 query 在候选池里查
            ↓
        返回 1-N 首具体歌曲
            ↓
     反馈给 LLM,让它写小注 + 决定是否真的推
```

**举例**:LLM 内心:"她说困了,推个 city pop 慢节奏的吧" 
→ 调工具 `find_track({ mood: 'sleepy', genre: 'city pop', tempo: 'slow' })` 
→ recommender.ts 在用户歌单 + 候选池中找到 3 首 
→ 返回给 LLM 
→ LLM 选其中 1 首,加小注:"这首前奏有种下沉感"

**这样的好处**:
- ✅ 推的歌**一定真实存在**(从用户歌单或网易云检索而来)
- ✅ LLM 不需要塞整份歌单到 prompt(只塞 TasteProfile.summary 就够)
- ✅ 检索逻辑可以越来越聪明,LLM prompt 不动
- ✅ "已听腻"、"刚推过"、"用户刚拒绝过"这些黑名单逻辑放在 recommender.ts,LLM 不污染

## 2 · 候选池的三个层次

Echo 推歌的候选范围由近及远:

| 层 | 来自哪里 | 占比建议 | 用途 |
|---|---|---|---|
| **L1 · 用户歌单** | `playlists_imported` 表 + 网易云 user_playlist | 60% | 你已经收藏的——Echo "记得"你 |
| **L2 · 用户听歌历史** | `tracks_listened` + 网易云 user_record | 20% | 不在收藏但你听过的——补充集合 |
| **L3 · 网易云推荐** | 调网易云的 `recommend_songs` / `personal_fm` 接口 | 20% | 探索集合——Echo 给你的"新可能" |

**v0.1 只用 L1**(因为还没接网易云)。v0.2 起逐步打开 L2、L3。

### 候选池如何在内存里组织

启动时一次性加载到内存,用结构化索引:

```typescript
interface CandidatePool {
  // 全集 · 按 trackId 索引
  tracks: Map<string, Track>;

  // 倒排索引 · 用于快速过滤
  byGenre:  Map<string, Set<string>>;   // 'city pop' → trackIds
  byArtist: Map<string, Set<string>>;
  byMood:   Map<string, Set<string>>;   // 'sleepy', 'energetic' 等
  byTempo:  Map<'slow' | 'mid' | 'fast', Set<string>>;
  byEra:    Map<string, Set<string>>;   // '70s', '80s', ...

  // 用户行为状态
  recentlyPlayed:  Set<string>;          // 近 7 天听过
  recentlyPushed:  Set<string>;          // 近 7 天 Echo 推过
  recentlyRejected: Set<string>;         // 用户切歌或明确拒绝
  loved: Set<string>;                    // 多次循环
}

interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  duration_ms?: number;
  source: 'user_playlist' | 'user_history' | 'netease_recommend';
  // 启发式标签(由 taste.ts 在导入时打)
  tags: {
    genre?: string[];
    mood?: string[];
    tempo?: 'slow' | 'mid' | 'fast';
  };
}
```

**关键**:候选池**常驻内存**,启动时构建,行为发生时增量更新。不是每次推荐都查数据库。

## 3 · LLM 端 · 工具定义(替换 chat.md 中占位的 recommend_tracks)

`recommend_tracks` 工具改造为**双工具模式**——

### 3.1 `find_tracks` 工具(LLM 主动调用)

```typescript
{
  name: 'find_tracks',
  description: `当你想给用户推歌时,先用这个工具查找。你描述你想要的"气质",我返回 3-5 首匹配的具体歌。
不要直接说出歌名——让我去找。`,
  input_schema: {
    type: 'object',
    properties: {
      // 核心:气质描述,自由文本(可空)
      vibe: {
        type: 'string',
        description: '一两句话描述你想要的感觉。例:"慢节奏的 city pop,适合下午犯困"'
      },
      // 结构化条件(可选,LLM 自己判断要不要填)
      mood:   { type: 'string', enum: ['sleepy', 'energetic', 'sad', 'calm', 'happy', 'melancholy', 'focused'] },
      genre:  { type: 'string' },
      artist: { type: 'string', description: '指定艺人' },
      tempo:  { type: 'string', enum: ['slow', 'mid', 'fast'] },
      // 数量
      n: { type: 'integer', default: 3, minimum: 1, maximum: 5 }
    }
  }
}
```

工具返回:

```typescript
{
  candidates: [
    {
      // 临时引用 ID,不是真实 trackId(避免 LLM 胡编)
      ref: 'C1',
      title: '向云端',
      artist: '海洋Bo',
      year: 1996,
      vibeMatch: 0.92,    // 匹配度 0-1
      hint: 'user 收藏 · 近 30 天循环 5 次'  // 给 LLM 的小提示
    },
    { ref: 'C2', title: '...', artist: '...', ... },
    { ref: 'C3', title: '...', artist: '...', ... }
  ]
}
```

### 3.2 `play_tracks` 工具(LLM 决定推哪几首)

LLM 看完 candidates 后,选其中若干首,调:

```typescript
{
  name: 'play_tracks',
  description: '从 find_tracks 返回的候选里挑 1-3 首推给用户,加上你的小注',
  input_schema: {
    type: 'object',
    properties: {
      tracks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref:  { type: 'string', description: 'find_tracks 返回的 ref' },
            note: { type: 'string', description: '15 字内的衬线小注,可空' }
          },
          required: ['ref']
        }
      }
    },
    required: ['tracks']
  }
}
```

后端拿到 ref → 查表得到真实 trackId → 渲染 track card → 推给前端。

### 3.3 为什么要两步

**防 LLM 幻觉的关键**:
- LLM 永远不直接产生 trackId 或具体歌名
- 它只产生**抽象气质 → 选 ref**
- 真实歌曲数据完全由 recommender.ts 控制

代价:LLM 至少要做 2 轮调用。但都用流式 + 内存匹配,延迟可控(~200ms 检索 + LLM 二次响应 ~1s)。

## 4 · recommender.ts 主算法

### 4.1 检索打分

```typescript
function findTracks(query: FindTracksInput): RankedCandidate[] {
  // 1. 候选集筛选(求并集再求交集)
  let pool = new Set(candidates.tracks.keys());
  if (query.genre)  pool = intersect(pool, byGenre.get(query.genre));
  if (query.mood)   pool = intersect(pool, byMood.get(query.mood));
  if (query.artist) pool = intersect(pool, byArtist.get(query.artist));
  if (query.tempo)  pool = intersect(pool, byTempo.get(query.tempo));

  // 2. 黑名单(永远不返回)
  pool = subtract(pool, recentlyPushed);     // 7 天内推过
  pool = subtract(pool, recentlyRejected);   // 用户切过

  // 3. 打分
  return [...pool]
    .map(id => scoreTrack(id, query))
    .sort((a, b) => b.score - a.score)
    .slice(0, query.n ?? 3);
}

function scoreTrack(id: string, query: FindTracksInput): number {
  const track = candidates.tracks.get(id);
  let s = 0;

  // 来源加权:用户歌单 > 历史 > 网易云推荐
  s += { user_playlist: 0.4, user_history: 0.25, netease_recommend: 0.15 }[track.source];

  // 用户行为加权
  if (loved.has(id))            s += 0.20;   // 多次循环过
  if (recentlyPlayed.has(id))   s -= 0.10;   // 最近刚听过(避免立即重复)

  // vibe 文本相似度(用一个简单的 embedding,留接口)
  if (query.vibe) s += vibeSimilarity(track, query.vibe) * 0.3;

  // 结构化标签匹配度
  s += tagOverlap(track, query) * 0.2;

  // 时段适配(早晨听 city pop 比深夜听 city pop 略加分,反之亦然)
  s += timeOfDayBonus(track, currentTimeOfDay()) * 0.1;

  return clamp(s, 0, 1);
}
```

### 4.2 vibe 相似度怎么算

**v0.1 简化版**:不上 embedding 模型,用关键词匹配 + 启发式
```typescript
function vibeSimilarity(track: Track, vibe: string): number {
  const vibeKeywords = extractKeywords(vibe);  // "慢" "city pop" "下午" "犯困"
  const trackKeywords = [...(track.tags.genre || []), ...(track.tags.mood || [])];
  return jaccardSimilarity(vibeKeywords, trackKeywords);
}
```

**v0.2 增强版**:用本地 sentence embedding 模型(`paraphrase-multilingual-MiniLM-L12-v2`)做语义匹配。但 v0.1 不上,先用关键词。

### 4.3 多样性约束

LLM 要 5 首,recommender.ts 不能返回 5 首相似度最高的——会全是同一艺人/同一专辑。多样性后处理:

```typescript
function diversify(ranked: RankedCandidate[], k: number): RankedCandidate[] {
  const result = [];
  const seenArtists = new Set<string>();
  for (const c of ranked) {
    if (seenArtists.has(c.artist) && result.length < k - 1) continue;  // 跳同艺人,留最后一位灵活处理
    result.push(c);
    seenArtists.add(c.artist);
    if (result.length >= k) break;
  }
  return result;
}
```

## 5 · 标签系统 · 哪来的、谁打的

### 5.1 来源

每首歌的 `tags` 由三部分合并:

| 来源 | 字段 | 说明 |
|---|---|---|
| 网易云 API | genre / album / artist | 调 `song_detail` 拿到结构化字段 |
| 第三方音乐元数据 | mood / tempo | v0.2 候选:Last.fm tags / MusicBrainz |
| LLM 标注(v0.3+) | mood, vibe | 后台批量过 LLM 给小众歌补充标签 |

### 5.2 启发式打标(v0.1 用)

新歌入库时,`taste.ts` 立即用规则打初步标签:

```typescript
function autoTag(track: Track): Track['tags'] {
  const tags: Track['tags'] = {};
  // genre · 来自网易云字段 / 艺人映射表
  tags.genre = inferGenre(track.artist, track.album);
  // tempo · 简单分桶:duration < 3:30 → fast,> 5:00 → slow,中间 mid
  if (track.duration_ms) {
    if (track.duration_ms < 210000) tags.tempo = 'fast';
    else if (track.duration_ms > 300000) tags.tempo = 'slow';
    else tags.tempo = 'mid';
  }
  // mood · v0.1 留空,等用户行为反馈或后期 LLM 补
  return tags;
}
```

**艺人 → genre 映射表**:
- 文件路径:`data/artist-genre-map.json`(运行时;由 `samples/artist-genre-seed.json` 复制而来)
- v0.1 手工种子见 `samples/artist-genre-seed.json` —— 已包含用户实际喜欢的艺人(林俊杰、海洋Bo、Pink、Bieber 等),以及 `echo_should_ask` 字段标记 Echo 不熟的艺人

种子结构(简化版):
```json
{
  "artists": {
    "林俊杰":  { "genre": ["华语流行", "华语 R&B"], "mood": ["calm", "melancholy"], "tempo_default": "mid" },
    "海洋Bo":  { "genre": ["民谣说唱", "治愈系流行"], "echo_should_ask": false },
    "陈默之":  { "genre": ["华语独立"], "echo_should_ask": true },
    ...
  },
  "user_taste_signals": {
    "summary": "Echo 启动时注入 system prompt 的品味摘要"
  }
}
```

`echo_should_ask: true` 的艺人,recommender.ts 在首次推这位前会**附加一段隐式提示**给 LLM:"用户的 X 艺人画像我们还不熟,推荐前可考虑先在对话里聊聊。"

## 6 · 用户行为 → 候选池的反馈环

| 行为 | 影响 |
|---|---|
| 听完一首推荐(>80% 时长) | `loved` 加分;source 加权;tag 关联强化 |
| 听到一半切歌 | `recentlyRejected` +1(若多次切同一首,永久禁推) |
| 用户主动循环 | `loved` 强加权 |
| 用户给 Echo 反馈"这种再来一首" | `vibe` 信号强化,recommender 复用上一次 query 多搜几首 |
| 用户给 Echo 反馈"换一种风格" | 上一次 `vibe` 标记为 anti-pattern |

这套反馈写到 `tracks_listened` + `taste_profile.signals` 字段,定期(每周日凌晨)重新计算 candidate pool 的内存索引。

## 7 · 失败模式

| 场景 | 处理 |
|---|---|
| 候选池空(新用户没导入歌单) | `find_tracks` 返回 `{ candidates: [], reason: 'EMPTY_POOL' }` → LLM 接收提示后,只回话不推歌:"我还没听过你的歌,先给我导入一下歌单?" |
| 检索结果太少(<n 首) | 返回有几首给几首,LLM 自行决定够不够 |
| 用户拒绝过所有匹配 | 黑名单清空(只针对当前 query 不滤 `recentlyRejected`),给 LLM 一个标记 `relaxed: true` |
| 网易云未登录但需要 L3 | 降级到只用 L1 + L2 |
| 推完搜不到播放链接(v0.2) | track card 显示"我推这首,但播不出来",不影响对话 |

## 8 · 性能预算

候选池规模假设:
- 用户歌单中等规模:500 首
- 听歌历史:2000 首
- 网易云推荐缓存:200 首
- 总计 ~2700 首

内存占用:每首 Track 约 500B → 总计 1.5MB,毫无压力。
检索延迟:目标 <50ms(查倒排索引 + 打分都是 O(n) 简单遍历)。

## 9 · IPC 接口(主进程内部 · 不暴露给渲染)

```typescript
// recommender.ts 暴露的纯函数
findTracks(query: FindTracksInput): Promise<RankedCandidate[]>
resolvePlay(refs: string[]): Promise<Track[]>     // ref → 完整 Track
recordOutcome(trackId: string, action: 'played' | 'skipped' | 'looped' | 'loved'): Promise<void>
rebuildPool(): Promise<{ size: number }>          // 重建内存索引
```

## 10 · v0.1 范围切分

### v0.1 必须:
- [x] 候选池 L1(用户导入歌单)
- [x] 关键词 vibe 相似度
- [x] 启发式打标(genre/tempo)
- [x] 多样性约束
- [x] 行为黑名单(7 天内推过的不再推)
- [x] `find_tracks` + `play_tracks` 双工具

### v0.2:
- [ ] 候选池 L2(听歌历史)
- [ ] 网易云搜歌实播放
- [ ] 用户行为反馈(切歌、循环)写入数据库

### v0.3+:
- [ ] 候选池 L3(网易云推荐)
- [ ] sentence embedding vibe 匹配
- [ ] LLM 后台批量打 mood/vibe 标签
- [ ] 艺人未知时 Echo 主动问

## 11 · 测试场景

| 场景 | 预期 |
|---|---|
| 新用户没歌单,发"推几首歌" | Echo 不推,而是说"我还没听过你的歌,导入一下吧" |
| 导入 500 首歌单后,发"推几首慢的" | 5 个候选 → LLM 选 3 首推荐,无重复艺人 |
| 同一会话连续推 3 次"慢的" | 每次推的歌不同(7 天内黑名单生效) |
| 用户切歌 5 次同一首 | 该首进永久黑名单 |
| 用户说"换种风格" | 下一次 query 不带前一次的 mood 标签 |
| 候选池只有 1 首匹配 | 返回 1 首,LLM 也只推 1 首 |

## 12 · 一个完整的对话样例

```
[user] 我想睡觉了,放点慢的

[chat.ts] 拼 prompt → 发 LLM
[llm-stream] "嗯,这个点该睡了。我找点慢慢飘起来的——"
[llm tool_use] find_tracks({ vibe: "慢节奏 适合入睡 飘起来", n: 3 })

[recommender.ts] 命中 5 首,排序后取 3:
  - C1: 海洋Bo / 向云端 (loved · score 0.94)
  - C2: 林俊杰 / 我怀念的 (user_playlist · score 0.81)
  - C3: Charlie Puth / We Don't Talk Anymore (user_history · score 0.72)

[llm 收到 candidates]
[llm 继续] "《向云端》你最近常听,昨晚已经放过了——"
[llm tool_use] play_tracks({ tracks: [
  { ref: 'C2', note: '— 慢一点,让你别紧绷' }
] })

[recommender.ts] resolvePlay(['C2']) → Track + 播放链接
[chat.ts → renderer] 推送一张 track card

[渲染] 显示 Echo 的话 + 一张林俊杰《我怀念的》的 track card,带"— 慢一点,让你别紧绷"
```

注意 LLM 在第二轮做了**信息整合**:看到 C1 是 `loved` 但又看到自己最近推过(虽然 candidates 已经过滤了 7 天黑名单,这里假设是别的边界情况),它选了 C2 并解释为什么。这是混合方案的精髓——**LLM 做品味判断,代码做事实判断**。
