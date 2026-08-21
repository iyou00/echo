# 队列页重设计 · 实施规格（依据 queue-redesign-preview.html 定稿）

状态：待实施（2026-08-21，用户已批准原型并裁掉迷你队列/重排/来源标注）

## 1. 页面结构（自上而下）

```
kicker「音 乐」
└─ 会话卡 session-card（微亮底+细边+轻影，同品味页层次语言）
   ├─ 头行：h1「正在排的」+ meta「接下来 N 首 · 播完的自动进「听过」」
   │        + 自动连播开关 + 「清空待播」按钮
   ├─ np-strip 正在播放条（有歌时）
   ├─ 队列行 ×N（拖拽 ⠿ / 封面 / 行点击=播放 / ♥ 收藏 / × 移除）
   └─ 队列区空态（无待播时：「排着的都放完了…」）
sub-kicker「我 的 曲 库 · 收藏与听过」
├─ 工具行：搜索框（歌名/歌手）+ 页签「收 藏 / 听 过」（计数）
├─ 收藏：行（＋插队 / ♥ 取消收藏）+ 分页器（50/页）
└─ 听过：按日分组（组头=日期+「清除这天」）行（↺ 重播 / ♥ 收藏）
```

整页空态（无歌、无收藏、无历史）保留既有 boundary→CTA 路径，不变。

## 2. 数据来源映射（全部既有通道，零主进程改动）

| UI | 来源 | 备注 |
|---|---|---|
| np-strip | playbackState.current/position/duration | 现有 |
| 接下来 N 首 | queue（去重、排除当前） | 现有 rest 派生 |
| 自动连播 | autoPlayNext prop / updateAutoPlayNext | **含开启时 enqueueContextAfter 补齐副作用，原样保留** |
| 清空待播 | echo.playback.clearQueue | 语义=清待播、正在放的不动；文案改「清空待播」 |
| 行点击播放 | playNowTrack | 现有 |
| ♥/×/拖拽 | toggleFavorite / removeTrack / reorder | 现有（拖拽 playbackIndex 换算不动） |
| 收藏列表/计数 | favorites.list({limit,offset})/count/onChanged | 现有分页；**搜索**：改词时拉 limit=200 前端过滤，清词恢复分页 |
| 收藏 ＋ 插队 | echo.playback.enqueue(asFresh) | 现有 |
| 听过分组 | queue.history(7) + openDays 折叠 | **默认展开最近一天**；删除多选模式，组头「清除这天」=clearHistoryDates([date]) |
| 听过 ↺/♥ | playHistoryTrack / toggleFavorite | 现有 |
| 队列区空态 | !playing && rest 空 | 新增（区内小空态，整页空态条件不变） |

## 3. 删除项

- 三页签 q-tabs（队列常显；收藏/听过降为曲库页签 lib-tab）
- past-tools 选择模式（selectedDates/historySelectMode 及清空 N 天按钮）
- 「让 Echo 重排」（用户否决）、行来源标注（用户否决）

## 4. 状态

tab: 'favorites'|'past'（默认 favorites）；libSearch: string；搜索态下分页器隐藏、显示匹配数；
favoritePage/openDays 保留；删 selectedDates/historySelectMode。

## 5. 验证

- E2E：选择器 `.d2-queue` 不变，queue-page.png 内容更新，无断言依赖 q-tabs
- walk-all：queue 步骤改点 `.lib-tab`（收藏↔听过）；新增断言：会话卡在场、清空待播后队列区空态、搜索过滤生效
- 真机：装机后 walk-all + walk-listening 全跑；截图核验层次（会话卡 vs 曲库）
