# 品味页「信与指纹」实施规格

依据：profile-fingerprint-preview.html（用户已确认方向 + 三点修订：五色瓣/符号徽记/趋势与问答替换脚注纠正区）

## 数据映射（全部既有字段，零 schema 改动）

| UI | 来源 | 派生 |
|---|---|---|
| 指纹五瓣 | 语言: track_semantics.language 聚合（新增只读聚合函数）；情绪: moods[0].frequency；年代: era_preference 最大值；场景: scenes[0].frequency；探索: discovery_appetite | 归一化 0-1 → 轮廓半径 |
| 五色瓣颜色 | 森绿/靛蓝/赭棕/黛紫/眉红（CSS/SVG 常量） | 维度序固定 |
| 画像主句 | echo_portrait + clue 交互（既有） | 不变 |
| 注解五行 | genres[0-1]/moods[0-2]/era top2/scenes[0-2]/discovery 文案（既有 display 管线） | 行内五档刻度 = 数值*5 |
| 符号徽记 | speech/heart/clock/moon/compass 内联 SVG | 静态 |
| 趋势区 | profile.insights.recentChanges（既有！字段含 statement+evidenceLabel）+ genres[].trend | 每条一 spark（trend up/down 映射） |
| 问答卡 | taste.getProfile() 的 questions[]（既有）+ answerQuestion IPC | 按钮文案由问题 kind 派生三选项 |
| 更新理解 | regeneratePortrait（既有） | 文案改「重写这封信」 |

## 影响链（问答卡，全部既有）

answerQuestion → recordTasteQuestionAnswer → applyMemorySignal（reinforce_vibe/correct_assumption）→ 画像 incrementalSignals → 推荐 memoryConstraints/回声配乐/夜间复盘。

## 删除

pf-dims 四格卡片及其 CSS；ev-row 证据流；corr 纠正卡；cross-link/migrate-note（学到了什么入口已在设置 rail）；profileVersions 版本列表（版本恢复入口移到「重写这封信」的次级操作）。

## 保留

BoundaryState/空态；hero clue 交互；状态提示；refresh 链路。

## 验证

E2E profile-page.png 更新；walk-all profile 步骤改断言 .letterhead/.fingerprint；真机截图五色瓣渲染 + 悬停联动。
