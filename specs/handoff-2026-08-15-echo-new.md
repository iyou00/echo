# Echo `echo-new` 交接文档

更新时间：2026-08-16（接地前置路由 0.1.17 之后）
交接范围：D1.3 结构性 UI 迁移 + 体验层七项新能力 + 两轮视觉打磨（本文件取代同日早前版本，历史见 git）。

## 1. 先读结论

1. 当前工作分支仍是 `echo-new`，不是 `main`。
2. D1.3 迁移与七项 UX 增强均已完成：顶栏天气、反馈闭环、设置面包屑、每日重连动画、风信到达仪式、歌间旁白、Ctrl+K 想到就说。
3. 两轮视觉打磨已完成：风信页 D1.3 重写（双栏信纸）+ 播放界面（细线进度条/封面呼吸/下一首预告/再说说这首）+ 留白失衡治理（0.1.10）；设置界面四项修正（0.1.11，见 §2.5）。
4. `index.css` 剩余部分仍承载 Settings 详情表单、Chat 消息流、Voice 页旧类名，属于**下一轮退役对象**。
5. 版本 `0.1.17`，安装包 `echo-app/release/Echo-Setup-0.1.17.exe`。
6. 本机 Windows 开启了"减少动画"（`prefers-reduced-motion: reduce`），所有动效走缩短版/直跳是**设计内行为**。

## 2. 体验层七项新能力（2026-08-16）

| 能力 | 入口 | 关键文件 |
|---|---|---|
| 顶栏天气 + 异常态连接提示 | 顶栏日期区自动拉取（未配置城市静默降级） | `shell/TopBar.tsx` |
| 反馈看得见后果 | 更像这样/不太对/♡ 点击后就地确认，3.2s 自隐 | `components/feedbackNote.ts`、Player、Chat |
| 设置面包屑 | 设置抽屉三级导航顶部，可点回跳 | `pages/Settings.tsx` |
| 每日重连动画 | 冷启动 1.5s 红绿线相遇（首启用户不播；托盘唤起不播） | `components/DailyReconnect.tsx`、`meetingCurve.ts`、`MeetingCanvas.tsx` |
| 风信到达仪式 | 新风信首次打开播 2s 暗场动画后展开信纸；红点在仪式后清除 | `pages/yinyiArrival.ts`、Yinyi、App |
| 歌间旁白 | 一起听标题逐句淡入；听完一首显示过渡句接入下一首理由 | `components/listeningNarration.ts`、Player |
| Ctrl+K 想到就说 | 任意页面 Ctrl/Cmd+K 弹底部细线输入条；对话页则聚焦输入框；无模型/首启/引导/关闭确认时不响应 | `shell/QuickAskBar.tsx`、`shell/quickAskGuard.ts` |

架构约定：体验层改动全部只动渲染层（唯一例外：无）；快捷条的历史同步用渲染层 CustomEvent（`echo:quick-ask-exchange`），**不要**改回主进程广播（会与打字机流程双写用户消息）。确定性文案（听后感/反馈确认）刻意不走 LLM——旁白要的是在场感，不是新判断。

## 2.5 设置界面四项修正（2026-08-16，0.1.11）

用户真机反馈驱动的修正，全部只动渲染层：

1. **模型缺失空状态并入左栏**：「还差一条模型连接」提示从舞台中央并入左侧 presence 列——presence 标题是**唯一**大标题，boundary 块以 bare 模式渲染（无 ECHO 眉线、无重复标题，只留正文+按钮），位于标题下方续接；presence 的泛用描述行在该态隐藏。两版教训：①不要把空状态整块（含标题）左移——presence 标题本来就写着同一句话，会叠成两句；②CSS 必须对准**实际渲染类名** `.d2-empty`（EmptyState 组件输出），`.empty-state`/`.boundary-state` 是死类名（迁移遗留，已全部清除）。
2. **导入歌单视图 D1.3 化**：网易云登录/二维码/短信/进度条/从文件导入全部改为细线平面语言（衬线标题、方角二维码框、2px 红线进度条、底线输入框）。E2E 新增 `settings-import.png`（共 22 张）。
3. **设置字号可读性**：small 类文字从 9-10px 提到 10.5-11px（settings/service/profile/queue 全套），不再有小于 10.5px 的正文。
4. **面包屑唯一导航**：删除三个子视图返回按钮，面包屑加 testid（`settings-crumb-overview/connections`）接管回跳；E2E 改用面包屑导航。

## 2.6 一起听视图与传输解耦（2026-08-16，0.1.14）

用户反馈的两处交互问题（迷你封面 3 个播放入口、播放/暂停引起整页缩放）重构为「按钮管声音，眼睛管视图」：

| 行为 | 现在 | 之前 |
|---|---|---|
| 播放页里暂停 | 停留：封面变暗（`.is-paused`）、进度冻结 | 整页塌回首页 |
| 收起播放页 | 只有「‹ 回到此刻」或队列播完 | 任何暂停 |
| 迷你封面控件 | 播放/暂停 + 下一曲，仅此两个 | 上一曲/播放/下一曲/队列/音量 + 封面可点 + 下方圆钮 |
| 封面点击 | 迷你态=进入播放页（门）；放大态=播放/暂停 | 一律播放/暂停 |
| 队列入口 | 「接下来 · 歌名」整行可点（无歌时显示"队列与收藏"） | 迷你封面上的独立按钮 |
| 自动进入播放页 | 每会话首次有歌接上时一次；点过「回到此刻」后本会话不再自动 | 任何播放都自动进入 |

实现要点：`listeningViewOpen`（用户意图）+ `listeningDismissed`（会话级自动阻断）取代播放状态驱动；`deriveWindowFieldMode` 不再接收播放状态参数（见 stageMode.ts 注释）。E2E 的封面暂停/恢复序列天然回归此行为：若视图还会塌缩，第二次封面点击会变成"展开"而非"播放"，断言即失败。

## 3. 文件职责

```text
src/renderer/theme/tokens.css   D1.3 token（--d2-*，红色 #e45036）
src/renderer/theme/shell.css    shell 骨架 + 快捷条样式
src/renderer/theme/core.css     D1.3 主体 + 对旧类名的剩余覆盖
src/renderer/theme/profile.css  品味/关于抽屉共用行样式
src/renderer/theme/queue.css    队列抽屉
src/renderer/components/meetingCurve.ts + MeetingCanvas.tsx  相遇线动画基建（首启 5900ms / 每日重连 1500ms / 风信 2000ms 共用）
src/main/skills/intent/evalCases.ts   意图路由评测集（复利资产，见 §7）
src/index.css                   旧 Ayin 残余——待退役
```

## 4. 验证基线（0.1.17）

```text
npm run lint               0 warning
npm test                   106 文件 / 859 项（含意图评测集 7 项）
npm run test:e2e:electron  5 场景 22 张截图（shell-empty 与 boundary-model-invalid 均经视觉核验：无重复标题、无堆叠）
npm run dist               0.1.17 安装器（release:verify 的冒烟段对正式安装有保护，覆盖升级用 /S 手动做）
```

手动验收清单（E2E 无法覆盖、需真机确认）：
1. 配置真实 LLM 后 Ctrl+K 发一句话，回复淡入、历史落到对话页、带歌时"去此刻看歌"可达。
2. 设置城市后顶栏出现"城市 温度 · 天气"；夜间模式可读。
3. 老用户（完成过首启）冷启动看到 1.5s 重连动画；首启用户只看完整前奏。
4. 22 点风信生成后打开风信页，先仪式后信纸；红点在仪式结束后消失。

## 5. 意图路由的架构方向与评测集（2026-08-16 起生效）

真实故障（陈默之+随便 → 判成场景、从未搜歌手）确立的总方向：**搜索结果是路由的裁判，不是路由的产物**。分阶段推进：

- 已落地（0.1.17，阶段 0+1）：随便/随机移出 SCENE_PATTERN；artist_request 优先于 scene_request；「你觉得X有什么好听的」与裸歌手收尾两个抽取模式（带词表/长度/描述词三道闸）；**意图评测集** `src/main/skills/intent/evalCases.ts`——每次真实失败在修复的同一提交里入集，永不重犯。首批 6 用例（含两轮歌手继承、抛弃信号守卫），上线前就抓出 3 个回归。
- 已落地（0.1.17，阶段 2 接地前置）：音乐动作句先做网易云实体验证（2.2s 预算、90s 结论性缓存与下游 searchMusic 共享、净延迟≈0；超时不缓存），正面证据以 `netease_grounding` 数据字段注入路由 prompt（规则 30：已核实实体直接采信，不熟也不能降级）；实体句路由预算放宽 5s（闲聊不加）；LLM 超时回退路径采信已验证规范名；`explainRouteRejection` 镜像安全闸门输出拒绝原因进日志。测试 859 项（+8 接地/拒绝原因/所有格）。
- 下一阶段：路由输出结构化声明、kind 派生化；回退路径改保守模式（证据不足优先追问）。
- 判定原则：歌手是锚、场景是修饰；「随便/随机」是授权词不是场景；续接轮（再/还有+会话）继承歌手槽，「算了/别的」清空。

## 5.7 梦境自进化（2026-08-16，0.1.19）

个体进化层：每晚 23:30（dream.reviewAt 可配）复盘当天对话，LLM 提取被纠正事件写入 learned_cases 表（migration v13），次日路由 prompt 以 learned_corrections 字段注入（规则 31：先例非命令）。分级激活：显式纠正（置信≥0.85+逐字证据）直入 active；模糊信号 pending 待第二日独立佐证（≥2 转正）；同实体新期望反驳旧条 → retired；30 天无佐证衰减；active ≤50。安全设计：evidence 必须逐字来自当天对话（归一化包含匹配），LLM 失败什么都不写（宁可不学不学错），companion_adjustment 走人格通道不双写。审计页「Echo 学到了什么」：设置概览入口，每条可删。红线：**梦只写数据不改代码**。真机已验证全链路（含补发重试与审计页数据渲染）。

## 6. 不要做的事

- 不要恢复覆盖式迁移：新页面直接用 `d2-` 类名 + 新 CSS 文件。
- 不要把快捷条历史同步改为主进程 message-injected 广播（双写）。
- 不要给确定性旁白/反馈文案接 LLM。
- 不要在 renderer 重写 Agent 的主动预算、情境判断或结果归因。
- 队列"正在播放"行截图需要真实推荐数据，E2E 无法低成本伪造。
- **只信 E2E 截图会漏真机状态**：E2E 是全新档案（无模型、无品味数据），用户真实档案命中的分支可能不同。布局改动要用 `scripts/capture-live.mjs` + `probe-live.mjs`（CDP 连 `--remote-debugging-port=9222` 的真实实例）实测 getBoundingClientRect 与截图后再发布。

## 7. 下一位接手者的建议开工顺序

1. `npm ci && node scripts/rebuild-native.mjs && npm run verify` 确认基线。
2. 继续退役 index.css 剩余部分（Settings 详情表单、Chat 消息流、Voice 页）。
3. 说话密度是否成为真实设置（产品决策，需扩 Settings 类型 + IPC + 主进程消费 + 测试）。
4. 「此刻的理解」迁独立抽屉；inline 边界（task_failed/tts_fallback/mic_denied）补全局渲染入口。
5. 合并回 `main` 前做完整回归 + 真机肉眼验收。

