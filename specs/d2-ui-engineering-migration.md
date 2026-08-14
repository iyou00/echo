# Echo D2 UI 工程迁移方案

## 1. 文档目的

本文把已经确认的 D1.3 设计原型映射到当前 Electron 工程，作为 D2 实施、评审和合并的共同基线。

D2 只迁移界面、交互编排和状态呈现。Agent 的判断、主动预算、结果归因、重试和持久化继续由主进程及 Phase 2 负责，renderer 不复制这些规则。

参考输入：

- D1.3 原型：`direction-d-1.3.html`
- D1.3 边界矩阵：`D1.3-BOUNDARY-STATE-MATRIX.md`
- Agent 路线：`specs/agent-product-next-stage.md`
- Phase 2 设计：`specs/agent-phase2-technical-design.md`，已随 `main` 同步

## 2. 当前基线与开工门槛

| 项目 | 当前状态 | 决策 |
| --- | --- | --- |
| UI 分支 | `echo-new`，合并基线 `af1ce0f` | D2 文档和后续 UI 实施分支 |
| Agent 分支 | Phase 2 已由 `aecc716` 完成 | 已合入 `main`，原功能分支无需再作为汇合来源 |
| 线上主分支 | `origin/main` 为 `2e19b20` | 已包含 Phase 1、Phase 2、成熟路线和 Phase 3 设计文档 |
| 本地主分支 | `main` 为 `2e19b20` | 与 GitHub `main` 一致 |

**D2.1 开工门槛：**

1. Phase 2 worktree 提交并给出测试结果。已完成：87 个测试文件、780 项测试全部通过，生产构建通过。
2. `echo-new` 同步 Phase 2 稳定提交后再改 `App.tsx`、`appState.ts`、`api.ts`、`ipc.ts` 和 `index.css`。已完成：合并基线 `af1ce0f`。
3. 同步后先运行 `npm test`、`npm run build`，基线失败时不开始 UI 迁移。已完成：780 项测试与生产构建通过。

原因：Phase 2 修改了上述五个 UI 核心文件。虽然无落盘合并预检显示当前可以自动合并，仍应先同步稳定基线，再开始 D2.1，避免后续把业务契约冲突伪装成样式冲突。

## 3. 工程策略

### 3.1 保留的边界

- 保留 React、Electron、Vite、现有 IPC 和 SQLite 架构。
- 保留 `getEchoApi()` 作为 renderer 唯一能力入口。
- 保留现有页面内部业务流程，按批次迁入新的外壳，不进行一次性重写。
- 保留 `appState.ts` 作为跨页面 UI 状态源，但只存可展示状态。
- 继续使用 `lucide-react` 图标，不手绘工具图标。

### 3.2 新增的 UI 层

建议新增以下 renderer 目录，不提前抽象业务服务：

```text
src/renderer/shell/
  EchoShell.tsx
  TopBar.tsx
  NowStage.tsx
  ContextDrawer.tsx
  CloseDialog.tsx
  WindowField.tsx

src/renderer/boundary/
  BoundaryState.tsx
  boundaryPresentation.ts

src/renderer/onboarding/
  FirstRunPrelude.tsx
  OnboardingFlow.tsx

src/renderer/theme/
  tokens.css
  shell.css
```

`boundaryPresentation.ts` 只把受控原因码映射为标题、说明和允许的动作，不解析任意错误文本，也不决定重试策略。

### 3.3 不采用的方案

- 不把 D1.3 单文件 HTML 直接复制进 React。
- 不在 renderer 重新实现推荐、主动预算或失败归因。
- 不同时保留旧路由布局和新布局两套长期运行的 UI 范式。
- 不用 CSS 隐藏旧页面来假装迁移完成；每个批次都要明确组件所有权。

## 4. D1.3 到现有工程的功能映射

| D1.3 区域 | 现有实现 | D2 处理 |
| --- | --- | --- |
| 应用外壳、顶部栏 | `App.tsx`、`components.tsx` | 新建 `EchoShell`，替换旧页面导航外观，保留导航动作 |
| 此刻主空间 | `Chat.tsx` | 聊天成为主空间的一种展开状态，不改发送管线 |
| 歌曲对象 | `Player.tsx`、`PlaybackState` | 重排为主空间对象，保留播放实例和完成归因 |
| 一起听 | `Voice.tsx`、`Player.tsx` | 复用播放和连续回声状态，改变呈现，不复制播放器 |
| 连续场景 | `SceneRail`、scene IPC | 场景入口迁到主空间底部，保留 `scene.start/play/end` |
| 回望 | 当前聊天历史、队列历史、事件数据 | D2.2 先做只读聚合抽屉，缺少契约时标记延期 |
| 品味 | `EchoProfile.tsx` | 改为宽抽屉或主空间深层视图，证据操作保持原样 |
| 风信 | `Yinyi.tsx` | 作为沉浸状态接入外壳，保留日期和生成任务 |
| 设置与连接 | `Settings.tsx` | 分组放入宽抽屉，Phase 2 主动设置完整保留 |
| 队列 | `Queue.tsx` | 接入右侧宽抽屉，保留排序、移除和自动连播 |
| 后台任务 | `RuntimeTaskNotice/List` | 统一放入任务抽屉和局部状态，不改 runtime 生命周期 |
| 阶段情境 | `stageContext` IPC | 新增“此刻理解”抽屉，分别调用 end/correct/delete |
| 退出确认 | `closeDialogOpen`、app IPC | 重新排版；繁忙信息需要主进程提供活动摘要 |
| 首次启动 | `FirstRunWelcome.tsx`、已有 MP3 | 重构为音乐前奏，再衔接现有 onboarding policy |
| 红绿动态线 | 原型 Canvas、现有 `WaveBars` | 新建 `WindowField`，按 UI 状态渲染，不承载业务判断 |

## 5. 首次启动迁移决定

正式工程已经有 `public/welcome/first-run-welcome.mp3`、音频淡入淡出和首次完成状态，因此：

1. 复用真实 MP3，不采用原型的 Web Audio 合成和弦。
2. `FirstRunPrelude` 只在 `firstRunWelcomeOpen` 时出现。
3. 先由用户点击“开启声音”或“静音进入”，满足浏览器媒体策略。
4. 红线表示 Echo 的回应，绿线表示用户持续的生活与聆听；两线交汇后进入 API 和歌单配置。
5. 可跳过、可静音；跳过同样调用现有 `completeFirstRunWelcome()`。
6. `prefers-reduced-motion` 下缩短文案和线条过程，但不跳过隐私与下一步信息。
7. 普通启动只保留 1 至 2 秒的“重新接上”短动画，不重复完整前奏。

## 6. 边界状态工程契约

### 6.1 展示模型

建议由共享 IPC 返回受控快照：

```ts
type UiBoundaryCode =
  | 'startup_failed'
  | 'model_missing'
  | 'model_invalid'
  | 'music_empty'
  | 'queue_empty'
  | 'taste_empty'
  | 'context_empty'
  | 'offline'
  | 'no_playable'
  | 'playback_recovering'
  | 'mic_denied'
  | 'tts_fallback'
  | 'yinyi_empty'
  | 'yinyi_failed'
  | 'task_failed'
  | 'import_invalid'
  | 'close_busy'

interface UiBoundarySnapshot {
  code: UiBoundaryCode
  scope: 'system' | 'surface' | 'inline'
  sourceId?: string
  retryable: boolean
  preserved: string[]
  occurredAt: string
}
```

`first-welcome` 由 onboarding policy 决定，不属于错误快照。文案可留在 renderer，原因码、是否可重试和关联任务必须来自主进程。

### 6.2 当前可直接接入的状态

| 状态 | 现有数据来源 | 缺口 |
| --- | --- | --- |
| 首次欢迎 | `firstRunWelcomeOpen` | 只需视觉迁移 |
| 模型未配置 | `Settings.llm` | 无 |
| 音乐为空 | queue、profile、导入任务 | 需要统一 readiness 计算位置 |
| 队列为空 | `PlaybackState.queue` | 无 |
| 品味为空 | `TasteProfile | null` | 无 |
| 阶段情境为空 | `stageContext.getActive()` | 外壳需加载快照 |
| 播放恢复 | playback 状态、`refreshUrl` | 需要稳定失败原因和恢复阶段 |
| 风信为空 | `yinyi.getByDate/getRange` | 无 |
| 任务失败 | runtime/import snapshot | 无 |
| 繁忙退出 | playback、runtime tasks | 需要聚合活动摘要 |

### 6.3 仍需主进程补充的状态

- 启动失败的结构化原因与诊断目录动作。
- 全局网络可用性与本地能力快照。
- 无可播候选的受控 outcome，不能从聊天文案反推。
- 麦克风权限、设备占用和 TTS 失败的受控原因。
- 导入校验错误的字段级摘要。
- 封面 URL、下载缓存与失败回退状态。

这些缺口在 D2.3 处理。D2.1 和 D2.2 不用临时字符串解析填补。

## 7. Phase 2 汇合契约

Phase 2 拥有：

- 主动预算、安静时段、暂停和 `stay_silent`。
- 主动行为的 `carePingId`、原因码和结果记录。
- Agent action 的执行状态与结果归因。

D2 拥有：

- 预算结果、暂停状态和原因的可视化。
- 用户触发的暂停、恢复、静音和查看详情动作。
- `stay_silent` 时不渲染消息、不显示故障，只保持当前空间。

renderer 禁止：

- 自己计算当日主动次数或安静时段。
- 根据用户是否点击来直接更新长期关系偏好。
- 将网络、播放或 TTS 失败写成用户负反馈。

## 8. 分批实施顺序

### D2.1 应用外壳

范围：tokens、固定尺寸、窗口约束、TopBar、EchoShell、WindowField、基础抽屉。

成功标准：

- 1152×720、1280×800、1440×900 三档保持 16:10。
- Windows 窗口不可自由拖动尺寸、不可最大化，设置切换档位后居中。
- 现有页面仍能从新外壳进入，IPC 调用和业务测试不变。
- 红绿线在空闲、聊天、播放三种状态下非空且不遮挡操作。

### D2.2 核心体验

范围：聊天、歌曲对象、一起听、场景、队列、品味、风信、设置。

成功标准：发送、取消、搜索、播放、暂停、切歌、队列、场景、回声和任务流程通过现有测试；旧页面布局被逐项替换，不保留双 UI。

### D2.3 边界状态

范围：D1.3 的代表状态、受控原因码和恢复动作。

成功标准：失败保留输入和当前歌曲；系统失败不记为负反馈；每个恢复动作可重复调用；全状态自动截图。

### D2.4 首次启动与退出

范围：音乐前奏、onboarding、启动失败、繁忙退出、托盘恢复。

成功标准：有声、静音、跳过、减少动态、启动失败和任务繁忙六条路径可自动验证。

### D2.5 回归与打包

范围：全量测试、Electron 窗口测试、断网与权限测试、NSIS 包。

成功标准：`npm test`、`npm run build`、关键 Electron E2E 通过，生成可安装 EXE，并在干净用户目录验证首次启动。

## 9. 文件所有权

| 文件区域 | D2.1 前 | D2.1 后 |
| --- | --- | --- |
| `src/main/**` | Phase 2 / 业务线 | D2 只在 D2.3 按契约补 IPC，不改策略 |
| `src/types/ipc.ts` | Phase 2 先提交 | 同步后按新增受控快照扩展 |
| `src/renderer/api.ts` | Phase 2 先提交 | 保持 mock 与真实 API 同构 |
| `src/renderer/appState.ts` | Phase 2 先提交 | D2 增加纯 UI 展示状态 |
| `src/App.tsx` | 双方都会触碰 | Phase 2 先提交，D2 再拆外壳 |
| `src/index.css` | 双方都会触碰 | Phase 2 主动设置样式先保留，再拆 theme/shell |
| `src/renderer/pages/**` | 现有业务页面 | D2.2 逐页迁移 |

## 10. 验证矩阵

每个批次至少执行：

1. `npm test`
2. `npm run build`
3. 现有 mock contract 测试
4. 目标状态 Playwright 截图
5. 1280×800 与 1152×720 的文字溢出检查
6. Canvas 像素非空检查

最终 Electron 验证增加：窗口不可缩放、托盘恢复、媒体键、音频设备、断网、Cookie 过期、首次安装和数据升级。

## 11. D2.1 开工清单

- [x] Phase 2 形成稳定提交并提供测试结果。
- [x] `echo-new` 同步 Phase 2 提交，解决契约冲突。
- [x] 记录同步后的基线 commit：`af1ce0f`。
- [x] 基线 `npm test` 和 `npm run build` 通过。
- [ ] 新建 theme tokens，不删除旧 CSS。
- [ ] 新建 `EchoShell`，先承接现有页面。
- [ ] 实现三档固定窗口 IPC 和设置入口。
- [ ] 实现 `WindowField` 的空闲、聊天、播放三态。
- [ ] 截图评审通过后，再进入 D2.2。
