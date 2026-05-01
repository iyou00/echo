# Feature · 设置(Settings)

> **对应 UI**:`design/settings.html`
> **对应代码模块**:`src/main/services/settings.ts`、`src/main/db/settings.ts`、`src/renderer/pages/Settings.tsx`
> **入口**:Echo 主页右上角齿轮图标

---

## 1 · 这个功能要做什么

让用户调整 Echo 的所有偏好,**重点是让用户随时能换 LLM 提供商**(国内可访问的 OpenAI 兼容服务)。
不上传任何数据到云端,所有设置都本地存。

## 2 · 设置项分组

### 2.1 AI 模型(必填,首启动必须配置)

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `llm.baseUrl` | string | `""` | OpenAI 兼容端点。例:`https://api.deepseek.com/v1` |
| `llm.apiKey` | string(加密) | `""` | 用 Electron `safeStorage` 加密存 |
| `llm.model` | string | `""` | 模型名。例:`deepseek-chat` |

**预设(UI 上展示为可点击的标签)**:
- `claude-opus-4-7`
- `deepseek-chat`
- `moonshot-v1-32k`
- `gpt-4o`
- `glm-4-plus`
- `qwen-max`

预设只是方便点击填入,用户也可手动填任何模型名。

### 2.2 风信

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `yinyi.generateAt` | string `"HH:mm"` | `"22:00"` | 风信生成时间 |
| `yinyi.openWithRandom` | boolean | `false` | 打开风信页时:false = 看今天;true = 看随机过去一篇 |

### 2.3 对话与品味

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `chat.restoreOnStart` | boolean | `true` | 关掉则每次打开都是新对话 |

**操作类(不存设置,触发动作)**:
- **打开艺人映射表** —— 调用系统默认编辑器打开 `data/artist-genre-map.json`,用户可手动增改艺人 → genre/mood 映射;保存后 recommender.ts 自动 reload(无需重启)
- **重新初始化品味档案** —— 警告确认 + 删 `taste_profile` 表 + 重新从歌单观察
- **导入歌单** —— 选 JSON 文件 → 写入 `playlists_imported`,触发档案重建

> **品味的可调性 · 核心设计原则**
>
> 用户对自己品味档案有**完整控制权**。三个修改路径,从轻到重:
>
> 1. **自然演化(推荐)** —— 在絮语里告诉 Echo:"我最近不太爱 X 了 / 新喜欢上 Y"。Echo 后台调用 `taste.ts:applyUserCorrection()` 更新对应字段。**这是最自然的方式,Echo 在角色里**。
> 2. **回答 Echo 主页的提问** —— 「Echo 问你」区每个问题点回答后,直接写回档案。
> 3. **手动编辑文件** —— 高级用户可直接编辑 `data/artist-genre-map.json` 或者通过"导出 → 改 → 导入"修改完整 TasteProfile JSON。
> 4. **核选项** —— "重新初始化",清空一切重来。
>
> 中期事件(events 表)**不提供 UI 直接编辑**——它们应该在对话里自然产生和结束。用户在对话中说"那件事过去了" / "考研结束了",Echo 自动把对应事件标记为已结束。

### 2.4 网易云(v0.2 启用)

不存在 settings JSON 里,登录状态从 `netease/auth.ts` 读。
界面只展示**当前登录状态** + **扫码登录 / 退出**按钮。

### 2.5 数据

不存 settings,触发动作:
- **导出所有数据**:把 SQLite 文件 + `prompts/` + 当前 settings 打成 zip,让用户保存
- **清空所有数据**:三次确认 + drop 所有表 + 重启 app

## 3 · 输入(Inputs)

每个设置项的输入约束:

| 字段 | 校验 |
|---|---|
| `llm.baseUrl` | 必须以 `https://` 或 `http://` 开头 · 长度 < 200 |
| `llm.apiKey` | 长度 1-200 · 不允许换行 |
| `llm.model` | 长度 1-100 · 不允许空格(部分模型名带 `/`,允许) |
| `yinyi.generateAt` | 必须 `HH:mm` 格式 · 24 小时制 |

校验失败:输入框红边 + 下方 11px 红色提示。**不阻止用户继续打字**,只在保存时弹错。

## 4 · 输出(Outputs)

设置改动**自动保存**,无需"保存"按钮。每次 toggle / blur 输入框都触发一次写入:

```typescript
await ipc.settings.update({ path: 'yinyi.generateAt', value: '23:30' });
```

后端写入流程:
1. 校验
2. 取出当前 JSON,merge 新字段
3. 用 `safeStorage` 加密 `apiKey`(如果改的是这个字段)
4. 写回 SQLite
5. **广播变更事件**到所有监听者:scheduler 重读 `yinyi.generateAt`、chat 重读 LLM 配置、等等

## 5 · 关键功能 · 测试 LLM 连接

用户填完 baseUrl + apiKey + model 后点"测试连接",触发:

```typescript
async function testLlmConnection(): Promise<TestResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { ok: false, err: `HTTP ${res.status}`, ms: Date.now() - start };
    }
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, err: humanizeError(e), ms: Date.now() - start };
  }
}
```

**UI 反馈**(状态指示器,点测试后实时更新):

| 状态 | 颜色 | 文字 |
|---|---|---|
| 测试中 | 灰 | `测试中…` |
| 成功 | 绿 | `连接正常 · {ms} ms` |
| 失败 (HTTP 错误) | 红 | `连接失败 · {错误码 / 友好消息}` |
| 失败 (超时) | 红 | `超时 · 检查网络或 baseUrl` |
| 失败 (无网络) | 红 | `网络不可达` |

## 6 · 安全:apiKey 处理

**绝对原则**:apiKey 只在三个地方出现:

1. 内存(运行时,从加密存储解密后驻留)
2. SQLite `settings` 表(加密后)
3. 实际发往 LLM 的 HTTP 请求(`Authorization` 头)

**绝不**:
- ❌ 写到日志文件
- ❌ 写到错误堆栈
- ❌ 显示在 UI(只显示 `sk-•••...••` 掩码)
- ❌ 包含在导出数据中(导出时会被替换为占位符 `<API_KEY_REDACTED>`)
- ❌ 包含在 IPC 消息(到渲染进程时永远是掩码态)

代码层面:封装 `getApiKey()` 函数,调用方明确知道自己在拿 secret;其他地方拿到的都是 mask。

## 7 · 状态机 · 首次启动引导

新用户首次打开 app,`settings.llm.*` 都为空 → **不能直接进絮语**。

引导流程:
```
[启动] → [检测 llm 配置] 
              │
       ┌──────┴──────┐
       │             │
    已配置        未配置
       │             │
       ▼             ▼
   [进主页]    [全屏引导]
                   │
                   ▼
            "嗨,我是 Echo。在我们开始前,
             你需要给我一个 LLM 端点。"
                   │
                   ▼
              [Settings 页]
                   │
                   ▼
              [测试连接]
                   │
                ┌──┴──┐
                成功  失败
                │      │
                ▼      ▼
            [进主页] [继续填]
```

引导页**不是另一个页面**,就是 Settings 页 + 顶部一段引导文案。完成后引导文案消失,变成普通 Settings。

## 8 · IPC 接口

```typescript
// 渲染 → 主
settings.get(): Promise<Settings>            // 不含 apiKey 明文
settings.update({ path, value }): Promise<void>
settings.testLlm(): Promise<TestResult>
settings.exportData(): Promise<{ filePath: string }>
settings.clearAllData(): Promise<void>       // 重启
settings.reinitTaste(): Promise<void>
settings.importPlaylist(filePath): Promise<{ trackCount: number }>

// 主 → 渲染(广播)
'settings:changed' → { path, value }    // 别的 UI 监听以同步
```

## 9 · v0.1 范围切分

### v0.1 必须:
- [x] LLM 配置 + 测试连接
- [x] 风信生成时间
- [x] 启动恢复对话开关
- [x] 重新初始化品味
- [x] 导入歌单(JSON)
- [x] 导出 / 清空数据
- [x] 首启动引导

### v0.2:
- [ ] 网易云登录 / 退出
- [ ] 风信"打开时随机翻一页"开关

### v0.3+:
- [ ] 主题切换(light / dark / system)
- [ ] 主动推送时间段
- [ ] 开机自启
- [ ] TTS 引擎选择(Edge TTS / ElevenLabs / 其他)

## 10 · 测试场景

| 场景 | 预期 |
|---|---|
| 全新安装,启动 | 引导页要求填 LLM |
| 填错 baseUrl 后测试 | 红色错误,不阻止保存,不进主页 |
| 测试通过后返回主页 | 絮语可用 |
| 改风信时间从 22:00 → 08:00,等到第二天早上 8 点 | 风信按时生成 |
| 把开关"打开时随机翻一页"打开,进风信 | 看到的不是今天 |
| 点"清空所有数据" → 三次确认 | 数据库清空 + 重启回到引导页 |
| 改 model 后没测试连接 | 下次发对话失败,Echo 说"我连不上自己脑子" |

## 11 · 与其他 feature 的耦合

- `chat.ts` 启动时从 `settings.llm` 读配置
- `scheduler.ts` 启动时 + 设置变更时,重新注册 cron(读 `yinyi.generateAt`)
- `yinyi.tsx` 渲染时根据 `yinyi.openWithRandom` 决定默认显示哪一篇
- `chat.tsx` 启动时根据 `chat.restoreOnStart` 决定是否拉对话历史

所有耦合通过 `settings:changed` 事件解耦——任何模块只订阅自己关心的字段变更。
