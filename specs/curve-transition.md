# 首页曲线 → 播放的过渡链修复方案

## 现状链路（实测时间线，2026-08-24）

```
用户发送                → Chat.tsx setSending(true)
  ↓ field=streaming      （红线生长 + 蓝线拨弦）
  ↓ 3-6s                 （LLM 生成中）
  ↓ phase 涉及 search    → field=searching（绿线生长）
  ↓ 找到歌               → 回 field=streaming（第二轮文字）★突变点A
echo.chat.send() 返回     → sending=false → field=chat（静态平静）★突变点B
  ↓ 歌的 play() 异步启动  → 约 1-3 秒空档（chat 静态，无视觉反馈）★体验断裂
playback.status=loading   → 自动弹一起听
```

## 三个问题

1. **A（searching→streaming 突变）**：绿线还没长完就切回红线形态——交叉淡化视觉上可接受（已修过空窗），但形态跳变仍突兀。
2. **B（streaming→chat 静默过渡）**：文字流完，曲线立刻回到「平静静态」——用户不知道 Echo 正在起歌。
3. **C（chat 空档 1-3 秒）**：`sending=false` 到 `playback.status=loading` 之间，界面完全没有「正在准备歌」的视觉信号。

## 方案：延迟曲线回归 + 预备形态

核心思路：**文字流完不等于回复结束——歌还在起**。引入 `field=preparing`（预备形态）：

### 变更 1：Chat.tsx — sending 的终点延后到歌启动后

```ts
// 现在：send() 返回 → finally setSending(false)
// 改为：send() 返回后检查是否有 track 待播
//   有 → 维持 sending=true，等 playback.status 变为 playing/loading 后再 false
//   无 → 立即 false（纯文字回复）

try {
  const result = await echo.chat.send(text)
  // ...
  if (nextTrack) {
    // 播放链路启动
    const nextState = await echo.playback.play(nextTrack)
    setPlaybackState(nextState)
    // sending 保持 true——直到这里才结束
  }
  await refreshQueue()
} finally {
  setSending(false)  // 歌已就位（或无歌），sending 结束
}
```

**效果**：field 在整个「文字+起歌」周期内都是 streaming/searching，不回 chat。sending=false 的瞬间恰好是歌已挂载——field 变 chat 的同时一起听自动弹出，视觉零空档。

### 变更 2：stageMode — 新增 preparing 形态（可选增强）

如果变更 1 已足够消除空档（field 不回 chat 直到歌就绪），则不需要新形态。**先实施变更 1，实测效果**——如果歌启动后回 chat 时的曲线突变更静仍有不适感，再考虑 preparing。

### 不动的东西

- **listeningAutoOpenedRef**：本会话首次自动弹的资格是设计内行为。实测确认它在正确运作（每会话只弹一次）。
- **WindowField 的 crossfade**：形态过渡已有 520ms 交叉淡化，变更 1 不会破坏它。
- **搜索空窗修复**：之前修过的 fast-start growth 不受影响。

## 验证计划

1. 真机复现「来一首轻快一点的歌曲」——timeline 中不应出现 field=chat → 空 → 弹播放的序列
2. 纯文字提问（「你是谁」）——sending 延迟不应让曲线在无歌场景多转
3. walk-all 全矩阵 + walk-listening 42 项
