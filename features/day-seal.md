# Feature · 日封 Day Seal

## 目标

用户关闭 Echo 时,把当天对话和推荐封存成 `data/seals/YYYY-MM-DD.md`。下次启动时,Echo 读取最近日封作为内心上下文。

## 存储

- 路径:`%APPDATA%/echo/seals/YYYY-MM-DD.md`
- 格式:Markdown + front matter
- 用户可以直接编辑或删除

## 触发

- `before-quit`
- `window-all-closed`

## 规则

- 当天没有对话时不生成
- 同一天多次归档时追加新段落
- LLM 失败时用本地 fallback 摘要
- 聊天 system prompt 注入最近日封前 2500 字

## 验收

1. 聊几轮后关闭 app,生成当天 md
2. 重开后聊天上下文能读到最近日封
3. 修改 md 后重开,后续对话使用修改后的内容
