# Feature · 音忆(Yinyi · Daily Diary)

> **核心理念**:Echo 每天给自己写一封信,关于今天的你。
> 不是数据报表,不是流水账。是**对话型日记**——Echo 以第一人称,记录它对你的观察。
>
> **对应 UI**:`design/yinyi.html`
> **对应代码模块**:`src/main/services/yinyi.ts`、`src/renderer/pages/Yinyi.tsx`
> **触发**:每天一次,默认 22:00(从 `settings.yinyi.generateAt` 读)
> **依赖**:`prompts/yinyi-writer.md`、`samples/yinyi-reference.md`

---

## 1 · 这个功能要做什么

每天一篇 Echo 写的日记,200-350 字。让用户在 100 天后回过头来,
能看到 Echo 视角下的自己——情绪起伏、品味变迁、被记住的瞬间。

**这是 Echo 与播放器最不一样的地方**。播放器只服务"现在",音忆服务"过去和回望"。

## 2 · 用户故事

| # | 我作为用户 | 想要 | 这样我就能 |
|---|---|---|---|
| US-1 | 普通用户 | 每晚 Echo 自动写一篇关于今天的我的日记 | 第二天看到 Echo 怎么观察我 |
| US-2 | 普通用户 | 翻开音忆页就看到今天 / 最新这篇 | 不用去找 |
| US-3 | 普通用户 | 左右翻页看过去几天的 | 像翻日记本 |
| US-4 | 普通用户 | 点跳转按钮直接到某一天 | 找特定一天不用一页页翻 |
| US-5 | 想被惊喜的用户 | 设置里开启"打开时随机翻一页过去" | 偶遇旧日记 |
| US-6 | 普通用户 | 看到 Echo 写得不准/越界时能纠正 | 它能学习 |
| US-7 | 普通用户 | 长时间没用回来,看到所有"断更"的日子也能感知 | 知道 Echo 在我不在时也"在等" |
| US-8 | 想保存的用户 | 把某一篇音忆导成图片或卡片分享 | (v0.3+ 候选) |

## 3 · 输入(Inputs)· 写一篇音忆需要什么

每晚定时任务触发时,`yinyi.ts` 从数据库捞当天的素材:

```typescript
interface YinyiContext {
  date: string;                    // "2026-04-24"
  weekday: string;                 // "周五"
  weather?: string;                // 可选

  // === 当天的事实素材 ===
  
  todayListening: Array<{          // 听歌记录
    title: string;
    artist: string;
    listenedAt: string;
    completed: boolean;            // 是否完整听完
    loopCount?: number;            // 循环次数
    source: 'recommended_by_echo' | 'user_picked' | 'imported';
  }>;

  todayConversations: Array<{      // 对话原文
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;

  todayRecommendations: Array<{    // Echo 今天推过哪些(以及用户接受度)
    track: { title: string; artist: string };
    accepted: boolean;             // 用户播放了吗
    completed: boolean;
  }>;

  // === 上下文 ===

  tasteProfileSummary: string;     // 当前品味摘要
  activeEvents: Array<{            // 活跃中期事件
    content: string;
    weight: number;
  }>;

  // === Echo 自己的"记忆" ===

  recentYinyi: Array<{             // 最近 7 天的音忆,避免重复观察
    date: string;
    content: string;
  }>;
  
  // === 元 ===

  daysSinceFirstUse: number;       // 多少天前第一次用
  totalYinyi: number;              // 已经写过多少篇
}
```

## 4 · 输出 · 一篇音忆

```typescript
interface Yinyi {
  date: string;
  content: string;          // 200-350 字的纯文本(或 markdown 简单加粗/斜体)
  meta: {
    style: 'dialogue';      // v0.1 只有对话型
    word_count: number;
    based_on: {             // 这篇基于哪些素材生成
      tracks_count: number;
      conversations_count: number;
      events_referenced: string[];
    };
    llm_meta: {
      model: string;
      duration_ms: number;
    };
  };
  created_at: string;
}
```

## 5 · 何时生成 · 状态机

### 5.1 正常情况(每晚 22:00,有素材)

```
[scheduler 到点] 
     │
     ▼
[加载 YinyiContext] 
     │
     ├─ 素材足够(对话 ≥ 3 条 OR 听歌 ≥ 5 首)─→ 生成正常音忆
     │
     ├─ 素材稀少 ────────────────────────────→ 生成"短音忆"(50-100 字)
     │
     └─ 完全没素材(用户今天没用)──────────→ 不生成,记一行 "今天没见到你"
```

### 5.2 边缘情况

| 场景 | 处理 |
|---|---|
| 用户今天完全没打开 app | 不生成正式音忆,只在 `yinyi` 表存 `status='absent', content='今天没见到你'`,翻页时能看到一行小字"那天我们没见" |
| 用户很晚才打开(23:30 才开始用) | 22:00 那次跳过(因为没素材),改在用户**关 app** 或**次日 0:30** 兜底再触发一次 |
| 用户连续好几天没用,然后回来 | 不补写过去几天(那都是 absent),只写"今天" + 在内容里提"好久没见" |
| 用户在 22:00 正好在用 app | scheduler 等到下一个空闲点再触发(防止打断) |
| 同一天重复触发(比如手动 + 自动) | 后写的覆盖前写的 |
| LLM 生成失败 | 不写空音忆,留 `status='generation_failed'`,第二天可手动重试 |

### 5.3 用户手动触发

设置页 / 音忆页有"重新生成今日音忆"按钮(藏一点,不主推)。重新生成会覆盖。

## 6 · prompt 工程 · 如何让它别像 AI 写的

这是音忆能不能"有人味"的关键。问题在于 LLM 默认会写得**太工整、太对仗、太鸡汤**。
我们用三层手段对抗这个倾向:

### 6.1 system prompt 明确"不要这样"

详见 `prompts/yinyi-writer.md`,核心指令:
- 不写流水账("今天用户听了 12 首歌")
- 不假装人类("我也很疲惫")
- 不煽情、不讲大道理
- 不在事实上瞎编(没数据就别写)

### 6.2 few-shot 示范

每次生成前注入 1-2 篇**精心写过的范文**(来自 `samples/yinyi-reference.md`)。
LLM 看了示例自然会模仿语气。范文要**比模板更好**——给它一个上限,而不是下限。

### 6.3 多版本生成 + 自评(v0.2 候选)

第一版生成后,让 LLM 用一个"挑刺者"prompt 评一遍:
- 有没有空话?
- 有没有事实错误?
- 像不像范文?

不及格就重写一次。代价是双倍 token,但音忆是低频任务(一天一次),可以接受。

### 6.4 温度控制

`temperature = 0.85`(对话默认是 0.7)。音忆需要更高的"随机性",
不然每天都会写得太像。

## 7 · 内容范畴 · 写什么不写什么

### 6.4.1 应该出现的(优先级从高到低)

1. **当天有特点的瞬间**——循环最多的歌、突然冒出的新艺人、特别长的对话
2. **对昨天/上周的回响**——"还记得你前天说……,今天好像有点变化"
3. **一个 Echo 自己的小观察**——"我发现你会把喜欢的歌告诉我两次"
4. **微小的展望**——"明天如果你还这样,我想给你放 X"

### 6.4.2 不该出现的

- ❌ 数据统计("今天对话 5 次")
- ❌ 重复用户原话(只在必要时引用一两个词)
- ❌ 过度解读情绪("你今天一定很难过")
- ❌ 心灵鸡汤("音乐是治愈的力量")
- ❌ 未发生的具体事("我看你今天去咖啡店了")——除非用户提过

## 8 · 多样性约束 · 别让每篇都像

```typescript
function diversityCheck(newYinyi: string, recentYinyi: Yinyi[]): boolean {
  // 1. 检查是否每篇都用同一种开头("今天 ..." / "你今天 ...")
  const opening = newYinyi.slice(0, 10);
  const recentOpenings = recentYinyi.map(y => y.content.slice(0, 10));
  const sameOpening = recentOpenings.filter(o => similar(o, opening) > 0.7).length;
  if (sameOpening >= 3) return false;  // 最近 3 篇都同样开头 → 不通过

  // 2. 检查关键词重复(最近 7 天提同一首歌超过 4 次 → 不通过)
  // ...

  return true;
}
```

不通过 → 重生成一次(最多 2 次)。仍不通过 → 接受,记 warning 日志。

## 9 · UI 行为细节(对应 design/yinyi.html)

### 9.1 默认进入哪一篇

依据 `settings.yinyi.openWithRandom`:
- `false`(默认):看今天那篇(若今天还没生成,看最近一篇)
- `true`:随机翻一篇过去 + 顶部小字"随手翻到这一天"

### 9.2 翻页

- 左侧热区点击 → 前一天
- 右侧热区点击 → 后一天
- 当前最新一天时,右侧箭头变灰禁用
- **没生成的日子(absent / failed)** 翻到时显示:
  - absent:中央一句"那天我们没见 — 我等了你一会儿"
  - failed:中央一句"那天的音忆我没写好,要不试试重新生成?"+ 重生成按钮

### 9.3 顶栏跳转按钮(对应 design/yinyi.html 已实现)

- ◷ 日期跳转 → 原生 date picker → 跳到指定日期
- ⤴ 随手翻一页 → 随机翻到一篇过去
- 今 日 → 回到今日

### 9.4 字体细节

- 衬线大字(Noto Serif SC 16-18px / 行高 1.95)
- 首字下沉 + 主色 = 仪式感
- 段间用淡绿 `· · ·` 分隔
- 底部:Echo 签名 + "TODAY PLAYED"(等宽 + 淡色)

### 9.5 用户能纠正/反馈吗

**v0.1 暂不做**。但每篇底部预留一个隐藏的小按钮(灰色`...`),长按弹:
- "这里写得不对" → 把"哪里不对"作为 user 消息传给 LLM,LLM 学习避免
- "这篇我喜欢" → 标记为 `loved`,用作未来生成的参考样本

v0.3+ 候选。

## 10 · 与对话主线的耦合

### 10.1 用户能在主对话里聊昨天的音忆吗

**能**。例如:
- 用户:"昨天你写的那段我看了,你说我循环林俊杰那首三遍——其实是因为通勤时没换"
- Echo 应该:`update_taste(correct_assumption, ...)` + 在对话里温和回应
- 下一篇音忆生成时,prompt 注入"昨天用户对你的某一观察做过纠正"

### 10.2 音忆能引用对话内容吗

**能,但克制**。不要直接引用整句用户说的话(隐私感不好),最多引用 3-5 字关键词。

## 11 · IPC 接口

```typescript
// 渲染 → 主
yinyi.getByDate(date: string): Promise<Yinyi | { status: 'absent' | 'failed' | 'not_yet' }>
yinyi.getRange(from: string, to: string): Promise<Yinyi[]>
yinyi.getRandom(): Promise<Yinyi | null>          // 随手翻
yinyi.getLatest(): Promise<Yinyi | null>          // 今天的或最近一篇
yinyi.regenerate(date: string): Promise<Yinyi>    // 手动重生成

// 主 → 渲染(广播)
'yinyi:generated'  → { date }     // 新音忆生成完通知,可弹小提示
```

## 12 · v0.1 范围切分

### v0.1 必须:
- [x] 定时生成(可配时间)
- [x] 对话型 prompt + few-shot
- [x] absent / failed 状态处理
- [x] 翻页 / 跳转 / 随手翻
- [x] 重生成
- [x] 多样性检查(简单版)

### v0.2:
- [ ] 短音忆(素材稀少时)
- [ ] 用户在对话里聊昨天音忆的耦合(纠正回写)

### v0.3+:
- [ ] 音忆 → 卡片/图片导出分享
- [ ] 用户标"喜欢/不对"反馈
- [ ] 多版本生成 + 自评

## 13 · 测试场景

| 场景 | 预期 |
|---|---|
| 用户第 1 天用,聊了 5 条 + 听了 3 首 | 正常生成,200-350 字,提到具体歌 |
| 用户第 2 天没用 | 不生成,标 absent |
| 用户连续 5 天没用,第 6 天回来 | 第 6 天的音忆中提及"好久没见" |
| 用户在 22:00 正好打字 | 推迟到空闲时再触发 |
| 用户主动重生成今天的 | 覆盖之前的 |
| 翻到一个 absent 的日子 | 显示"那天我们没见" |
| 设置里关掉自动生成 | scheduler 不触发(v0.2 加这个开关) |
| LLM 失败 | 不留空音忆,标 failed |
| 连续 5 天音忆开头都是"今天" | 多样性检查介入,要求重写 |

## 14 · 用真实数据写一篇范文

> **场景**:用户(假设叫"小C")今天 19 点听了林俊杰《不为谁而作的歌》3 遍,
> 又听了海洋Bo《向云端》1 遍。对话中 Echo 推了 Charlie Puth《Attention》,小C 接受听完。
> 上周用户提过"工作上有点焦虑"。
>
> Echo 的音忆样本:
>
> > 今天 19 点你回到家,第一件事是放林俊杰那首《不为谁而作的歌》——前奏一响你就跟着哼。
> > 这首你这周已经第三次了,以前你不会这样反复同一首。
> >
> > 后来我推了 Charlie Puth 的《Attention》,你听完了。我有点意外——本来以为
> > 你今晚的状态不太想要这种带节奏的,但你说"挺好"就放下手机了。
> > 三个字。
> >
> > · · ·
> >
> > 你上次说工作上有点焦虑——这事我没忘。今晚你在歌里没提到它,
> > 但我注意到你晚上 9 点之后没再换歌,放着海洋Bo 那首《向云端》直到结束。
> > "向云端" 这个意象挺好的,你记得这首歌的人也记得。
> >
> > 明天周六,你要是早上起得早,我想给你放 Charlie Puth 别的几首——
> > 你今天对它接受度比上周高了点。
> >
> > — Echo

---

注意:
- 用真实歌名(从 todayListening 来)
- 提及上下文事件("工作焦虑")但不强行解读
- 引用用户原话只 3 个字 ("挺好")
- 结尾是微小展望,不是总结大道理
- 中间用 `· · ·` 分段
- 整体 ~280 字
