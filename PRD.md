# Echo · AI 音乐陪伴助手

> 最后更新:v0.1-draft

## 一句话

Echo不是"AI 工具",是一个**懂你音乐品味的老朋友**。它住在你电脑里,会聊天、会播歌、会讲音乐故事,每晚给自己写一篇"风信"——关于今天你的观察日记。

## 产品定位

- **不是**播放器(虽然它包含播放器的功能)
- **不是**推荐算法(虽然它会推歌)
- **是**一个有持续人格、会积累品味、会写日记的音乐搭子

## 核心体验

1. **对话为主,播放为辅**。主界面是你和Echo的对话,歌曲作为卡片嵌在消息里。
2. **它懂你**。初次导入网易云歌单后,它会主动和你确认它对你的理解,之后持续演化。
3. **场景化表达**。点击语音按钮,它会用 100 字以内的一段文案朗读当前时刻的场景(时间 + 心情 + 推荐理由)。
4. **风信日记**。每天 22:00 它自动写一篇"对话型日记",像给自己的信,观察今天的你。
5. **主动 + 被动兼具**。早晨问好、深夜陪聊由定时任务触发;你打开它,它根据当下上下文回应。

## 关键决策(已拍板)

| 话题 | 决定 | 备注 |
|---|---|---|
| 名字 | **Echo**(中文可叫 Echo / 回响 / 回音) | 回声之意 · 详见 `specs/persona.md` |
| 人格 | 老朋友音乐搭子 + 委婉劝阻型(有看法但不强推) | 详见 `specs/persona.md` |
| 数据源 · 音乐 | v0.1 用静态 JSON 导入;v0.2 起接 `@neteasecloudmusicapienhanced/api`(直接 import 主进程,不起本地服务) | 接口最全 + TS ready + 内置解灰;非官方有风险,详见 `tech-stack.md` |
| 数据源 · 电影 | 用户手动喂结构化数据(后续持续追加) | v0.1 砍掉,v0.3+ 再做 |
| MVP 范围 | 音乐优先;电影后置 | |
| 桌面形态 | Electron + React + TypeScript | Windows 为主,跨平台 |
| LLM 接入 | **原生 `fetch`** + **OpenAI 兼容协议** · API 端点和模型在设置里随时改 | 不用 SDK,自己写薄客户端;支持 DeepSeek / Kimi / OpenRouter / 任何兼容服务 |
| 记忆架构 | 三层:长期品味 + 中期事件 + 短期对话 | 详见 `specs/data-model.md` |
| 存储 | 本地 SQLite | 备份即复制文件 |
| 视觉气质 | 淡绿主色 + 对话优先 + 分段进度条 + 语音模式抹茶卡片 | 借用少量 Nothing Design 的工业感 |

## 文档索引

所有细节都在分文档里,主 PRD 只做索引。按阅读顺序:

1. `specs/persona.md` — Echo是谁(**灵魂文档**)
2. `specs/tech-stack.md` — 技术栈 + Windows 环境搭建
3. `specs/architecture.md` — 模块划分 + 数据流
4. `specs/data-model.md` — 三层记忆 + TasteProfile schema
5. `features/` — 每个功能一份文档
   - `features/chat.md` — 对话
   - `features/recommendation.md` — 推荐引擎
   - `features/settings.md` — 设置(LLM 配置 + 风信偏好 + 数据管理)
   - `features/voice-mode.md` — 语音模式
   - `features/yinyi.md` — 风信日记
   - `features/taste-profile.md` — 品味档案 + Echo 主页
   - `features/playback.md` — 播放器
6. `specs/roadmap.md` — v0.1 / v0.2 / v0.3 切分
7. `tasks/v0.1-week1.md` — **v0.1 开工任务清单**(给开发 AI 看)
8. `design/` — 高保真 HTML 原型 + 视觉 tokens
9. `prompts/` — Echo 的 system prompt + 各场景模板
10. `samples/` — 歌单样例 / 艺人种子 / 风信范文

## 当前进度

- [x] 产品定位对齐
- [x] 人格方向拍板(Echo + 委婉劝阻型)
- [x] 视觉方向拍板(主界面 + 语音模式 mockup)
- [x] 技术栈拍板(Electron + React + TS + 原生 fetch + OpenAI 兼容)
- [x] `persona.md` 主干完成
- [x] `tech-stack.md` 完成
- [x] 主界面 HTML 原型落地
- [x] 语音模式 HTML 原型落地
- [x] `system prompt` v0.2
- [x] `风信` prompt 初稿
- [x] `场景化语音` prompt 初稿
- [ ] Echo 主页 mockup + HTML ← 下一步 B
- [ ] 风信页 mockup + HTML ← 下一步 B
- [ ] 拾音页 mockup + HTML ← 下一步 B
- [x] `features/chat.md` 完成
- [x] `features/settings.md` 完成
- [x] `features/recommendation.md` 完成
- [x] `features/yinyi.md` 完成
- [x] `features/taste-profile.md` 完成
- [x] `features/playback.md` 完成
- [x] `features/voice-mode.md` 完成
- [x] **`tasks/v0.1-week1.md` v0.1 任务拆分完成**
- [x] **样例数据齐全**(`samples/artist-genre-seed.json`、`samples/playlist-sample.json`、`samples/yinyi-reference.md`)

### 🎉 spec 仓库 v1 完整,可以开工
