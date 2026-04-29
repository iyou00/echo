# 数据模型

## 设计原则

1. **显式分层**,不混在一起
2. **关系型优先**,只有真正需要才上 JSON
3. **存的都是"能还原用户"的素材**,LLM 调用时再拼
4. **一个 SQLite 文件 = 一个Echo**,备份即完整迁移

## 三层记忆

| 层 | 存什么 | 生命周期 | 何时注入 prompt |
|---|---|---|---|
| **L1 · 长期品味** | TasteProfile | 永久,缓慢演化 | 每次对话都注入摘要版 |
| **L2 · 中期事件** | 重要事件/情绪/阶段 | 几天到几个月 | 相关对话时注入 |
| **L3 · 短期对话** | 对话原文 | 最近 N 轮注入,更早的压缩 | 每次对话最近 N 轮 + 相关摘要 |

## SQLite Schema

### 表:`users`(单用户,但为未来留口子)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT,              -- 用户的名字 / 昵称
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 表:`taste_profile`(L1 长期品味)

存 **1 行 JSON** 是最灵活的,因为品味字段会演化。

```sql
CREATE TABLE taste_profile (
  user_id INTEGER PRIMARY KEY,
  profile_json TEXT NOT NULL,   -- 完整 TasteProfile JSON
  summary TEXT,                  -- LLM 生成的人话摘要,供注入 prompt
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

#### TasteProfile JSON 结构

```typescript
interface TasteProfile {
  // 流派及其权重(0-1)+ 趋势
  genres: Array<{
    name: string;              // "city pop" / "post-rock"
    weight: number;            // 0.0 – 1.0
    trend: 'up' | 'down' | 'steady';
  }>;

  // 钟爱艺人
  artists: Array<{
    name: string;
    affinity: number;          // 0.0 – 1.0
    last_played?: string;      // ISO date
    notes?: string;            // Echo自己加的小标签
  }>;

  // 情绪 tag → 频率(用户常在什么情绪下听什么)
  moods: Array<{
    tag: string;               // "深夜" / "通勤" / "失眠"
    frequency: number;
    signature_artists?: string[];
  }>;

  // 年代倾向(归一化后加起来 = 1)· 后台存,主页不展示(v0.1 决定)
  era_preference?: {
    '70s'?: number;
    '80s'?: number;
    '90s'?: number;
    '00s'?: number;
    '10s'?: number;
    '20s'?: number;
  };

  // 尝鲜度 0(只听老歌)– 1(爱探索)
  discovery_appetite: number;

  // 明确不喜欢的:流派 / 艺人 / 类型
  anti_patterns: string[];

  // "代表你"的 7 首
  signature_tracks: Array<{
    title: string;
    artist: string;
    reason?: string;           // Echo写的,为什么这首代表你
  }>;

  // Echo对你的一段总结话(它会在主页上说出来)
  echo_portrait: string;       // "你喜欢在深夜里听那些写得很慢的歌……"
}
```

### 表:`events`(L2 中期事件记忆)

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind TEXT NOT NULL,             -- 'emotion' | 'milestone' | 'context'
  content TEXT NOT NULL,          -- "上周分手了" / "在准备考研"
  confidence REAL,                -- 0.0-1.0,Echo推断的可信度
  weight REAL DEFAULT 1.0,        -- 随时间衰减
  started_at DATETIME,
  expected_end_at DATETIME,       -- 预期什么时候不再相关
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_events_active ON events(user_id, expected_end_at);
```

`weight` 随时间衰减:事件越旧,注入 prompt 的概率越低,直到 expected_end_at 后基本不再出现。

### 表:`conversations`(L3 短期对话)

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  role TEXT NOT NULL,             -- 'user' | 'assistant'
  content TEXT NOT NULL,
  meta_json TEXT,                 -- 附加信息:推荐了哪首、时间、情绪标签等
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_conv_recent ON conversations(user_id, created_at DESC);
```

### 表:`conversation_summaries`(对话压缩)

超过 30 轮的对话不能一直塞进 prompt,定期压缩成摘要:

```sql
CREATE TABLE conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  period_start DATETIME,
  period_end DATETIME,
  summary TEXT NOT NULL,          -- LLM 生成的一段摘要
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 表:`yinyi`(音忆日记)

```sql
CREATE TABLE yinyi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  date DATE NOT NULL UNIQUE,      -- 一天一篇
  content TEXT NOT NULL,
  style TEXT DEFAULT 'dialogue',  -- 'dialogue' | 'narrative' | ...(以后可能有多种风格)
  meta_json TEXT,                 -- 当天的统计数据:听了多少首、top 艺人等
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 表:`tracks_listened`(听歌记录)

```sql
CREATE TABLE tracks_listened (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  source TEXT,                    -- 'recommended_by_echo' | 'user_picked' | 'imported'
  listened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed BOOLEAN DEFAULT 1,    -- 听完了还是切歌了
  meta_json TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_tracks_recent ON tracks_listened(user_id, listened_at DESC);
```

### 表:`playlists_imported`(导入的歌单,原始归档)

```sql
CREATE TABLE playlists_imported (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  source TEXT,                    -- 'netease' 等
  name TEXT,
  raw_json TEXT,                  -- 原始结构化数据
  imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 表:`taste_questions`(Echo 问你的问题池)

Echo 主页底部"Echo 问你"区的问题。Echo 通过这些问题主动澄清它不确定的地方。

```sql
CREATE TABLE taste_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind TEXT NOT NULL,             -- 'unknown_artist' | 'modality_gap' | 'contradiction' | 'observation'
  content TEXT NOT NULL,          -- 问题文本
  context_json TEXT,              -- 结构化上下文(艺人名、genre、触发原因等)
  status TEXT DEFAULT 'pending',  -- pending | answered | skipped | expired
  answered_content TEXT,          -- 用户回答原文
  answered_at DATETIME,
  expires_at DATETIME,            -- 跳过后 7 天内不再出现
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_tq_pending ON taste_questions(user_id, status, created_at DESC);
```

### 表:`settings`(用户偏好,单行 JSON)

整个 app 只有一行,用 JSON 存所有偏好。新增设置项**不需要改 schema**,
只需更新 `Settings` TypeScript interface 和 UI。

```sql
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- 永远只有 id=1 这一行
  data_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 初始化语句:
INSERT INTO settings (id, data_json) VALUES (1, '{}');
```

#### Settings JSON 结构

```typescript
interface Settings {
  // === AI 模型 ===
  llm: {
    baseUrl: string;          // 默认空,用户必填。例:"https://api.deepseek.com/v1"
    apiKey: string;           // 加密存(safeStorage),内存中明文
    model: string;            // 默认空,用户必填。例:"deepseek-chat"
    lastTestedAt?: string;    // 上次测试连接的时间
    lastTestedOk?: boolean;
  };

  // === 音忆 ===
  yinyi: {
    generateAt: string;       // "HH:mm" 格式,默认 "22:00"
    openWithRandom: boolean;  // 默认 false:打开看今天;true:看随机过去一篇
  };

  // === 对话与品味 ===
  chat: {
    restoreOnStart: boolean;  // 默认 true
  };

  // === 用户上下文 ===
  user: {
    city: string;             // 默认空,听音天气开场使用
  };

  // === 听音 TTS ===
  tts: {
    baseUrl: string;          // 默认 "https://tts.wangwangit.com"
    voice: string;            // 默认 "zh-CN-XiaochenNeural"
    speed: number;            // 默认 1.0
    pitch: string;            // 默认 "0"
  };

  // === UI ===
  ui: {
    theme?: 'light' | 'dark' | 'system';  // v0.4+,先预留
    closeBehavior?: 'ask' | 'minimize' | 'quit';
  };

  // === 元信息 ===
  meta: {
    schemaVersion: number;    // 当前 1,以后 schema 演化时升
    firstUsedAt: string;
  };
}
```

**安全约束**:`apiKey` 字段在写入数据库前用 Electron `safeStorage.encryptString()` 加密,
读出时 `decryptString()`。**绝不**存明文。日志里也不打印。

## Prompt 注入策略

每次对话时,主进程组装 context 的顺序:

```
[system prompt]  ← Echo人格,来自 prompts/system.md
[taste_profile.summary]  ← L1 摘要版(~200 字)
[active events]  ← L2 里 weight > 0.3 的事件
[最近对话摘要]  ← L3 压缩历史(有的话)
[最近 N 轮对话原文]  ← L3 原始,N 大约 10-15
[当前用户消息]
```

## 常见查询

```sql
-- 活跃的中期事件
SELECT * FROM events
WHERE user_id = ? 
  AND (expected_end_at IS NULL OR expected_end_at > datetime('now'))
  AND weight > 0.3
ORDER BY created_at DESC;

-- 最近 15 轮对话
SELECT * FROM conversations 
WHERE user_id = ?
ORDER BY created_at DESC 
LIMIT 15;

-- 最近 7 天听了多少首Echo推荐的
SELECT COUNT(*) FROM tracks_listened
WHERE user_id = ? 
  AND source = 'recommended_by_echo'
  AND listened_at > datetime('now', '-7 days');
```
