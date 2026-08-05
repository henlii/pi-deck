# 主题令牌与颜色模式

Pidance 已有 `--bg`、`--bg-panel`、`--bg-hover`、`--bg-selected`、`--border`、`--text`、`--text-muted`、`--text-dim`、`--accent`、`--accent-hover`、`--user-bg`、`--assistant-bg`、`--tool-bg`、`--bg-subtle`、`--warning`、`--font-mono` 变量。建议保留这些公开语义名，不让组件直接依赖某个主题的色值。

## 使用方式

```css
:root { /* 默认主题 + 浅色 */ }
html.dark { /* 默认主题 + 深色 */ }
html[data-theme="spectrum"] { /* 光谱舱浅色 */ }
html.dark[data-theme="spectrum"] { /* 光谱舱深色 */ }
html[data-theme="phosphor"] { /* 磷光终端浅色 */ }
html.dark[data-theme="phosphor"] { /* 磷光终端深色 */ }
```

`mode` 只控制亮暗：`light`、`dark`、`system`。`system` 在运行时解析 `prefers-color-scheme`，但保存的偏好仍应保持 `system`，方便系统变化后自动更新。

## 具体令牌

| 变量 | 墨纸浅色 | 墨纸深色 | 光谱浅色 | 光谱深色 | 磷光浅色 | 磷光深色 | 语义 |
|---|---|---|---|---|---|---|---|
| `--bg` | `#f7f4ed` | `#24221f` | `#eef3fb` | `#0b1124` | `#f1f5f1` | `#070b08` | 页面与聊天背景 |
| `--bg-panel` | `#eee9df` | `#302d28` | `#e3eaf5` | `#0e162b` | `#e5ece6` | `#0d1510` | 侧栏、面板 |
| `--bg-hover` | `#e7dfd3` | `#3a3530` | `#d9e3f2` | `#17233e` | `#dce8de` | `#142018` | 悬停 |
| `--bg-selected` | `#ded6c9` | `#463b34` | `#cbdcf0` | `#1d3154` | `#c5ddc9` | `#1b3020` | 当前项 |
| `--border` | `#d9d3c7` | `#514a42` | `#c9d4e7` | `#293957` | `#b7cdbb` | `#37503d` | 分隔和边界 |
| `--text` | `#292722` | `#eee8df` | `#17233b` | `#dce6ff` | `#172119` | `#d7e3d9` | 主文字 |
| `--text-muted` | `#7d776c` | `#aaa095` | `#607294` | `#8b9abf` | `#5f7263` | `#8ca191` | 次要文字 |
| `--text-dim` | `#9a9387` | `#766e64` | `#8392ae` | `#65779e` | `#809182` | `#627566` | 辅助文字 |
| `--accent` | `#da5b42` | `#ee785d` | `#157d73` | `#6ce8ce` | `#16813c` | `#8dff9c` | 主动作／焦点 |
| `--accent-hover` | `#b64431` | `#ff9478` | `#0c625b` | `#95f4df` | `#0d612d` | `#c0ffc5` | 强调悬停 |
| `--user-bg` | `#eee7dc` | `#3d342e` | `#dbe5f6` | `#192746` | `#dce9de` | `#142018` | 用户消息 |
| `--assistant-bg` | `#fbf9f4` | `#24221f` | `#f5f8fc` | `#0b1124` | `#f7faf7` | `#070b08` | Pi 消息 |
| `--tool-bg` | `#f2eee5` | `#302d28` | `#111b32` | `#101a30` | `#edf4ee` | `#101912` | 工具调用 |
| `--warning` | `#a85c16` | `#efad55` | `#9a6400` | `#f2c15e` | `#9a6400` | `#ffd06a` | 警告 |

## 辅助语义

建议补充但不让组件自造变量：`--success: #4c8a5b / #76d69a`、`--danger: #c84949 / #ff8c8c`、`--focus-ring: color-mix(in srgb, var(--accent) 65%, transparent)`。文字与背景的普通文本目标至少 4.5:1，大字号至少 3:1；磷光主题仍应让长段正文使用柔和的浅灰，而不是纯绿。

## 主题切换体验

- 切换按钮同时显示当前主题名称和亮／暗图标，不能只显示太阳或月亮。
- 使用现有 View Transitions circular wipe 时保留 `prefers-reduced-motion: reduce` 关闭动画。
- 颜色模式、主题、消息密度、减少动效属于 UI 偏好；不得写入 Pi session schema。
