# 视觉 Tokens

所有 HTML 原型和最终 React 组件都从这份 tokens 派生。**改设计先改这里。**

## 色板

### 主色系(淡绿)

| Token | 色值 | 用途 |
|---|---|---|
| `--ayin-green-900` | `#27500A` | 深色文字(在浅绿底上) |
| `--ayin-green-700` | `#3B6D11` | 次深文字 |
| `--ayin-green-600` | `#639922` | **主色**:头像 / 主按钮 / 高亮 / 波形 active |
| `--ayin-green-400` | `#8FBC57` | 辅助 |
| `--ayin-green-300` | `#C0DD97` | 波形非 active |
| `--ayin-green-100` | `#EAF3DE` | **浅底**:抹茶底、自己消息气泡、语音模式背景 |

### 中性色(浅色模式)

| Token | 色值 | 用途 |
|---|---|---|
| `--bg-primary` | `#FFFFFF` | 主背景 |
| `--bg-secondary` | `#F7F7F5` | 次级背景(对话区域) |
| `--bg-tertiary` | `#EDEDE8` | 第三级 |
| `--text-primary` | `#1A1A1A` | 主文字 |
| `--text-secondary` | `#5C5C5A` | 次文字 |
| `--text-tertiary` | `#999996` | 说明文字 / 时间戳 |
| `--border` | `rgba(0,0,0,0.08)` | 分割线 / 细边框 |

### 暗色模式(先预留,v0.1 不做)

TODO

## 字体

```css
--font-sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", "Courier New", monospace;
--font-serif: "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif;
```

### 用在哪

| 字体 | 用途 |
|---|---|
| `--font-sans` | 默认正文、按钮、UI |
| `--font-mono` | 元数据(时间戳、艺人年份、状态标签、分段数字)、技术感的装饰 |
| `--font-serif` | **情感浓的地方**:track card 的小注("— 醒着做梦的感觉")+ 语音模式的主文案 + 风信日记正文 |

### 字号 / 行高

| Token | 值 | 用途 |
|---|---|---|
| 正文 | 13px / 1.7 | 对话消息 |
| 标题 | 16px / 1.3 | 页面标题 |
| 元数据 | 10-11px / 1.3 | 时间、艺人年份、state 标签 |
| 语音主文案 | 17px / 1.9 衬线 | 语音模式的主文字 |
| 风信正文 | 14px / 1.9 衬线 | 风信页 |

## 间距

遵循 4px 栅格:`4 / 8 / 10 / 12 / 14 / 16 / 18 / 22 / 24 / 28 / 32`。

## 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | 小标签 |
| `--radius-md` | 8px | 卡片 / 按钮 |
| `--radius-lg` | 12px | 消息气泡 / 大卡片 |
| `--radius-full` | 9999px | 头像 / 圆形按钮 |

## 装饰元素

### 分段进度条

- 段数:30(播放进度条)
- 每段:`flex: 1; height: 4px; gap: 2px`
- active 段 = `--ayin-green-600`
- 非 active = `--border`

### 波形图(音浪)

- 32-40 根竖条,`gap: 2px`
- 宽 2-3px,高度随机 25%-90%
- 每第 3 根用 `--ayin-green-600`(深),其余用 `--ayin-green-300`(浅),造出跳动感
- 播放时整体从左到右扫描动画

### 状态标签

- 用等宽字体 + 字距拉开:`letter-spacing: 2px; text-transform: none`
- 例:`E C H O · S P E A K I N G` / `On air` / `TAP`

### 头像

- 32px 圆形
- 主色底 + 浅色"音"字
- 右下角 9px 绿点 = 在线状态(带 2px 主背景描边)

## 组件行为规则

1. **对话气泡**:Echo气泡左上圆角 4px,其他角 12px;用户气泡相反
2. **track card**:嵌在消息内部,背景用 `--bg-secondary`,小圆形播放按钮 30px
3. **对话时间戳**:只显示在Echo一侧,等宽字体,`HH:mm` 格式
4. **语音按钮**:40px 主色圆形,图标是 5 根跳动竖条(不用传统麦克风图标)
5. **顶部导航**:极简,只出现"风信 / 列表"两个 tab,等宽字体
