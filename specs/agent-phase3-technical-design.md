# Echo Agent Phase 3 技术设计

状态：Proposed
目标版本：Agent Kernel Phase 3
范围：关系修复与长期评估
前置条件：Phase 1 情境与行动闭环、Phase 2 受控主动性通过验收
依据：`agent-product-next-stage.md`、`agent-phase1-technical-design.md` 与 `agent-phase2-technical-design.md`

## 1. 决策摘要

Phase 3 不让 Echo 自由揣测“关系好不好”，只建立可证明的有限闭环：

```text
明确纠正 / 可归因的连续偏差
  -> 关系信号提议
  -> 代码校验证据与安全边界
  -> 有限修复动作
  -> 观察真实结果
  -> 更新当前策略或长期证据候选
```

核心选择：

- LLM 只识别信号、影响维度和修复建议；代码决定是否立案、动作边界和持久化。
- 关系修复复用 Phase 1 的 Agent Action，新增“关系事件”而不重建执行系统。
- 显式纠正立即影响后续入口；隐式反应只先成为候选证据。
- “不想聊”优先尊重当前边界，不用长道歉继续占用注意力。
- 音乐跑偏、语气不适和主动打扰分属不同维度，禁止互相污染。

## 2. 目标与非目标

### 2.1 目标

- 识别语气/调侃被拒绝、状态判断失准、明确不想聊和连续推荐跑偏。
- 从承认偏差、单点澄清、降低介入、重新选歌和安静播放中选择有限动作。
- 记录修复是否执行，以及用户是否明确接受、拒绝或未表态。
- 陪伴风格只在明确表达或多次独立证据后更新，并可纠正和重置。
- 建立本地质量指标和回归样本集。

### 2.2 非目标

- 不评分亲密度或信任度，不向用户宣称关系状态。
- 不根据单次跳歌、页面关闭或通知忽略推断用户讨厌 Echo。
- 不让 LLM 直接修改长期画像、暂停时间或事件状态。
- 不引入开放式 Planner、多 Agent 讨论或云端训练。

## 3. 现有基线与缺口

已有基础：`CompanionProfile` 五维偏好、`CompanionResponseStrategy`、高风险禁止调侃、明确风格偏好提取，以及 Phase 1/2 的行动、结果和主动分寸。

当前缺口：

- `companion_signal_events` 没有与上一次 Agent Action 强归因，也没有幂等键和撤回状态。
- 聊天回复的 conversation meta 没有保存对应 `agentActionId`，无法稳定证明用户在评价哪一次行动。
- 隐式反应可立即改变长期画像，不满足“重复证据或明确表达”门槛。
- 系统不能记录哪里错了、怎样修复、后来是否改善。
- 推荐跑偏、互动边界和表达偏好没有统一的证据边界。

## 4. 受控契约

```ts
type RelationshipIncidentKind =
  | 'tone_rejected'
  | 'state_miscalibrated'
  | 'interaction_rejected'
  | 'recommendation_drift'

type RelationshipIncidentStatus =
  | 'open'
  | 'repairing'
  | 'repaired'
  | 'unresolved'
  | 'superseded'

type RepairMove =
  | 'acknowledge'
  | 'acknowledge_and_clarify'
  | 'lower_intensity'
  | 'retry_music'
  | 'quiet_play'
  | 'stay_silent'

interface RelationshipSignalProposal {
  operation: 'none' | 'open' | 'resolve'
  kind?: RelationshipIncidentKind
  severity?: 'low' | 'medium' | 'high'
  affectedDimension?:
    | 'warmth'
    | 'playfulness'
    | 'directness'
    | 'initiative'
    | 'verbosity'
    | 'music_fit'
    | 'state_reading'
  evidenceConversationIds: number[]
  evidenceQuotes: string[]
  confidence: number
  suggestedMove?: RepairMove
}

interface RelationshipRepairDecision {
  shouldOpen: boolean
  incidentKind?: RelationshipIncidentKind
  move: RepairMove
  reasonCode: string
  blocksTeasing: boolean
  suppressesProactiveUntil?: string
  policyVersion: 1
}
```

LLM 只能引用本轮提供的 conversation id 和原文子串。代码验证枚举、引用、置信度和上一次 action 归因；校验失败时降为 `none`。

现有 Agent Action 契约扩展：

```ts
type AgentActionReason = ExistingAgentActionReason | 'relationship_repair'
type AgentActionOutcomeType = ExistingAgentActionOutcomeType | 'repair_accepted' | 'repair_rejected'
```

`repair_accepted/rejected` 只由用户对已归因修复 action 的明确表达产生。继续聊天、继续听歌或没有回复不等于接受。

## 5. 证据与裁决

### 5.1 可立案信号

| 信号 | 证据门槛 | 影响范围 |
| --- | --- | --- |
| 语气/调侃拒绝 | 用户明确否定上一条回复 | 立即禁止同类语气，候选长期偏好 |
| 状态判断失准 | 用户明确纠正当前状态 | 立即修正或结束阶段情境 |
| 不想聊或嫌打扰 | 用户明确要求少说、停止或安静 | 当前阶段降介入，同步主动预算 |
| 连续推荐跑偏 | 一次 `explicit_miss` 或同阶段近 3 次中 2 次 `quick_skip` | 只调整当前选歌策略 |

单次快速跳歌、应用关闭、普通短回复、通知 `ignored` 和系统失败不可单独立案。

### 5.2 确定性优先级

1. 安全风险：禁止调侃，走现有安全链路。
2. 明确要求停止：`stay_silent` 或 `quiet_play`，不输出道歉长文。
3. 明确纠正：先应用新边界，再用一句承认偏差。
4. 高影响歧义：只确认一个会改变行动的关键点。
5. 连续音乐跑偏：先改变候选约束，不上升为人格冲突。

自然语言控制由代码归一：

| 用户边界 | 确定性结果 |
| --- | --- |
| “今天别提醒” | 主动关心暂停至次日 08:00 |
| “这周别提醒” | 主动关心暂停 7 天 |
| “以后别主动提醒” | 关闭主动关心，只能由用户恢复 |
| “别说了，放歌就好” | 当前 session 切换 `silent_play`，不扩大为永久禁言 |
| “停下/别放了” | 停止当前播放或 session |

独立的风格偏好（如“以后可以损我”）直接进入明确 companion signal，不建立 incident。只有对 Echo 已发生行为的否定或可归因的连续偏差才立案。

### 5.3 修复文案边界

- 最多一句承认偏差，之后立即执行修正动作。
- 不辩解、不索要原谅、不自我贬低，不说“我已学习/更新画像”。
- 不重复敏感原话，不向风信或主动通知泄露关系事件。
- 同一事件最多一次口头修复；继续拒绝时降低介入。

## 6. 持久化与状态

```sql
CREATE TABLE relationship_incidents (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  affected_dimension TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_action_id TEXT REFERENCES agent_actions(id) ON DELETE SET NULL,
  repair_action_id TEXT REFERENCES agent_actions(id) ON DELETE SET NULL,
  policy_version INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_relationship_incident_source
  ON relationship_incidents(user_id, kind, source_conversation_id)
  WHERE source_conversation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_relationship_incident_active_dimension
  ON relationship_incidents(user_id, affected_dimension)
  WHERE status IN ('open', 'repairing');
```

事件与用户、conversation 和 action 的外键都使用现有 SQLite foreign key 机制。同一维度的新事件需在同一事务中先将旧事件置为 `superseded`，再插入新事件。

```text
open -> repairing -> repaired
                  -> unresolved
open ------------> superseded
```

- 修复 action 执行成功不等于关系已修复；只有可归因的明确接受才进入 `repaired`。
- `repair_accepted` 将事件置为 `repaired`；`repair_rejected` 将当前事件置为 `unresolved`，并由新的明确纠正决定是否建立后续事件。
- 无后续证据保持 `unresolved`，不自动推断用户已经原谅。
- 新的明确纠正可覆盖旧边界，旧事件进入 `superseded`。
- 事件不保存完整对话、Prompt 或模型解释；删除来源后只保留受控类型和执行事实。

`companion_signal_events` 增加可空的 `source_conversation_id`、`source_action_id`、`source_event_key`、`strength`、`retracted_at` 和用户范围幂等键。新信号的原文由 conversation 所有，现有 `evidence` 列留空字符串，不再复制用户原话。历史记录不伪造来源。

### 6.1 长期风格门槛

- 明确风格偏好立即更新对应维度，并保留可撤回证据。
- 隐式正/负反应在 30 天内至少 2 次独立证据才更新画像。
- 两次证据不得来自同一 conversation、action 或重试链。
- 冲突的隐式证据保持候选；较新的明确纠正优先。
- `music_fit` 只进音乐偏好，`initiative` 只进主动分寸。
- 重置某个相处维度时，在同一事务内硬删除该维度信号并从其余证据重算；不用 `retracted_at` 伪装删除。

## 7. 跨入口接入

### 7.1 絮语

- 第一阶段意图同轮输出可选 relationship proposal，不增加第二次 LLM 调用。
- `appendAssistantReply` 将本次 `agentActionId` 写入 assistant conversation meta；下一轮只允许把用户评价归因给该 conversation 对应的 action。历史无 id 消息只能作显式偏好证据，不伪造 action 归因。
- 先应用阶段情境纠正和关系边界，再生成本轮回复。
- 修复复用 `reply/clarify/adjust_music/silent_play/stay_silent`，通过 `decision_json.repairIncidentId` 归因。
- `AssistantReplyOptions` 增加仅主进程可写的 `actionType` 和 `reasonCode`；默认仍为现有 `reply/user_request`，只有修复服务可写 `relationship_repair`。

执行顺序为：幂等创建 incident -> 创建 repair action 并回写 `repair_action_id` -> 生成与交付内容 -> 更新 action 执行状态 -> 等待后续显式结果。前两步在一个 SQLite 事务中完成。

### 7.2 连续回声与场景

- 每段决策读取未解决事件的受控摘要，只影响语气、说话密度和选歌约束。
- “别说了”在当前 session 立即切为 `silent_play`；“停止”结束 session。
- 被动收听、运行时长和没有跳歌不形成关系修复结果。

### 7.3 主动关心

- `ignored/dismissed` 继续只影响 Phase 2 预算，不自动建立关系事件。
- 未解决的 `interaction_rejected` 使主动预算确定性输出 `silence`，直到到期或用户明确恢复。

### 7.4 风信与个人中心

- 风信不叙述冲突或内部修复状态。
- 个人中心的“相处方式”只展示证据足够的维度，允许按维度纠正或重置。
- 调试视图只展示事件类型、修复动作和状态。

新增主进程 API：

```ts
getCompanionRelationshipView(): CompanionRelationshipView
correctCompanionPreference(input: ExplicitCompanionCorrection): CompanionProfile
resetCompanionPreference(dimension: CompanionPreferenceDimension): CompanionProfile
listRecentRelationshipIncidents(limit: number): RelationshipIncidentSummary[]
```

renderer 只展示和提交用户意图，证据重算、删除和事件状态由主进程完成。

## 8. 失败、恢复与并发

- 事件写入失败时可给出安全的当轮回复，但不声称已记住。
- 修复 action 执行失败记 `system_failure`，事件保持 `open`，不记用户拒绝。
- 同一 source conversation 依赖唯一索引收敛；同一事件只有一个主修复 action。
- 重启时恢复 `open/repairing` 事件，中断 action 按 Phase 1 结算，不自动重发道歉。
- 事件 30 天无新证据转 `unresolved`，明确设置的长期边界不过期。

## 9. 长期评估

| 维度 | 本地指标 |
| --- | --- |
| 修复有效性 | 修复接受率、未解决率、同维度 7/30 天再犯率 |
| 表达分寸 | 语气纠正率、调侃被拒绝率、重复道歉率 |
| 音乐贴合 | 同阶段推荐跑偏率、重选后有效收听改善 |
| 边界尊重 | 明确停止后误介入率、纠正跨入口命中率 |
| 长期证据 | 无来源更新数、单次隐式证据误升级数 |

回归样本集放在测试源码或 fixtures 中，不进安装包。覆盖调侃拒绝/允许、高风险禁止调侃、不想聊、状态纠正、连续选歌跑偏和系统失败。LLM 测试验证结构、证据和动作边界，不逐字断言文案。

## 10. 实施顺序

### P3.1 事件契约与证据仓库

- 新增 relationship incident 契约、纯策略和持久化。
- 扩展 companion signal 来源、幂等、撤回和聚合门槛。

完成标准：明确纠正可幂等立案，单次隐式反应不能改长期画像。

### P3.2 絮语修复闭环

- 意图阶段同轮输出 relationship proposal。
- 确定性裁决 repair move，关联 action 并记录结果。
- 实现一句承认偏差、单点澄清、降介入和安静播放。

完成标准：上一条语气被否定后，本轮正确修复，下一轮不再重复偏差。

### P3.3 跨入口边界与用户控制

- 连续回声、场景和主动关心消费有效边界。
- 个人中心支持查看、纠正和按维度重置。
- 删除对话、阶段和关系证据时保持隐私语义一致。

完成标准：明确边界在所有入口的下一次决策生效，并可撤回。

### P3.4 评估与产品验证

- 实现本地指标聚合与开发诊断摘要。
- 建立关系策略回归样本集和跨服务契约测试。
- 完成全量回归、数据库升级、打包与手工闭环验收。

完成标准：第 11 节验收全部通过，且无 P0/P1 回归。

## 11. 验收标准

1. 用户说“别这么调侃我”后，当轮简短承认偏差，后续絮语、回声和场景不再调侃。
2. 用户明确恢复或更改风格后，新边界覆盖旧证据。
3. 用户说“别说了，放歌就好”时，Echo 直接进入安静播放。
4. 状态被纠正后，阶段情境和各入口下一次决策同步更新。
5. 连续推荐跑偏只调整选歌，不降低温暖度或自动关闭主动关心。
6. 单次跳歌、页面关闭、通知忽略和系统失败不形成长期关系结论。
7. 修复回复交付成功不会自动标记 `repaired`。
8. 同一纠正重试不重复立案、更新画像或道歉。
9. 用户重置某个相处维度后，其证据被撤回，其他维度不受影响。
10. 回归样本能量化修复、再犯、边界违反和证据误升级，不逐字锁定文案。

## 12. 主要风险与控制

- 把普通沉默当关系受损：只接受明确表达或可归因的受控行为。
- 道歉变成打扰：同事件最多一次口头承认，停止要求优先。
- 一次反应永久改变 Echo：隐式信号要求至少两次独立证据。
- 音乐偏差污染关系画像：音乐、主动分寸、语气和状态理解各自归因。
- LLM 绕过边界：代码校验原文证据、上一 action、安全等级和允许的 repair move。

## 13. 已锁定决策

1. 复用现有 CompanionProfile，不新建第二份关系画像。
2. 关系事件记录偏差与修复状态，Agent Action 记录实际执行。
3. 显式纠正立即生效，隐式证据至少两次独立命中才更新长期风格。
4. 修复动作限定在现有行动空间，不增加自由文本 Planner。
5. 修复输出成功不等于用户接受，没有证据时保持未知。
6. 通知忽略、单次跳歌和系统失败不用于推断关系受损。
7. 回归数据不打包；生产 Prompt 继续在程序源码中组装，不运行时读取外部 Markdown。
