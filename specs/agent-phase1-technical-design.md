# Echo Agent Phase 1 技术设计

状态：Implemented，回归验证通过
目标版本：Agent Kernel Phase 1  
范围：连续阶段上下文、行动结果闭环  
依据：`agent-product-next-stage.md` 与 `main@2725fa2`，后续闭环修复见当前分支

## 1. 背景

Echo 已经具备絮语、连续回声、场景、播放、主动关心、风信和个人画像等能力，但这些入口目前主要各自理解用户、各自执行。系统可以记住一些事实，却还不能稳定回答两个核心问题：

1. 用户此刻处于什么阶段，Echo 正在陪他完成什么？
2. Echo 刚才采取了什么行动，行动是否真的执行，用户随后如何回应？

Phase 1 不增加新的产品入口，而是在现有入口之下建立统一的 Agent 内核最小闭环：

```text
用户表达 / 行为
      |
      v
阶段上下文提议 --(确定性策略)--> 当前阶段上下文
      |                              |
      +------------------------------+
                                     v
                              行动决策与执行
                                     |
                                     v
                              行动结果与归因
                                     |
                       +-------------+-------------+
                       v                           v
                 当前阶段调整                 长期证据候选
```

## 2. 目标与成功标准

### 2.1 目标

- 絮语、连续回声、场景、播放和主动关心读取同一个有效阶段上下文。
- 用户明确开始、改变、结束或纠正一个阶段时，系统能正确更新上下文。
- 每一次 Echo 行动都有可追踪的发起入口、原因、目标、执行状态和结果。
- 播放失败、用户关闭页面、主动跳过、完整听完、收藏等行为不会被混为同一种反馈。
- Echo 自己推送并播放的内容不会仅凭“没有被跳过”直接升级为长期偏好。
- 应用重启后可以恢复仍然有效的阶段上下文，并能修复中断的行动状态。

### 2.2 验收标准

1. 用户在絮语说“今晚要加班”，随后进入连续回声，后者能读取“工作 / 专注”上下文，不需要用户重复说明。
2. 用户说“缓过来了”或“别再把我当成很累”，旧上下文立即结束或被纠正，后续入口不再沿用。
3. 同一首歌由两个不同推荐行动产生时，播放结果能分别归因，不会串到前一次行动。
4. 可播放地址获取失败只记录系统失败，不写入用户负向偏好。
5. 快速跳过、有效收听、完整听完、收藏和明确“不合适”按不同证据强度进入结果层。
6. 重复上报同一个播放结果不会重复计数。
7. 用户删除一个阶段上下文时，其上下文和证据被删除；行动记录仅保留不含上下文内容的执行事实。
8. 现有场景旅程、连续回声、播放队列、风信和画像功能的回归测试保持通过。

## 3. 非目标

以下能力不在 Phase 1 实现：

- 完整的主动陪伴预算、打扰频率学习和跨天触达策略，这是 Phase 2。
- 关系受损识别、道歉与长期修复策略，这是 Phase 3。
- 云端同步、多用户账号和跨设备上下文。
- 用自由文本 Agent Planner 替代现有推荐、场景旅程和陪伴策略。
- 将全部历史 `events` 自动回填为阶段上下文。旧数据歧义较大，不做高风险推断。

## 4. 设计原则

### 4.1 分层而不混用

| 现有对象 | 保留职责 | Phase 1 关系 |
| --- | --- | --- |
| `events` | 事实、短期信号、用户纠正 | 作为旧证据来源，不再承担主上下文 |
| `scene_sessions` | 一次场景执行会话 | 可关联阶段上下文 |
| `listening_sessions` | 一次连续回声会话 | 可关联阶段上下文 |
| `runtime_tasks` | 进程内进度、取消、错误 | 可被行动记录引用，但不持久化产品语义 |
| `track_feedback` | 按歌曲聚合的兼容画像信号 | 由新结果层继续同步维护 |
| `track_feedback_events` | 明确的歌曲反馈事实 | 补充关联行动，继续兼容旧查询 |
| `stage_contexts` | 用户当前阶段及陪伴目标 | Phase 1 新增 |
| `agent_actions` | Echo 为什么做、做了什么、是否执行 | Phase 1 新增 |
| `agent_action_outcomes` | 用户或系统对行动的实际结果 | Phase 1 新增 |

### 4.2 模型判断，代码裁决

LLM 只负责从自然语言中提出结构化判断：上下文是否变化、变化方向、置信度和证据。代码负责：

- 枚举校验和缺省值；
- 上下文合并、互斥、过期和版本推进；
- 行动状态迁移；
- 播放阈值、结果强度、去重和归因；
- 重试、恢复、删除和兼容写入。

模型不能直接写数据库状态、生成主键、指定绝对过期时间或决定重试。

### 4.3 当前状态不等于长期人格

“今天累”“正在加班”属于阶段上下文；“偏爱夜间低人声音乐”才可能进入长期画像。阶段事实只有在用户明确确认，或出现可重复、可归因的行为证据后，才成为长期证据候选。

### 4.4 沉默也是行动

`stay_silent` 是正式行动。它必须有原因并可审计，但不能生成占位文案，也不能伪造用户互动结果。

## 5. 总体架构

新增两个领域服务，不改变现有入口的 UI 所有权：

```text
Renderer / IPC
      |
      +--> chat pipeline --------+
      +--> listening service ----+----> StageContextService
      +--> scene service --------+          |
      +--> care service ---------+          v
      |                               stage_contexts
      |
      +--> recommendation / scene journey / playback
                                      |
                                      v
                               AgentActionService
                                      |
                           +----------+----------+
                           v                     v
                     agent_actions       action_outcomes
                           |                     |
                           +----------+----------+
                                      v
                          legacy feedback / memory policy
```

建议新增模块：

```text
src/main/domain/stageContext/contracts.ts
src/main/domain/stageContext/policy.ts
src/main/domain/stageContext/repository.ts
src/main/domain/stageContext/service.ts
src/main/domain/agentAction/contracts.ts
src/main/domain/agentAction/repository.ts
src/main/domain/agentAction/service.ts
src/main/domain/agentAction/outcomePolicy.ts
```

`domain` 层不依赖 Electron `WebContents`、页面状态或具体 LLM SDK。入口服务负责把用户表达和执行结果传入领域层。

## 6. 阶段上下文设计

### 6.1 受控契约

```ts
type StageContextKind =
  | 'work'
  | 'rest'
  | 'commute'
  | 'sleep'
  | 'exercise'
  | 'emotional_support'
  | 'other'

type StageContextGoal =
  | 'focus'
  | 'recover'
  | 'settle'
  | 'energize'
  | 'companionship'
  | 'sleep'
  | 'none'

type StageContextStatus = 'active' | 'paused' | 'ended' | 'expired'

interface StageState {
  emotion: 'neutral' | 'tired' | 'irritated' | 'low' | 'anxious' | 'calm' | 'positive' | 'unknown'
  energy: 'low' | 'medium' | 'high' | 'unknown'
  interactionPreference: 'talk' | 'music' | 'quiet' | 'unknown'
  safety: 'normal' | 'caution'
}

interface StageContext {
  id: string
  kind: StageContextKind
  status: StageContextStatus
  summary: string
  state: StageState
  goal: StageContextGoal
  confidence: number
  revision: number
  startedAt: string
  lastActiveAt: string
  expiresAt: string
  endedAt?: string
  endReason?: StageContextEndReason
}
```

`summary` 是给决策与生成使用的短摘要，最多 120 字，不存完整对话。高风险判断和处置仍走现有安全链路；Phase 1 的上下文只能标记 `normal/caution`，禁止持久化诊断结论。

### 6.2 LLM 提议契约

聊天意图路由扩展一个可选字段，避免为同一句话再调用一次模型：

```ts
interface StageContextProposal {
  operation: 'none' | 'create' | 'update' | 'end'
  kind?: StageContextKind
  summary?: string
  statePatch?: Partial<StageState>
  goal?: StageContextGoal
  confidence: number
  ttlClass?: 'short' | 'day' | 'multi_day'
  evidenceConversationIds: number[]
}
```

模型只能引用本次提供的 conversation id。解析失败、枚举非法或置信度不足时降为 `none`，不能由正则猜出一个新上下文。明确结束和纠正仍由模型分类，代码使用原始文本中的否定证据做一致性保护，防止模型把“不累了”更新成“累”。

### 6.3 生命周期策略

- 每个用户同一时刻最多一个 `active` 主上下文。
- 相同或兼容阶段采用 `update`，推进 `revision` 并刷新 `last_active_at`。
- 明确的新互斥阶段先结束旧上下文，再创建新上下文；两步在同一事务内完成。
- `paused` 仅为后续扩展保留，Phase 1 不自动创建，也不参与决策。
- 读取时发现过期，先原子更新为 `expired`，再返回无上下文。
- 显式结束、显式纠正优先于历史置信度；同级证据按时间较新者优先。
- 用户只表达情绪但没有可执行阶段时，可以创建 `emotional_support`；普通闲聊不创建上下文。

固定 TTL 由代码映射并设上限：

| `ttlClass` | 默认时长 | 最大时长 | 适用示例 |
| --- | ---: | ---: | --- |
| `short` | 3 小时 | 6 小时 | 通勤、运动、短暂烦躁 |
| `day` | 8 小时 | 16 小时 | 工作、休息、当日疲惫 |
| `multi_day` | 48 小时 | 7 天 | 明确说“这几天赶项目” |

场景默认值可以更短，但不能超过对应 `ttlClass` 上限。模型不提供 `ttlClass` 时，代码按 `kind` 选择默认值。

### 6.4 数据表

```sql
CREATE TABLE stage_contexts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  state_json TEXT NOT NULL,
  goal TEXT NOT NULL,
  confidence REAL NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_stage_context_one_active
  ON stage_contexts(user_id)
  WHERE status = 'active';

CREATE TABLE stage_context_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL REFERENCES stage_contexts(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  strength TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retracted_at TEXT,
  UNIQUE(context_id, source_type, source_id, fact)
);
```

`source_type` 受控为 `conversation | event | scene_session | listening_session | user_correction | system`。`strength` 受控为 `proposed | executed | engaged | accepted | explicit`，与产品路线中的证据阶梯一致。

### 6.5 旧 `events` 兼容

- 新上下文写入只走 `StageContextService`。
- `loadActiveEvents()` 在迁移期将当前阶段上下文投影为一个 `ActiveEvent`，再与未过期的旧 `events.kind='context'` 合并去重。
- 旧 `event_started` / `event_ended` 不再作为聊天链路的主写入，但保留给旧调用方直到完成迁移。
- 不批量回填旧事件；旧记录按原 TTL 自然过期。
- `correction` 继续作为长期明确纠正证据，同时触发阶段上下文的结束或修正。

## 7. 行动与结果闭环

### 7.1 行动契约

```ts
type AgentActionType =
  | 'reply'
  | 'clarify'
  | 'play'
  | 'adjust_music'
  | 'speak_then_play'
  | 'silent_play'
  | 'stay_silent'
  | 'safety_guidance'

type AgentActionStatus = 'planned' | 'started' | 'succeeded' | 'failed' | 'canceled'

type AgentActionReason =
  | 'user_request'
  | 'context_focus'
  | 'context_recover'
  | 'context_settle'
  | 'context_energize'
  | 'context_companionship'
  | 'recommendation_followup'
  | 'explicit_correction'
  | 'proactive_check'
  | 'safety_risk'
  | 'low_intervention_value'
  | 'muted_or_blocked'

interface AgentActionItemPlan {
  itemType: 'message' | 'speech' | 'track'
  ordinal: number
  entityKey?: string
  payload: Record<string, unknown>
}

interface AgentActionPlan {
  origin: 'chat' | 'listening' | 'scene' | 'care' | 'playback'
  actionType: AgentActionType
  reasonCode: AgentActionReason
  goalCode: StageContextGoal
  stageContextId?: string
  stageContextRevision?: number
  runtimeTaskId?: string
  items: AgentActionItemPlan[]
}
```

行动的 `succeeded` 表示执行成功，例如音频已经开始播放或回复已经交付，不表示用户喜欢。用户反应单独记录为 outcome。

### 7.2 行动状态机

```text
planned -> started -> succeeded
                    -> failed
                    -> canceled
planned -----------> canceled
```

- 终态不可回退或覆盖。
- 恢复动作创建新的 action，并通过 `recovers_action_id` 指向原行动。
- `stay_silent` 可以从 `planned` 直接进入 `succeeded`，没有 item 和输出内容。
- 候选搜索不是行动；只有最终选中的歌曲才成为 action item。
- `speak_then_play` 是一个复合行动，speech 与 track 分别作为 item，允许局部失败。

### 7.3 数据表

```sql
CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  stage_context_id TEXT REFERENCES stage_contexts(id) ON DELETE SET NULL,
  stage_context_revision INTEGER,
  runtime_task_id TEXT,
  origin TEXT NOT NULL,
  action_type TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  goal_code TEXT NOT NULL,
  status TEXT NOT NULL,
  failure_kind TEXT,
  recovers_action_id TEXT REFERENCES agent_actions(id) ON DELETE SET NULL,
  decision_json TEXT NOT NULL DEFAULT '{}',
  planned_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_action_items (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  entity_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(action_id, item_type, ordinal)
);

CREATE TABLE agent_action_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  action_id TEXT NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
  action_item_id TEXT REFERENCES agent_action_items(id) ON DELETE CASCADE,
  source_event_key TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  polarity TEXT NOT NULL,
  strength TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(user_id, source_event_key)
);
```

`decision_json` 只保存受控决策元数据，例如策略版本、候选数量、静默原因，不保存完整 prompt、模型思维过程或重复的上下文摘要。

`stage_context_revision` 固化行动决策时使用的上下文版本。上下文后续更新不会改变旧行动的解释；用户删除上下文后只留下无语义的 revision 数字。

### 7.4 Track 归因字段

在现有 `Track` 增加可选字段，队列复制、场景附加和 `tracks_listened.meta_json` 必须原样保留：

```ts
interface Track {
  agentActionId?: string
  agentActionItemId?: string
  stageContextId?: string
  playbackInstanceId?: string
}
```

- `agentActionId` / `agentActionItemId` 表示这次入队由哪个行动负责。
- `playbackInstanceId` 在一次真实播放尝试开始前生成；同一歌曲再次播放必须生成新 id。
- 每个播放实例只有一个主行动归属。
- 用户从收藏或历史手动播放时，创建新的 `play` 行动，而不是沿用歌曲上一次的行动 id。

### 7.5 播放结果判定

播放启动事件与终局用户结果分开：

| 结果 | 判定 | 极性 | 强度 | 是否可进入长期证据 |
| --- | --- | --- | --- | --- |
| `playback_started` | 播放器确认开始 | system | weak | 否 |
| `quick_skip` | `< 30s` 且完成率 `< 0.30` | negative | weak | 重复后才可 |
| `effective_listen` | `>= 60s` 或完成率 `>= 0.30` | positive | weak | 可以，低权重 |
| `completed` | 完成率 `>= 0.80` | positive | medium | 可以 |
| `favorite` / `explicit_like` | 用户明确操作或表达 | positive | strong | 可以 |
| `explicit_miss` | 用户明确“不合适” | negative | strong | 可以 |
| `replay` | 同一曲目主动重新播放 | positive | strong | 可以 |
| `system_failure` | URL、网络、解码、服务失败 | system | weak | 否 |
| `user_stop` | 用户主动停止但非拒绝表达 | neutral | weak | 否 |
| `app_closed` | 页面或应用结束导致中断 | neutral | weak | 否 |

一次播放结束只产生一个终局收听结果；收藏、明确反馈和主动重播是独立用户行为，可以额外产生结果。消费侧对同一播放实例取最高强度，不能把 `effective_listen` 与 `completed` 重复累计。

`metadata_json` 额外记录受控的 `userAgency: passive | reactive | active`。Echo 自动续播通常是 `passive`，用户接受推荐后继续听是 `reactive`，主动点播、收藏和明确反馈是 `active`。画像消费时，同种结果以 active > reactive > passive 加权，单次 passive 结果不能独立形成长期结论。

现有 `track_feedback` 和记忆策略继续维护，但由 outcome 事务内派生：

- `completed` 映射到 `played`；
- `quick_skip` 映射到 `skipped`；
- `favorite`、`explicit_like`、`explicit_miss` 沿用现有明确反馈；
- `system_failure`、`user_stop`、`app_closed` 不写偏好。

### 7.6 幂等与一致性

`source_event_key` 由代码生成，例如：

```text
playback_started:{playbackInstanceId}
playback_final:{playbackInstanceId}
favorite:{favoriteMutationId}
explicit_feedback:{feedbackEventId}
```

结果写入与旧反馈聚合更新使用同一个 SQLite 事务。唯一索引冲突视为已处理，不再次更新聚合。

外部播放器与 SQLite 无法组成分布式事务，采用以下顺序：

1. 创建 `planned` action 与 item。
2. 获取并验证可播放地址。
3. 生成 `playbackInstanceId`，将 action/item 标记为 `started`。
4. 更新播放状态并触发 renderer 播放。
5. 收到播放器开始回执后写 `playback_started`，行动进入 `succeeded`。
6. 收到结束、切歌或停止回执后写唯一终局结果。

步骤 2 失败时行动记为 `failed/system_failure`，不产生负向用户结果。步骤 4 后数据库写入失败时，下一次播放器心跳使用同一个 `playbackInstanceId` 重试，依赖唯一键收敛。

现有 renderer 已通过 `onPlay -> playback:heartbeat`、`onEnded -> playback:finishCurrent` 和 `onError` 提供真实播放信号。P1.3 必须把 `playbackInstanceId` 加入 heartbeat、finishCurrent 和 error payload；主进程只接受与当前实例相同的回执。这样旧 `<audio>` 元素迟到的 ended/error 事件不会结算到刚切换的新歌曲。

## 8. 跨入口接入

### 8.1 絮语

```text
保存用户消息
  -> LLM 一次返回 ChatIntent + StageContextProposal
  -> StageContextPolicy 校验并落库
  -> 读取生效后的上下文进行回复/推荐决策
  -> 创建 AgentAction
  -> 执行回复、澄清或播放
  -> 更新执行状态
```

上下文必须在生成回复前生效，否则 Echo 会在同一轮里忽略用户刚刚表达的状态。`inferTasteSignal` 继续异步执行，但阶段上下文写入是主链路的一部分，失败时应显式记录健康状态，不能静默假装成功。

### 8.2 连续回声

- `listening_sessions` 增加可空 `stage_context_id`。
- 启动时绑定当前有效上下文；每个 segment 决策前重新读取当前 revision，避免长期会话使用过期快照。
- 每个 segment 产生 `speak_then_play`、`silent_play` 或 `stay_silent` 行动。
- “没有说话但继续播放”是 `silent_play`，不是 `stay_silent`。
- 用户在絮语结束阶段后，正在运行的连续回声下一段必须感知，不强行重启 session。

### 8.3 场景

- `scene_sessions` 增加可空 `stage_context_id`。
- 显式点击场景视为强证据，使用确定性映射创建或更新上下文：

| 场景 | 上下文 | 目标 |
| --- | --- | --- |
| 专注 | `work` | `focus` |
| 有点困 | 保留兼容当前阶段；无阶段时为 `work` | `energize` |
| 放松 | `rest` | `recover` |
| 烦躁 | `emotional_support` | `settle` |
| 随机 | 只绑定现有上下文，不创建新上下文 | 沿用 |

现有 `sceneJourney` 继续负责 transition / lift / hold / settle / explore / reset，不迁入 Agent 内核。

### 8.4 播放

- 播放服务是 outcome 的唯一自动事实源，聊天和场景服务不能根据“返回了 tracks”推断已播放。
- renderer 必须回传带 `playbackInstanceId` 的实际 `started`、进度、结束和错误事件。
- `ensurePlayable` 失败、解码失败和网络失败都标记系统失败，不触发 skip。
- 现有完成率阈值由 `outcomePolicy` 单点维护，`playback.ts` 不再散落判断。

### 8.5 主动关心

Phase 1 只做闭环基础：

- 读取有效阶段上下文；无有效上下文且无其他高质量证据时，选择 `stay_silent`。
- 推送、附带播放、点击和忽略分别写行动与结果。
- 仍沿用现有 schedule / mute 规则，不在本阶段引入新的主动预算模型。

### 8.6 风信与个人画像

- 风信可引用“发生过的行动与用户结果”，不能把模型提议或未执行推荐写成当天事实。
- 画像只消费符合证据门槛的 outcomes：明确反馈、收藏、重播优先；Echo 主动播放后的单次有效收听保持弱证据。
- 阶段上下文自身不直接写成人格结论。阶段重复模式要在后续聚合层形成证据后再进入画像。

## 9. 用户控制与隐私

新增主进程 API：

```ts
getActiveStageContext(): StageContext | null
endActiveStageContext(reason: 'user_ended'): StageContext | null
correctStageContext(input: StageContextCorrection): StageContext | null
deleteStageContext(id: string): void
listRecentAgentActions(limit: number): AgentActionSummary[]
```

- renderer 只展示和提交用户意图，不实现合并策略。
- 删除阶段上下文采用硬删除，级联删除 evidence；action 的 `stage_context_id` 置空。
- action 不复制上下文 summary，因此删除后不会在行动日志里残留该私密文本。
- prompt、模型原始响应和思维过程不入 action 表。
- 调试视图只显示受控字段、目标歌曲、状态和结果，不显示密钥或完整提示词。

## 10. 启动恢复与失败处理

应用启动时执行：

1. 将已过期的 active context 更新为 `expired`。
2. 检查非终态 action。
3. 超过 10 分钟仍为 `planned` 的行动标记为 `canceled/interrupted`。
4. 超过 10 分钟仍为 `started` 且没有执行成功事实的行动标记为 `failed/interrupted`。
5. 已有 `playback_started` 的行动保持 `succeeded`；缺少终局结果的播放实例不推断用户态度。

领域错误分类：

- `validation`：非法枚举、越界置信度、无效 proposal；忽略提议并记录健康状态。
- `conflict`：活动上下文唯一索引冲突；在事务内重新读取并重放一次策略。
- `storage`：持久化失败；不执行新的未追踪 Agent 行动。
- `execution`：音乐、TTS、网络或 renderer 执行失败；行动失败，不影响用户偏好。
- `canceled`：用户或 runtime 取消；行动取消，不作为负向结果。

## 11. 数据迁移与兼容发布

采用仅新增迁移：

1. 创建四张新表和索引。
2. 为 `scene_sessions`、`listening_sessions` 增加 `stage_context_id` 可空列。
3. 为 `track_feedback_events` 增加 `agent_action_id`、`agent_action_item_id` 可空列，便于明确反馈直接归因。
4. 扩展 `Track` 可选字段；旧 JSON 无需迁移。
5. 新读路径优先读取 `stage_contexts`，兼容投影旧 `events`。
6. 新 outcome 同步写旧 feedback 聚合，现有画像和推荐查询无需一次性重写。

不建立双向双写：旧 `events` 不反向覆盖新上下文。若仍有旧调用方写 `event_started`，它只作为 legacy evidence 读取，避免两套状态机互相争夺。

当前数据库初始化已执行 `PRAGMA foreign_keys = ON`，新表可以使用级联和置空约束。迁移测试仍需覆盖 `resetDatabase()` 临时关闭外键后重新启用的路径。

建议在数据库 meta 中写入策略版本：

```text
stage_context_policy_version = 1
agent_outcome_policy_version = 1
```

行动和 outcome 的 `decision_json` / `metadata_json` 保存使用时的版本号，方便未来调整阈值时解释历史结果，但不回算旧事实。

## 12. 测试策略

### 12.1 单元测试

- proposal 枚举、置信度、摘要长度和 evidence id 校验。
- 相同阶段合并、互斥阶段切换、显式结束、显式纠正。
- TTL 默认值、上限、读取时过期和 revision 推进。
- action 合法状态迁移、终态不可变、恢复 action 关联。
- 播放阈值边界：29.9s / 30s、0.299 / 0.30、0.799 / 0.80。
- 同一播放实例只保留一个终局结果。
- 系统失败、取消和关闭不产生负向偏好。

### 12.2 数据库测试

- 每用户最多一个 active context。
- 上下文与 evidence 事务一致。
- 硬删除 context 后 evidence 删除、action 外键置空。
- outcome `source_event_key` 幂等。
- outcome 与旧 feedback 聚合在同一事务成功或回滚。
- 旧数据库升级后所有新增列可空，原数据可读。

### 12.3 集成测试

1. 絮语创建工作上下文，连续回声和场景均读取同一 id。
2. 连续回声运行期间，絮语结束上下文，下一 segment 不再使用旧 revision。
3. 场景“有点困”启动失败时记录 execution failure，不写用户不喜欢歌曲。
4. 同一歌曲由两次推荐产生，快速跳过只归因到第二次 action。
5. 推荐结果仅展示但未播放，不产生 `playback_started` 或收听结果。
6. 用户收藏一首 Echo 推荐歌曲，action outcome 为强正向，旧收藏与画像链路仍更新。
7. 应用重启恢复有效上下文，并清理中断 action。
8. 风信只引用 succeeded action 和真实 outcomes，不引用 planned/failed action。

### 12.4 回归门槛

- 现有全量 Vitest 通过。
- 新增数据库迁移测试通过。
- 打包后的 Windows 应用完成一次手工闭环：絮语表达状态 -> 场景/连续回声播放 -> 跳过/收藏 -> 重启 -> 查看上下文与行动历史。
- 不允许以跳过测试、放宽断言或关闭旧反馈写入来换取通过。

## 13. 实施顺序

### P1.1 数据契约与持久化

- 新增 stage context / agent action 类型、迁移、repository。
- 实现上下文生命周期、行动状态机、outcome 幂等。
- 完成纯策略与数据库测试。

完成标准：不接 UI 也能通过测试完整演示创建上下文、执行行动、记录结果和重启恢复。

### P1.2 絮语与跨入口上下文

- 扩展聊天 LLM 路由结构，一次返回 `StageContextProposal`。
- 在回复生成前应用上下文。
- 接入连续回声、场景和主动关心读取。
- 增加上下文查询、结束、纠正、删除 IPC。

完成标准：五个入口读取同一个上下文，结束和纠正能在下一次决策生效。

### P1.3 行动与播放归因

- 在回复、推荐、场景、连续回声、关心入口创建 action。
- 扩展 Track 归因字段和 renderer 播放回执。
- 集中播放 outcome policy，事务内兼容旧 feedback。

完成标准：每次真实播放都能从 `playbackInstanceId` 追到 action、item 和唯一终局结果。

### P1.4 消费侧与产品验证

- 风信只读已执行事实。
- 画像按 outcome 强度消费，防止 Echo 自推内容污染长期偏好。
- 增加最小用户控制和开发诊断视图。
- 执行全量回归、打包与手工验收。

完成标准：本设计第 2.2 节八项验收全部通过，且没有 P0/P1 级回归问题。

## 14. 已锁定决策

1. Phase 1 使用单个 active 主上下文，不引入上下文图或并行多阶段。
2. LLM 提议上下文，确定性策略拥有最终写入权。
3. `events` 不升级为上下文主表，也不做高风险历史回填。
4. runtime task 与 agent action 分离，前者服务执行，后者服务产品闭环。
5. 行动执行成功与用户喜欢严格分离。
6. 自动播放失败不记负向反馈，未播放的推荐不记收听行为。
7. 播放实例是归因最小单位，同曲不同实例不可合并。
8. 新结果层在迁移期单向派生旧 feedback，不建立两套状态机双向同步。
9. 删除上下文时删除私密语义，行动日志只保留去语义化执行事实。
10. Phase 1 不提前实现 Phase 2 的主动预算和 Phase 3 的关系修复。

## 15. 实现前检查点

以下现状已经确认：

- SQLite 初始化启用了外键约束，支持本设计的 `ON DELETE` 语义。
- renderer 已有真实的 play、heartbeat、ended 和 error 信号，但需要补齐 `playbackInstanceId` 并拒绝迟到回执。
- 当前 LLM chat route 已有兼容解析和规则 fallback；新增 proposal 必须保持可选，旧模型输出仍可工作。

P1.4 接主动关心时再确认 care ping 是否能区分“展示”“点击”“播放”。若事件源不能证明 ignored，就只记录已知事实，禁止根据超时推断用户忽略。
