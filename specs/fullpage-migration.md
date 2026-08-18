# 抽屉 → 整页迁移技术方案（设置 / 品味 / 队列与收藏）

状态：已完成（A/B/C/D 四批全部落地，0.2.0 发布；设计稿 fullpages-preview.html 终版）
前置核查：功能映射核查报告（2026-08-18，探索代理产出，16 个风险点已并入本文 §6）

## 1. 目标与范围

把设置、品味、队列三个右侧抽屉（520px 窄列）迁移为**整页**（1280 全宽），按已确认原型还原：
- 设置 = 左索引栏（236px）+ 右内容区；字号基准 14px
- 品味 = 整页阅读（画像陈述 + 维度四格 + 分组证据流 + 纠正区）
- 队列 = 标题栏工具 + 正在播放细条 + 三页签（队列/收藏/听过）+ 统一行尾图标操作 + 分页器 + 稀疏收尾区
- 三页空状态按原型（队列「让 Echo 挑一首」、品味「我还没听过你的歌」、设置未登录态/learned 空态）

**零丢失原则**：现有抽屉的全部功能、IPC、状态、边界行为按 §2 映射表逐项迁移；任何取舍在表中标明。

## 2. 功能映射表（旧 → 新）

### 2.1 设置页

| 现有结构 | 新结构 | 迁移方式 |
|---|---|---|
| settingsView: overview/connections/tasks + detailTarget 三级状态机 + 面包屑 | **左栏单级导航**（rail item = 旧 detailTarget），右侧只切内容 | 状态机简化为 `activeSection: SectionKey`；面包屑删除 |
| overview 的窗口尺寸/自动连播/说话密度 | 窗口尺寸→「窗口与关闭」；自动连播→队列页标题栏（已有）+「絮语与启动」保留开关；说话密度→「絮语与启动」静态行 | 字段与 IPC 不变 |
| connections 四字段行（AI模型/网易云/城市/回声语音） | 拆为 rail 三项：AI 模型 / 音乐来源 / 天气与语音 | 仅重组 |
| tasks（运行任务 + 服务状态 + 本地数据入口） | rail「运行任务」+「本地数据」两个 section | RuntimeTaskList/health 原样 |
| detailTarget: music/llm/voice/yinyi/chat/stage/learned/care/window/data | rail 全保留 + 新增 about（AboutEcho 内容嵌入） | 每个 section 的表单字段/IPC 原样迁移 |
| 网易歌单二级抽屉 | 保留（内嵌整页内，overlay 形态不变，focus 圈闭/Escape 逻辑照搬） | 风险点 #8 |
| 关于 Echo（独立 about 页） | 设置 rail 最后一项（AboutEcho 组件直接嵌入内容区） | AppPageKey 的 'about' 保留但不再有顶栏入口；TopBar 设置高亮只认 settings |
| 重新查看引导 / 反馈与建议 | 「关于 Echo」section 的支持链接区 |  |
| onTitleChange 动态抽屉标题 | 删除（整页标题由 rail 常显，无需回传 App） | 删 settingsDrawerTitle state |

**Rail 结构（终版）**：
```
连接与来源：音乐来源(music) · AI 模型(llm) · 天气与语音(voice)
相处方式：风信生成(yinyi) · 絮语与启动(chat) · 此刻的理解(stage) · Echo 学到了什么(learned) · 主动关心(care)
系统：运行任务(tasks) · 窗口与关闭(window) · 本地数据(data) · 关于 Echo(about)
```
默认激活：`apiFocusToken>0 ? llm : importFocusToken>0 ? music : (hasLlmConfig ? music : llm)`（保住 onboarding 两个落点，风险点 #2）。

### 2.2 品味页

| 现有 | 新结构 | 迁移方式 |
|---|---|---|
| portrait 正文 + clue 标记 | hero 陈述区（portrait 主句放大为衬线大字，clue 交互保留在正文） | findPortraitClueMatch 原样 |
| signature/genre/artist/mood/scene/era/energy 各区块 | 维度四格（语言/情绪底色/年代/场景）由现有数据聚合渲染；年代刻度、能量节奏展开保留在格内 | echoProfileDisplay 原样 |
| 近期洞察三键 + 问题回答表单 + 纠正面板 | 保留，置于证据流之后 | IPC 原样 |
| 记忆审计 + 版本恢复（versions tab） | 「它记下的证据」区（分组：本周/更早）+ 版本恢复入口 | getMemoryAudit/getProfileVersions 原样 |
| 空态（boundary taste_empty → EmptyState） | 原型空态（保留 boundary 优先顺序，风险点 #13） |  |
| 更新理解按钮 / 设置按钮 | hero 角落动作 |  |

### 2.3 队列页

| 现有 | 新结构 | 迁移方式 |
|---|---|---|
| tabs 正在播放/收藏/过往 | **正在播放细条（np-strip，全局置顶）+ 三页签：队列/收藏/听过** | playing 派生原样 |
| 过往 7 天按日分组 + 清空日期 | 「听过」页签保留按日分组（组头=日期+选择清除），行扁平化 | clearHistoryDates 原样（风险点 #10） |
| 收藏 加载更多（80/页） | **分页器**（每页 50，‹ 1 2 ›；favorites.list({limit,offset}) 已支持） | onChanged 广播重拉当前页（风险点 #11） |
| 行操作：播放/收藏/移除/拖拽/置顶语义 | 统一行尾图标（队列: ♥ ×；收藏: ＋ ♥；听过: ↺ ♥）＋ ⠿ 拖拽 | reorder 索引换算原样（风险点 #9）；「置顶」不再单列（拖拽承担） |
| 自动连播 switch | 标题栏（enqueueContextAfter 副作用保留，风险点 #12） |  |
| 清空过往（选择模式） | 听过页签组头动作 |  |
| 空态 CTA「去絮语」 | 原型「让 Echo 挑一首」= `echo.chat.send('随便来一首')` + navigate('chat')；次按钮「回到此刻」 |  |
| 稀疏收尾区（coda） | 队列页签底部：曲线 + 文案 + 安全网小字；**渲染条件：列表底沿距视口底 ≥ 240px**（ResizeObserver） | 纯渲染 |

## 3. 架构改动

### 3.1 路由与挂载（App.tsx）
- 三页移出 ContextDrawer，改为 `shell-page` display 门控**常驻挂载**（与 settings 现状一致，保 QR 轮询/mountedAtMsRef/语义去重 refs 语义，风险点 #6）
- `drawerOpen`/`drawerTitle`/`closeDrawer`/`settingsDrawerTitle` 全部删除；ContextDrawer 组件在批次 D 退役
- 页面进入动画：复用回声页的 entering 模式（铺展 900ms，reduced-motion 直达）

### 3.2 顶栏（TopBar.tsx）
- 导航变为四个文字项：风信 · 回声 · 品味 · 设置（品味/设置从 icon 按钮升级；设置高亮只认 page==='settings'）
- 队列入口不变：player 的「打开队列」+「接下来」行（原型如此，不加顶栏项）

### 3.3 E2E（e2eCapture.ts）
- 抽屉等待全部替换：`.d2-drawer-layer.open .settings-page` → `.shell-page[data-page="settings"]`；品味/队列同理
- 面包屑导航 → rail 点击（新增 testid：`settings-rail-{key}`；保留 `settings-connections-view` 等改为 `settings-sec-{key}` 断言）
- 新增截图：`queue-tabs.png`（三页签）、`settings-full.png`；更名 `profile-drawer.png`→`profile-page.png`、`queue-drawer.png`→`queue-page.png`、`about-drawer.png`→并入 settings-about

## 4. CSS 方案
- 新建 `theme/settings.css`（rail/行样式/整页容器）；`profile.css`、`queue.css` 重写为整页版
- core.css 退役区块：抽屉骨架 1-111、350-393、684-716、1744-1774、1940-1979 及 drawer-open 播放器协调 655/1244-1249（批次 D）
- 保留：网易二级抽屉、reset 对话框样式（归属 settings.css）

## 5. 实施批次（每批独立 verify + commit）

| 批次 | 内容 | 风险 |
|---|---|---|
| A | 设置整页（状态机简化 + rail + 全 section 迁移 + about 嵌入 + App/TopBar 接线 + settings.css + E2E） | 最大，#1/2/3/4/7/8/16 全在此批 |
| B | 品味整页（hero/维度/证据流 + 空态 + E2E） | 中 |
| C | 队列整页（页签/图标操作/分页/收尾区 + E2E） | 中，#9/11/12 |
| D | ContextDrawer 退役 + core.css 死块清理 + handoff 更新 | 小 |

## 6. 风险登记（核查报告 16 点 → 处置）

1. **双状态机+CSS门控**：新结构单一 activeSection，门控改为条件渲染，e2e 选择器同步换新
2. **focus token**：importFocusToken/apiFocusToken 保留，锚点 ref 移到 rail section 内容根，scrollIntoView 容器改为内容区
3. **reschedule 副作用**：全部继续走 settings:update/updateBatch（不改 IPC 层）
4. **skipHydrateRef**：与表单状态同组件层保留，不拆分表单组件
5. **计时器清理**：QR/验证码/状态清除/notice 计时器随组件常驻，卸载清理照旧
6. **挂载策略**：三页统一 display 门控常驻；EchoProfile 从条件挂载改常驻（App 已在 page 变化时 refreshProfile，行为不变）
7. **双份 detailTitles**：新结构只留一份 section 标题表
8. **二级抽屉 focus**：drawerReturnFocusRef/Tab 圈闭/Escape preventDefault 原样照搬
9. **拖拽索引换算**：行结构变但 playbackIndex 派生逻辑不动
10. **隐藏日期语义**：按钮文案与 IPC 语义不变
11. **favorites 双通道刷新**：toggle 三连 + onChanged 订阅都保留；分页只改 list 参数
12. **autoPlayNext 三入口**：Queue 版 enqueueContextAfter 副作用保留
13. **boundary 顺序**：三页空态先 boundary 后 EmptyState 保形
14. **e2e 硬依赖**：§3.3 全清单替换，无静默丢失
15. **about 归宿**：并入设置 rail（AppPageKey 'about' 暂留兼容旧跳转，TopBar 不再高亮）
16. **API key 掩码**：'••••••' 协议与 settingsSaved 派生判定原样；storageCannotSave 禁用逻辑原样

## 7. 验证
每批次：`npm run verify`（885+ 测试 / E2E 全绿）+ 新增截图视觉核验 + 真机安装验证（重点：设置各分区走查、QR 登录、队列拖拽与分页、品味空态）。完成后升 0.2.0（整页化为重大版本节点）。

实际落点：批次 A c5e9831（设置 rail 整页）、批次 B d685486（品味阅读页 + settingsLearnedToken 跨页联动）、批次 C 8b535bb（队列页签/分页/收尾区 + clearQueue）、批次 D（ContextDrawer 删除 + core.css 死块清理，drawer-open 协调、面包屑、旧字号补丁一并移除；网易二级抽屉与 reset 对话框样式保留在 core.css 共用）。
