# Echo · 项目仓库

一个懂你音乐品味的桌面陪伴助手。

## 给开发 AI 的入口(Cursor / Codex / Claude Code)

**第一次打开这个仓库,按顺序读:**

1. `PRD.md` — 产品是什么
2. `specs/product-concept-handoff.md` — 当前产品构思与开发交接
3. `specs/persona.md` — Echo是谁(最重要)
4. `specs/tech-stack.md` — 用什么技术栈
5. `specs/architecture.md` — 代码结构
6. 要做哪个功能,就读 `features/<feature>.md`

**每次实现功能前必读:**
- 对应的 `features/<xxx>.md`
- `specs/data-model.md`(涉及存储时)
- `prompts/` 里的相关 prompt(涉及 LLM 调用时)
- `design/` 里的对应 HTML(涉及 UI 时)

## 给产品经理(用户本人)的入口

- 想回顾决策:看 `PRD.md` 的"关键决策"表格
- 想看当前状态:看 `PRD.md` 底部"当前进度"
- 想调Echo人格:改 `specs/persona.md` 和 `prompts/system.md`
- 想看界面:打开 `design/*.html` 用浏览器看
