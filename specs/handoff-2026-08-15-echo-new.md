# Echo `echo-new` 交接文档

更新时间：2026-08-15（D1.3 结构性迁移完成之后）
交接范围：D1.3 结构性 UI 迁移（本文件取代同日早前的设置链路交接版本，历史见 git）。

## 1. 先读结论

1. 当前工作分支仍是 `echo-new`，不是 `main`。
2. D1.3 迁移已完成结构性收尾：旧 Ayin 覆盖式迁移已停止，页面逐个改用 `d2-` 类名并删除对应旧 CSS。
3. `index.css` 从 6874 行降到约 3780 行；剩余部分仍承载 Settings 详情表单、Chat 消息流、Voice、Yinyi 等旧类名，属于**下一轮退役对象**。
4. 版本已升到 `0.1.8`，安装包 `echo-app/release/Echo-Setup-0.1.8.exe` 包含全部迁移内容，已通过安装器冒烟（干净安装/覆盖升级/静默卸载）。
5. 本机 Windows 开启了"减少动画"（`prefers-reduced-motion: reduce`），前奏等动效走缩短版是**设计内行为**，不是 bug。

## 2. 本轮迁移内容（11 个提交，2e23029..HEAD）

- **P0**：对话框/引导卡/空状态统一为 D1.3 方角细线语言；修复 `--ayin-green-800` 等悬空变量。
- **P1**：品味页重写为「理解/依据/版本」三页签（`theme/profile.css`）；队列页重写为「正在播放/收藏/过往」（`theme/queue.css`）；网易云歌单选择从底部弹层改为居中 D1.3 对话框；回望/风信工具栏、状态条统一。
- **P2**：`--d2-red` 修正为原型值 `#e45036`；抽屉宽度 440/480 体系；WindowField 按原型控制点精确重写（含流式端点标记、搜索绿线、错误灰虚线、一起听 72 根波形）；对话家族 presence 31px 阶梯。
- **P3**：首启前奏完整实现——深色幕布、红绿贝塞尔 5.9s 相遇动画（`WelcomeField`）、原型四句文案时间轴 + Echo 签名；静音路径 8s（reduced-motion 2.35s）自动进入，开声路径等音频播完进入。
- **P4**：死 CSS 清理（三轮，脚本 `scripts/strip-retired-css.py`，按选择器令牌精准删除，组合选择器保留未退役部分）。
- **收尾**：关于页改为 D1.3 抽屉排版（版本号经 vite `__APP_VERSION__` 注入）；E2E 新增品味/队列/关于抽屉截图与 `boundary-model-invalid` 场景（`ECHO_E2E_BOUNDARY` 强制钩子）；review 修复队列行 grid 列数 bug。

业务逻辑零改动：品味页纠正/洞察/问答/版本恢复、队列页拖拽排序/收藏/按日期清空、设置页全部表单功能均原样保留，只是视觉层重写。

## 3. 新的文件职责

```text
src/renderer/theme/tokens.css   D1.3 token（--d2-*，红色已对齐 #e45036）
src/renderer/theme/shell.css    shell 骨架（topbar/窗口控制/尺寸选择）
src/renderer/theme/core.css     D1.3 主体 + 对旧类名的剩余覆盖（settings 表单等）
src/renderer/theme/profile.css  品味抽屉 + 关于抽屉共用行样式
src/renderer/theme/queue.css    队列抽屉
src/index.css                   旧 Ayin 残余（Settings 详情/Chat 流/Voice/Yinyi）——待退役
```

加载顺序（main.tsx）：index → tokens → shell → core → profile → queue。

## 4. 验证基线

本轮最终代码上全部通过：

```text
npm run lint            0 warning
npm test                98 文件 / 817 项
npm run build           通过
npm run test:e2e:electron  5 场景 21 张截图（first-run 17 + sound 2 + offline 1 + boundary 1）
npm run release:verify  0.1.8 安装器 + 干净安装/覆盖升级/静默卸载冒烟
```

最新视觉证据：`echo-app/artifacts/electron-e2e/`（注意 artifacts 不入库，需重跑生成）。

## 5. 不要做的事

- 不要恢复覆盖式迁移的思路：新页面直接用 `d2-` 类名 + 新 CSS 文件，不要往 index.css 追加。
- 不要恢复旧三页签设置、底部网易云弹层、绿色渐变卡片、胶囊按钮。
- 不要在 renderer 重写 Agent 的主动预算、情境判断或结果归因。
- 不要把网络、播放或 TTS 故障当作用户负反馈。
- 队列"正在播放"行截图需要真实推荐数据（tracks_listened 表），E2E 无法低成本伪造，勿再尝试用 playback.enqueue 造数据。

## 6. 下一位接手者的建议开工顺序

1. `npm ci && node scripts/rebuild-native.mjs && npm run verify` 确认基线。
2. **P1**：继续退役 index.css 剩余部分——Settings 详情表单（Section/.field/.input）改 `d2-` 类名并拆出 `settings.css`；Chat 消息流（.msg/.bubble）与 Voice 页同理。
3. **P1**：说话密度是否成为真实设置（产品决策，需扩 Settings 类型 + IPC + 主进程消费 + 测试，不能只加 UI）。
4. **P2**：「此刻的理解」从设置入口迁到 D1.3 独立抽屉（迁移完成前不能删除当前入口）。
5. **P2**：模型失败/二维码过期/天气未设置/TTS 降级的针对性截图（inline 边界目前没有全局渲染入口，需要先补 renderer 消费）。
6. 合并回 `main` 前做一次完整回归 + 真机肉眼验收 D1.3 原型对照。
