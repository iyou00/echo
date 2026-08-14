# Echo Agent Phase 2 技术设计

状态：Implemented，回归验证通过
目标版本：Agent Kernel Phase 2
范围：受控主动性
前置条件：Phase 1 连续情境与行动结果闭环通过验收

## 1. 决策摘要

Phase 2 不增加新的主动入口，也不让 LLM 自由决定触发频率。现有 `carePingSchedule -> runCarePingSlot -> generateAndSendCarePing` 链路保留，在生成通知之前加入一个确定性的 `ProactiveBudgetPolicy`：

```text
定时计划到点
    |
    v
读取设置、阶段、近期交互、主动行动与结果
    |
    v
ProactiveBudgetPolicy
    +-- allow   -> 选择通知类型 -> LLM 写文案 -> 通知执行 -> 记录结果
    +-- defer   -> 更新本计划的最早重试时间 -> 当前保持沉默
    +-- silence -> 当前保持沉默，不生成文案
```

核心选择：

- 代码决定是否出现、何时出现和还能出现几次。
- LLM 只在 `allow` 后判断通知类型的适配度和起草文案；搜索、通知与播放仍由代码执行。
- `stay_silent` 是正式行动，`defer` 是带重试时间的 `stay_silent`，两者都可解释。
- “没有点开通知”只影响主动分寸；“不喜欢这首歌”只影响音乐选择。
- 预算只在通知成功展示后消耗。生成失败、系统通知失败和取消不消耗用户预算。

## 2. 目标与非目标

### 2.1 目标

- 主动触发受到每日上限、最小间隔、安静时段、暂停状态和当前阶段约束。
- 用户近期忽略、收起或静音后，主动频率确定性下降。
- 用户可以关闭、暂停、调整主动程度和设置安静时段。
- 每次允许、延后或沉默都有受控原因，可在本地调试视图解释。
- 主动通知的展示、点开、收起、忽略和后续播放结果分别记录。

### 2.2 非目标

- 不新增短信、邮件、手机推送或云端触达。
- 不扩展为通用提醒或日程 Agent。
- 不在 Phase 2 学习调侃、道歉或关系修复策略；这是 Phase 3。
- 不基于单次忽略永久修改人格或长期关系。
- 不为了提高打开率突破用户配置、安全策略或安静时段。

## 3. 现有基线与改造边界

现有实现已经具备：

- `carePings.enabled`、`frequency`、`detectFullscreen` 设置；
- 每日 2/3/4 个候选时间窗及错过后的 45 分钟补发窗口；
- 当日静音、基础 readiness、通知点击和 Agent Action；
- `opened`、播放结果及 `stay_silent` 结果基础。

Phase 2 不替换 scheduler。候选时间窗表示“可以评估一次”，不表示“一定发送一次”。`frequency` 继续作为用户可见主动程度，旧配置无需迁移为另一套概念。

## 4. 受控契约

```ts
type ProactiveVerdict = 'allow' | 'defer' | 'silence'

type ProactiveDecisionCode =
  | 'eligible'
  | 'disabled'
  | 'paused'
  | 'muted_today'
  | 'quiet_hours'
  | 'daily_budget_exhausted'
  | 'cooldown'
  | 'recent_negative_feedback'
  | 'recent_user_activity'
  | 'active_session'
  | 'stage_prefers_quiet'
  | 'safety_caution'
  | 'insufficient_evidence'

interface ProactiveBudgetInput {
  now: Date
  frequency: 'gentle' | 'normal' | 'frequent'
  quietHours: { enabled: boolean; start: string; end: string }
  pausedUntil?: string
  activeStage: StageContext | null
  lastUserInteractionAt?: string
  activeListeningSession: boolean
  activeSceneSession: boolean
  fullscreenBlocked: boolean
  sentToday: number
  lastSentAt?: string
  recentInterventionOutcomes: ProactiveOutcomeSummary[]
}

interface ProactiveBudgetDecision {
  verdict: ProactiveVerdict
  code: ProactiveDecisionCode
  eligibleAt?: string
  budgetBefore: number
  budgetCost: 0 | 1
  policyVersion: 1
}
```

策略函数是纯函数，不访问数据库、不调用 LLM、不发送通知。时间解析、跨午夜安静时段和阈值均由代码处理。

## 5. 预算策略

### 5.1 基础预算

现有每日候选窗口保持 2/3/4 次，实际发送预算更克制：

| 主动程度 | 每日最多发送 | 两次发送最小间隔 | 候选评估窗口 |
| --- | ---: | ---: | ---: |
| `gentle` 克制 | 1 | 8 小时 | 2 |
| `normal` 适中 | 2 | 5 小时 | 3 |
| `frequent` 频繁 | 3 | 3 小时 | 4 |

候选窗口多于发送预算，目的是让策略选择合适时机，而不是填满配额。预算不跨天累积，也不因昨天少发而补发。

### 5.2 裁决顺序

规则按顺序短路，较早规则优先：

1. **用户硬控制**：关闭、暂停、当日静音直接 `silence`。
2. **安全与系统边界**：`safety=caution`、全屏阻止、活跃连续回声或场景执行中直接 `silence`。
3. **安静时段**：若安静时段结束仍在当前候选窗口允许范围内则 `defer`，否则 `silence`。
4. **近期用户活动**：用户 20 分钟内刚主动交互，延后到满 20 分钟；超过窗口则 `silence`。
5. **阶段偏好**：有效阶段明确 `interactionPreference=quiet` 时 `silence`；专注阶段至少增加 2 小时冷却。
6. **近期负反馈**：按 5.3 收敛。
7. **每日预算与最小间隔**：耗尽则 `silence`，间隔不足且仍可重试则 `defer`。
8. **证据 readiness**：没有可安全使用的阶段、近期对话或稳定音乐证据时 `silence`。
9. 其余情况 `allow`。

`defer` 每个计划最多一次，且不能跨入下一天或安静时段。到达 `eligibleAt` 后重新运行完整策略，不能沿用旧裁决。

### 5.3 负反馈收敛

主动分寸只消费 `origin=care` 的消息级结果：

| 结果 | 主动分寸含义 | 策略影响 |
| --- | --- | --- |
| `opened` | 用户主动点开 | 中性偏正，不提高当日上限 |
| `ignored` | 展示 4 小时仍无回应 | 弱负向，下一次冷却 +2 小时 |
| `dismissed` | 用户明确收起或选择免打扰 | 强负向，至少暂停至次日 |
| `system_failure` | 通知系统或生成失败 | 无用户含义，不降频 |

确定性收敛规则：

- 最近 3 次中有 2 次 `ignored`：当天剩余预算最多 1 次。
- 最近 3 次全部 `ignored`：暂停主动 72 小时。
- 任一次 `dismissed` 或“今天别提醒”：暂停至次日 08:00。
- 用户显式设置暂停 7 天或关闭：不得被行为分数提前解除。
- `care` 推荐歌曲的 `quick_skip/explicit_miss` 影响选歌，不计为讨厌通知；`opened/ignored/dismissed` 不进入音乐画像。

### 5.4 忽略结果的形成

通知成功展示后建立 4 小时观察窗口。到期时若同一主动行动没有 `opened` 或 `dismissed`，写入唯一结果：

```text
source_event_key = care_ignored:{carePingId}
outcome_type = ignored
polarity = negative
strength = weak
```

系统关闭通知、应用退出或通知对象自然释放不能立即推断为 `ignored`。重启后的 reconciliation job 只根据持久化记录和观察截止时间补写，依赖唯一键保证幂等。

## 6. 设置与用户控制

保留现有字段并扩展：

```ts
interface CarePingSettings {
  enabled: boolean
  frequency: 'gentle' | 'normal' | 'frequent'
  detectFullscreen: boolean
  quietHours: {
    enabled: boolean
    start: string // HH:mm，默认 22:30
    end: string   // HH:mm，默认 08:30
  }
  pausedUntil?: string
}
```

用户控制：

- 开关：无限期关闭主动关心。
- 主动程度：克制、适中、频繁；文案说明改为程度，不承诺每天一定发送几条。
- 安静时段：开关、开始时间、结束时间，支持跨午夜。
- 暂停：今天、7 天、恢复；`pausedUntil` 到期由读取逻辑自动失效。
- 通知快捷操作：“今天别提醒”写 `dismissed` 并暂停至次日，而不只写一条临时 mute。

renderer 只提交设置和控制动作。暂停截止时间、次日 08:00 计算、策略裁决和结果写入均在主进程。

## 7. 持久化与现有表扩展

不新增重复的预算账本。预算事实来自 Phase 1 的 `agent_actions` 与 `agent_action_outcomes`：

- `allow` 后发送的通知使用 `origin=care, action_type=reply`；
- `defer/silence` 使用 `origin=care, action_type=stay_silent`；
- `decision_json` 保存 `verdict`、`code`、`budgetBefore`、`budgetCost`、`policyVersion` 和可选 `eligibleAt`；
- 不保存上下文摘要、Prompt 或模型原始响应。

为现有 `care_ping_schedule` 增加：

```sql
ALTER TABLE care_ping_schedule ADD COLUMN eligible_after TEXT;
ALTER TABLE care_ping_schedule ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE care_ping_schedule ADD COLUMN decision_code TEXT;
```

`eligible_after` 只负责 scheduler 重试，不作为预算真相。每日发送数以成功展示的 care action 为准；失败 action 不消耗预算。

`care_pings` 增加观察字段：

```sql
ALTER TABLE care_pings ADD COLUMN shown_at TEXT;
ALTER TABLE care_pings ADD COLUMN observation_due_at TEXT;
ALTER TABLE care_pings ADD COLUMN dismissed_at TEXT;
```

历史通知不回填 `ignored`。只有 Phase 2 发布后具备 `shown_at` 和 `observation_due_at` 的记录参与收敛。

## 8. 执行链路

### 8.1 定时计划

```text
watchdog / cron 到点
  -> buildProactiveBudgetInput()
  -> decideProactiveBudget()
  -> silence: 记录 stay_silent，计划终止为 skipped
  -> defer:   记录 stay_silent，更新 eligible_after，计划保持 planned
  -> allow:   进入内容选择与通知执行
```

`allow` 不是预算预扣。只有 Notification `show` 成功、care action 进入 `succeeded` 后，该行动才进入当日发送计数。

### 8.2 内容选择

第一版保持现有 `recommend_track | casual_check | voice_invite` 三种能力，但由受控输入缩小选择范围：

- 阶段偏好为 `music` 时可选 `recommend_track`；
- 有效阶段目标为陪伴且近期有对话时可选 `casual_check`；
- 用户近期实际使用过连续回声且没有关闭信号时才可选 `voice_invite`；
- 无满足条件的类型时转为 `stay_silent`，不能为了完成 allow 强写一条通知。

LLM 可以在允许类型中建议一种并写正文，代码校验类型、事实来源和文案边界。模型失败沿用事实安全兜底；候选音乐失败可降为 `casual_check`，通知系统失败记录 `system_failure`。

### 8.3 点击与后续动作

- 点击先幂等写 `opened`，再导航或播放。
- “今天别提醒”写 `dismissed`，随后设置暂停；两步在同一数据库事务内完成。
- 推荐曲播放继续使用 Phase 1 的原 action/item 归因。
- 点击成功但播放失败同时保留 `opened` 与 `system_failure`，不产生用户负向音乐证据。

## 9. 可解释性与隐私

设置页的最近行动调试区增加主动裁决摘要：

- 结果：已发送 / 延后 / 保持安静；
- 原因：安静时段、刚刚互动、今日次数已够等用户可理解文字；
- 下一次可评估时间（仅 `defer`）；
- 已发生结果：点开、未回应、已暂停、执行失败。

不展示内部评分、Prompt、完整对话或上下文摘要。用户删除阶段上下文后，主动 action 仍只保留受控原因和执行事实。

## 10. 启动恢复与并发

- 启动时先完成 Phase 1 action recovery，再 reconcile 到期的 care outcome，最后恢复今日计划。
- `executeCarePingPlan` 继续使用进程内 plan id 锁；数据库通过计划状态条件更新防止 watchdog 与 cron 双发。
- `defer` 更新要求 `status=planned AND defer_count=0`，失败后重新读取，不重复创建沉默 action。
- 同一 care ping 的 `opened/dismissed/ignored` 使用唯一 `source_event_key`；`opened` 或 `dismissed` 已存在时禁止补 `ignored`。
- 系统时间大幅回拨时不补发已完成计划；跨日计划直接结束。

## 11. 交付拆分

### P2.1 纯策略与设置契约

- `domain/proactiveBudget/contracts.ts` 与 `policy.ts`；
- quiet hours、暂停和兼容设置迁移；
- 纯策略表驱动测试。

完成标准：相同输入始终得到相同 verdict/code，跨午夜和负反馈规则通过。

### P2.2 Scheduler 门控与延后

- 在 `runCarePingSlot` 前接入预算；
- `care_ping_schedule` 延后字段和 watchdog 重试；
- allow/defer/silence 都写 Agent Action；
- 双触发与重启幂等测试。

完成标准：候选窗口不再等于发送次数，预算耗尽后不调用 LLM。

### P2.3 主动结果与自动收敛

- shown/opened/dismissed/ignored 完整结果；
- 启动与定时 reconciliation；
- 负反馈只影响主动预算，歌曲反馈只影响音乐选择。

完成标准：近期忽略和明确暂停会按规则降频，系统失败不降频。

### P2.4 用户控制与回归

- 设置页主动程度、安静时段和暂停控制；
- 最近主动裁决解释；
- 全量测试、构建、Electron ABI 与安装包烟测。

完成标准：用户能解释、限制、暂停和恢复主动行为，现有聊天、回声、场景、播放、风信和画像不回归。

## 12. 验收标准

1. 关闭或暂停主动关心后，scheduler 不调用 LLM、不发送通知，并记录可解释的沉默原因。
2. 处于跨午夜安静时段时不发送；可在合法窗口内延后一次，不能越界补发。
3. `gentle/normal/frequent` 每日成功发送分别不超过 1/2/3 次，失败不占预算。
4. 两次发送满足 8/5/3 小时最小间隔，刚与用户互动时不会立刻发通知。
5. 最近连续忽略后自动降频或暂停；点开不会被当成喜欢歌曲。
6. 明确免打扰立即写 `dismissed` 并暂停至次日；系统关闭通知不立即推断用户拒绝。
7. 主动推荐曲的播放、跳过和收藏仍归因到原 care action；播放失败不降低音乐偏好。
8. 预算拒绝时不生成通知文案，`stay_silent` 不产生占位消息。
9. cron、watchdog 和重启恢复不会对同一计划重复发送或重复记结果。
10. 用户能在设置中查看当前程度、安静时段、暂停状态和最近裁决原因。

## 13. 观测指标

全部指标由本地受控事实计算，不新增外部遥测：

- 候选评估数、allow/defer/silence 比例；
- 成功展示率和系统失败率；
- 打开率、4 小时忽略率、明确暂停率；
- 介入后悔度：`(ignored + dismissed) / shown`，其中 dismissed 权重更高；
- 主动推荐后的有效收听、听完、收藏和快速跳过；
- 因安静时段、活跃会话、预算和负反馈而沉默的分布。

这些指标用于调试阈值，不能直接驱动单次人格表达，也不能为了提高打开率自动增加上限。

## 14. 主要风险

### 把系统行为误判为用户拒绝

通知自然关闭不等于用户拒绝。控制：只在持久化观察窗口结束后写弱 `ignored`，明确操作才写 `dismissed`。

### 候选窗口与发送预算混淆

现有 UI 写“每天 2/3/4 条”会制造承诺。控制：改为主动程度说明，实际发送上限独立且更低。

### 多维反馈相互污染

用户可能喜欢歌但不喜欢被打扰，或点开通知但不喜欢歌。控制：消息级 outcome 只进主动预算，track item outcome 只进音乐偏好。

### 延后造成突兀补发

控制：每计划只延后一次，重新裁决，不能跨日、跨安静时段或超过候选窗口。

### 规则过多难以解释

控制：固定短路顺序、单一主原因码、完整策略单测；LLM 不参与预算裁决。
