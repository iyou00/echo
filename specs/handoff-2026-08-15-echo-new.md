# Echo `echo-new` 交接文档

更新时间：2026-08-15
交接范围：成熟 Agent 基线之后的 D1.3 / D2 桌面 UI 迁移，以及 D1.3 设置完整链路重构。

## 1. 先读结论

1. 当前应继续工作的分支是 `echo-new`，不是 `main`。
2. 当前工作目录是 `C:\Users\Max\.codex\worktrees\35e8\echo`。
3. `D:\AI文件\echo` 是 `main` 的另一个 worktree，直接复制它会漏掉 `echo-new` 的 D2 UI 和本轮设置重构。
4. `echo-new` 已包含 `main` 当前提交 `2e19b20`，D1.3 设置代码基线为 `5e98a9e`。
5. GitHub 的 `origin/echo-new` 已包含 `5e98a9e`，当前代码可直接从远端恢复。
6. `echo-app/release/Echo-Setup-0.1.7.exe` 是本轮设置改造之前生成的安装包，不代表当前工作区。
7. 接手方应从 `origin/echo-new` 开始，不要从 `main` 或旧安装包反推当前代码。

## 2. 产品与工程主线

Echo 的产品定位是“关系型音乐 Agent”，不是通用任务 Agent。核心闭环是：

```text
感知当前状态
  -> 判断是否介入
  -> 选择说话、询问、播放、调整或沉默
  -> 执行动作
  -> 观察真实结果
  -> 更新当前策略与长期理解
```

工程边界：

- LLM 负责识别、判断、起草和信息提取。
- 确定性代码负责路由、权限、重试、播放、持久化、安全边界和结果计数。
- renderer 只呈现 Agent 决策和受控状态，不重复实现主进程策略。
- 沉默是合法行动，不能因为“每轮必须回复”而强迫 Echo 说话。
- 当前状态、阶段情境、长期关系是不同时间尺度，不应混成一份画像。

必读文档：

- `specs/agent-product-next-stage.md`
- `specs/agent-phase1-technical-design.md`
- `specs/agent-phase2-technical-design.md`
- `specs/agent-phase3-technical-design.md`
- `specs/d2-ui-engineering-migration.md`
- `specs/architecture.md`
- `specs/data-model.md`

## 3. Git 与 worktree 状态

### 3.1 当前仓库

```text
Remote: https://github.com/iyou00/echo.git
Current worktree: C:\Users\Max\.codex\worktrees\35e8\echo
Current branch: echo-new
Current D1.3 code baseline: 5e98a9e Complete D1.3 settings flow
Remote branch: origin/echo-new contains 5e98a9e
Main: 2e19b20 Design agent relationship repair phase
Relation: echo-new contains main; use git rev-list for the current ahead count
```

主要 worktree：

```text
D:\AI文件\echo
  branch: main
  HEAD: 2e19b20

C:\Users\Max\.codex\worktrees\35e8\echo
  branch: echo-new
  D1.3 code baseline: 5e98a9e

C:\Users\Max\.codex\worktrees\eaa5\echo
  branch: codex/agent-kernel-v06
  HEAD: 2e19b20
```

### 3.2 本轮提交范围

```text
echo-app/electron/e2eCapture.ts
echo-app/src/App.tsx
echo-app/src/renderer/pages/Settings.tsx
echo-app/src/renderer/shell/ContextDrawer.tsx
echo-app/src/renderer/theme/core.css
specs/handoff-2026-08-15-echo-new.md
```

以上内容已提交并推送。交接完成时工作区应为 clean；若接手时不是 clean，先确认新增修改的来源，不要直接丢弃。

## 4. D1.3 / D2 已完成范围

`echo-new` 已完成 D2.0 至 D2.5：

- 固定三档 16:10 窗口与新桌面外壳。
- TopBar、右侧抽屉、WindowField 红绿动态线。
- 絮语、播放、一起听、场景、队列、品味、风信与设置迁移。
- 受控边界状态、离线和启动失败恢复。
- 音乐启动前奏、动态文案、恢复启动和繁忙退出。
- Electron 真窗口截图、媒体会话与安装器验证。
- 播放状态和底部波形动画修复。

已提交的关键节点：

```text
e1b1930 Establish D2 migration baseline
51b681c Migrate Echo desktop shell to D2
b4483c2 Migrate core Echo experiences to D2
0fcd6ab Add controlled D2 boundary states
f01278f Complete D2 startup and exit flows
39e58f6 Complete D2 release migration
9d9742d Align desktop experience with D1.3
383e40a Fix D1.3 playback and stage behavior
5e98a9e Complete D1.3 settings flow
```

## 5. 本轮实现：D1.3 设置完整链路

### 5.1 为什么重构

此前只有设置总览接近 D1.3。点击“连接与来源”后仍进入旧的“音乐同步 / 偏好设置 / 系统与服务”三页签，导致：

- 抽屉视觉语言中断。
- AI、网易云、天气和语音分散在不同页签。
- 设置、任务、诊断和阶段理解混在长表单中。
- 圆角卡片、胶囊标签、绿色提示块与 D1.3 的细线平面风格冲突。

本轮采用：

```text
设置总览 -> 二级功能页 -> 单项编辑页
```

### 5.2 当前页面结构

```text
设置
├─ 窗口尺寸（总览直接选择）
├─ 连续回声（总览直接开关）
├─ 说话密度（只读“自适应”）
├─ 风信生成 -> 风信单项编辑
├─ 主动关心 -> 主动关心单项编辑
├─ 关闭窗口 -> 窗口与关闭单项编辑
├─ 连接与来源
│  ├─ AI 模型 -> AI 单项编辑
│  ├─ 网易云音乐 -> 音乐来源单项编辑
│  ├─ 天气位置 -> 天气与语音单项编辑
│  └─ 回声语音 -> 天气与语音单项编辑
├─ 运行任务
│  ├─ 当前后台任务
│  ├─ 服务状态
│  └─ 本地数据入口
├─ 絮语与启动 -> 启动恢复单项编辑
├─ 此刻的理解 -> 阶段理解查看与纠正
├─ 关于 Echo
└─ 重新查看引导
```

“说话密度”当前没有真实持久化设置。为避免伪设置，它只显示 Agent 当前的“自适应”策略，不提供虚假的可点击编辑。若后续增加用户可配置密度，需要先扩展 `Settings` 类型、默认值、IPC path、主进程决策消费和测试，再开放 UI。

### 5.3 文件职责

#### `echo-app/src/App.tsx`

- 增加设置抽屉动态标题状态。
- 设置总览、连接、任务和单项编辑切换时，抽屉标题同步变化。
- 增加“重新查看引导”回调。

#### `echo-app/src/renderer/pages/Settings.tsx`

- 内部视图状态：`overview | connections | tasks | details`。
- 单项目标：音乐、风信、絮语、阶段理解、天气语音、主动关心、窗口、LLM、本地数据。
- 移除可见的旧三页签。
- “连接与来源”先展示四个连接摘要，再进入单项编辑。
- “运行任务”独立展示任务和服务状态。
- 保留原有业务函数，不重写网易云、模型、TTS、天气、任务和数据清空逻辑。
- 通过 scoped detail class 只呈现当前单项，避免一次性拆毁稳定业务表单。

#### `echo-app/src/renderer/shell/ContextDrawer.tsx`

- 增加 `view`，向抽屉提供 `view-settings` 等页面级 class。
- 设置抽屉可单独使用 480px 宽度和 D1.3 标题样式。

#### `echo-app/src/renderer/theme/core.css`

- 设置抽屉 480px、30px 左右留白、25px 衬线标题。
- 平面细分隔线、透明背景、底线输入框。
- 9-10px 辅助文字、11-12px 字段和设置行。
- 方形绿色描边按钮、红色异常状态。
- 去除设置详情内圆角卡片、胶囊选中块和阴影。
- 小型绿色开关和就地保存反馈。

#### `echo-app/electron/e2eCapture.ts`

- 截图前强制刷新 Electron 渲染表面，避免缓存帧。
- 新增以下设置链路截图：
  - `settings-overview.png`
  - `settings-connections.png`
  - `settings-ai-model.png`
  - `settings-tasks.png`
  - `settings-yinyi.png`

## 6. 设计依据

D1.3 原型当前不在 Git 仓库内，位于本机：

```text
C:\Users\Max\.codex\visualizations\2026\08\13\019ff8c3-cdcc-75e1-83bf-3559a2a02395\echo-directions\direction-d-1.3.html
```

同目录的重要文件：

```text
direction-d-1.2.html
direction-d-1.2-settings.png
direction-d-1.3.html
D1.3-BOUNDARY-STATE-MATRIX.md（若目录中存在）
```

若交接到另一台机器，应同时备份整个 `echo-directions` 目录，或将最终原型和边界矩阵加入仓库后再交接。

D1.3 设置视觉规则：

- 抽屉宽 480px，右侧覆盖，背景压暗。
- 标题 25px 衬线体，字重 500。
- 内容左右 30px。
- 用 1px 分隔线和留白分区，不使用卡片堆叠。
- 设置行 12px，当前值 10-12px 灰色。
- 详情标题 11px，辅助文字 9-10px。
- 输入框透明背景，只保留底部边线，聚焦时变红。
- 普通操作使用绿色描边方形按钮。
- 成功使用森林绿，运行、失败和警告使用红色。
- 未检查必须显示“尚未检查”，不能误报为“正常”或“异常”。
- 保存失败要说明发生了什么、保留了什么、如何恢复。

## 7. 最新验证结果

在本轮最终代码上已执行：

```text
npm run lint
npm test
npm run build
npm run test:e2e:electron
git diff --check
```

结果：

- ESLint 通过，0 warning。
- 98 个测试文件通过。
- 817 项单元测试通过。
- TypeScript、Vite renderer、Electron main/preload 构建通过。
- Electron 场景验证通过：first-run 14 张、first-run-sound 2 张、offline 1 张、startup-failure 1 张，共 18 张。
- `git diff --check` 通过。

最新视觉证据：

```text
echo-app/artifacts/electron-e2e/2026-08-15T01-30-26-777Z/
```

注意：`artifacts/` 可能被 `.gitignore` 忽略，交接到另一台机器时需单独备份，或由接手方重新运行 E2E 生成。

## 8. 当前安装包状态

项目版本仍为 `0.1.7`：

```text
echo-app/package.json
```

现有安装包：

```text
echo-app/release/Echo-Setup-0.1.7.exe
```

该安装包生成于本轮设置重构之前，不包含本交接文档第 5 节的设置修改。不要用它验收当前设置页面。

后续正式交付需：

1. 确认当前工作区与 `origin/echo-new` 一致。
2. 根据发布策略升级版本号，例如 `0.1.8`。
3. 运行 `npm run release:verify`。
4. 验证干净安装、覆盖安装、首次启动和卸载保留数据。

## 9. 下一位 AI 的建议开工顺序

### P0：固化当前成果

1. 阅读本交接文档和第 2 节列出的设计/Agent 文档。
2. 检查 `git status`，确认工作区 clean。
3. 查看最新设置截图。
4. 运行 `npm run verify`。
5. 后续修改继续在新分支或 `echo-new` 上形成清晰提交，不要直接改 `main`。

### P1：设置剩余产品决策

1. 决定“说话密度”是否成为真实用户设置。不要只加 UI。
2. 考虑把“此刻的理解”从设置入口进一步迁到 D1.3 独立抽屉；在迁移完成前不能删除当前入口。
3. 检查“关于 Echo”页面是否完全符合相同抽屉排版。
4. 为模型失败、网易云二维码过期、天气未设置、TTS 降级和任务失败补充针对性截图。
5. 可将本轮 scoped settings CSS 从 `core.css` 提取为 `settings.css`，但只在不改变加载顺序和视觉结果时进行。

### P2：发布

1. 进行一次代码审查，重点看深链返回、设置自动保存和业务入口可达性。
2. 升级版本。
3. 执行 `npm run release:verify`。
4. 生成并验收新安装包。
5. 提交、推送，再决定是否合并到 `main`。

## 10. 不要做的事

- 不要从 `D:\AI文件\echo` 开始并假设它包含当前 UI 修改。
- 不要删除仍包含未提交修改的任何 worktree。
- 不要恢复旧三页签。
- 不要把完整旧 Settings 表单重新塞进设置抽屉首屏。
- 不要为了“说话密度可点击”只增加一个无业务消费的 UI 值。
- 不要在 renderer 重写 Agent 的主动预算、情境判断或结果归因。
- 不要把网络、播放或 TTS 故障当作用户负反馈。
- 不要在没有重新打包的情况下声称 `0.1.7` 安装包包含本轮修改。

## 11. 推荐交接方式

### 方式 A：GitHub 分支交接（推荐）

当前版本已完成提交和推送：

```text
5e98a9e Complete D1.3 settings flow
origin/echo-new -> 5e98a9e
```

接手方：

```powershell
git clone https://github.com/iyou00/echo.git
cd echo
git switch --track origin/echo-new
cd echo-app
npm ci
npm run verify
```

### 方式 B：Git bundle 离线交接

需要额外离线备份时执行：

```powershell
git bundle create echo-new-2026-08-15.bundle echo-new
```

接手方可从 bundle 克隆，完整保留提交历史。

### 方式 C：未提交状态紧急备份

如果暂时不提交，至少在当前 worktree 执行：

```powershell
git diff --binary --output=echo-new-uncommitted.patch
```

同时单独复制本交接文档，因为未跟踪文件不会进入普通 `git diff`。

这只是应急方案，不如方式 A 稳妥。

## 12. 关于“直接复制 echo 目录”

可以作为额外快照，但不应作为唯一交接方式：

- 当前目录是 Git worktree，`.git` 是指向主仓库 metadata 的文本文件，移动到另一台机器或不同路径后可能失效。
- 复制 `D:\AI文件\echo` 会漏掉 `echo-new` 已提交的 D2 UI 与设置改动。
- 全目录会包含 `node_modules`、`dist`、`dist-electron`、`release` 和 `artifacts` 等大体积生成物。
- 仅复制源码又会丢失 Git 历史、分支关系和未提交状态说明。

如果必须复制目录，应复制：

```text
C:\Users\Max\.codex\worktrees\35e8\echo
```

并同时：

1. 不把复制后的 `.git` 当作可用仓库。
2. 单独保留本交接文档和 D1.3 原型目录。
3. 最好同时生成 Git bundle 或推送 `echo-new`。
4. 可排除 `node_modules`、`dist`、`dist-electron`、`release` 和 `artifacts`；依赖可用 `npm ci` 重建。

最终推荐：GitHub `echo-new` 是唯一代码真源，目录副本只作为保险。
