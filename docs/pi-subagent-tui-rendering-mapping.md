# Pidance 复用 pi 插件 TUI 显示 —— 调研记录与映射设计

> 日期：2026-08-04
> 范围：pi（pi-coding-agent 0.81.1 / pi-subagents 0.35.1）插件在 TUI 中的显示效果，
> 能否不经 Pidance 内置代码、由插件自身的 TUI 渲染逻辑直接映射到 Pidance Web UI（0 代码显示）。

---

## 1. 结论摘要

- **原理上完全可行**：pi 插件的所有 TUI 显示最终都收敛为
  `Component.render(width) → string[]`（ANSI 行），且组件渲染是**纯函数式**的
  （不依赖真实终端），可在任何 Node 环境 headless 调用。
- **Pidance 架构恰好具备条件**：插件代码加载在 Next.js server 进程内
  （in-process AgentSession + `bindExtensions`），且 `createExtensionUiContext`
  由 Pidance 自己实现（不经过 pi 的 rpc-mode UI），自由度在 Pidance 手里。
- **「0 代码显示」的含义**：每个插件 0 代码；Pidance 需一次性建设「渲染桥」：
  调用插件渲染函数 → headless `render(width)` 产出 ANSI 行 → SSE 推送 →
  前端 `renderAnsiLine()` 转 React 元素。
- **边界**：纯展示类部件（工具结果块、widget、自定义消息/条目）可 0 代码映射；
  交互类部件（select/confirm/input/editor/custom）仍走现有 `extension-ui-bridge`
  （已桥接），不依赖渲染桥。
- **可退役内置代码**：`MessageView.tsx` 中 `SUBAGENT_TOOL_NAME` 硬编码 +
  `SubagentResultCard` + `parseSubagentResult` 这套「内置插件显示」，桥建成后可
  由插件自己的 `renderResult` 替代（文本回退保留）。

---

## 2. pi TUI 插件显示部件全景

插件可注入的显示表面共 7 类：

| # | 部件 | 注入入口 | TUI 中的最终形态 | 数据载体 |
|---|------|---------|----------------|---------|
| 1 | 工具调用行 | 工具的 `renderCall(args, theme, ctx)` | 消息流里那一行（如 `subagent parallel (3) [async]`） | `Text` 组件 |
| 2 | 工具结果块 | 工具的 `renderResult(result, opts, theme, ctx)` | 消息流里展开的结果区，外包 Box（成功/错误/进行中三色） | `Container`/`Box` 组件树 |
| 3 | 编辑器 widget | `ctx.ui.setWidget(key, lines\|工厂, {placement})` | 编辑器上方/下方固定面板（`aboveEditor`/`belowEditor`） | 字符串数组或 `(tui, theme) => Component` 工厂 |
| 4 | 自定义消息 | `pi.registerMessageRenderer(type, renderer)` | 消息流内的特殊条目（pi-subagents 的 ⚠ 控制提示、steering 提示） | `(message, opts, theme) => Component` |
| 5 | 自定义条目 | `pi.registerEntryRenderer(type, renderer)` | 会话内不参与 LLM 上下文的条目（如状态卡） | `(entry, opts, theme) => Component` |
| 6 | 全局杂项 | `ctx.ui.*` | notify 通知横幅 / setStatus 状态行 / setTitle 终端标题 / setEditorText 输入区文本 / setWorkingIndicator 加载动画 / setFooter、setHeader | 文本、帧序列、工厂 |
| 7 | 交互对话框 | `ctx.ui.select/confirm/input/editor` + `custom()` | 模态窗口、自定义覆盖面板（带输入） | 结构化请求/响应 |

### 2.1 工具结果块（部件 2）的典型形态 —— 以 pi-subagents 为例

`renderSubagentResult`（`src/tui/render.ts:1461`）产出的组件结构：

- 外层 `Box` 按状态着色：`toolPendingBg`（运行中）/ `toolSuccessBg`（成功）/
  `toolErrorBg`（出错）（`extension/index.ts:139-141`）。
- 首行：`{状态字形} {agent名} {模型徽标} {⟳ turns · ↑in ↓out Rcache Wcache $cost · ctx · model}`。
- 缩进行：`⎿ 活动`、live 状态行、嵌套 widget 行、`output: 路径`、`session: 路径`。
- 运行中整个容器持续重建（`rebuildSlashResultContainer` 在每次 render 时检查
  快照版本或 running 状态），实现滚动式 live 更新。

### 2.2 Async widget（部件 3）的典型形态

`WIDGET_KEY = "subagent-async"`（`shared/types.ts:1287`），`ctx.ui.setWidget` 注入：

- 标题：`● Async agents · background`（运行中为 accent 色 ●，空闲为 dim ○）。
- 树形列表：`{状态字形} {job名} · {统计}`，子行 `⎿ 活动`、并行 agent 详情。
- 超量折叠：`+N more (x running, y queued, z finished)`（`render.ts:1229-1297`）。
- **注意**：工厂形式 `(_tui, theme) => Component`，rpc-mode 与 Pidance 现状均丢弃。

---

## 3. 关键机制事实（决定可行性）

1. **Component 接口极简**：`render(width: number): string[]`，每行是含 ANSI 码的
   字符串（`tui.md:14-24`）。所有内置组件（Text/Box/Container/Spacer/Markdown）
   与插件自定义组件都实现该接口 → **headless 可执行**。
2. **pi 的 rpc-mode 故意砍掉组件渲染**：`dist/modes/rpc/rpc-mode.js` 的
   `setWidget` 只接受字符串数组、组件工厂被忽略；`renderResult`/`renderCall`
   不暴露（那是 TUI 层 tool-execution.ts 的工作）。RPC 模式另有
   `extension_ui_request` stdout 协议（select/confirm/input/editor/notify/
   setStatus/setTitle/setEditorText/setWidget-lines）。
3. **Pidance 不经过 rpc-mode UI**：`rpc-manager.ts:1122` `createExtensionUiContext`
   是自研实现，`bindExtensions({ uiContext, mode: "rpc" })` 传入 → 插件拿到的
   `ctx.ui` 完全由 Pidance 决定。
4. **插件工具对象自带渲染器**：`inner._toolRegistry` 中的工具定义含
   `renderCall(args, theme, context)` 与 `ln(result, options, theme, context)`
   （源码内 renderResult 的字段名在 dist 中为 `ln`），Pidance server 进程内可达。
5. **前端已有 ANSI 渲染能力**：`ChatWindow.tsx:928` `renderAnsiLine()` 用
   `parseAnsiLine()` 把 ANSI 段转成带内联样式的 `<span>`；`lib/ansi.ts` 负责解析。

---

## 4. Pidance 现状盘点

| 部件 | Pidance 现状 | 位置 |
|------|-------------|------|
| 1/2 工具调用行+结果块 | 内置渲染：通用 ToolCallBlock 卡片 + subagent 专用 `SubagentResultCard`（硬编码） | `components/MessageView.tsx:766-931`、`lib/subagent-result.ts` |
| 3 widget | `ExtensionWidgets` 已存在，但 `rpc-manager.ts:1207` 丢弃非数组内容（组件工厂） | `components/ChatWindow.tsx:831`、`lib/rpc-manager.ts:1207` |
| 4 自定义消息 | 未桥接 | — |
| 5 自定义条目 | 未桥接 | — |
| 6 全局杂项 | notify / setStatus / setTitle / set_editor_text 已桥接；working/footer/header 为 no-op | `lib/rpc-manager.ts:1122-1250` |
| 7 交互对话框 | `InlineExtensionCard` + `ExtensionCustomPanel` 已完整桥接 | `components/InlineExtensionCard.tsx`、`components/ChatWindow.tsx` |

---

## 5. 渲染桥设计（Pidance 一次性建设）

```
插件代码（Pidance server 进程内）
  │  renderCall / renderResult / setWidget(工厂) / registerMessageRenderer
  ▼
Pidance「渲染桥」：调用插件渲染函数 → Component
  ▼
component.render(width)  →  ANSI 行（纯函数，无终端依赖）
  ▼
extension_ui_request SSE 推送（复用现有通道）
  ▼
前端 renderAnsiLine()（已存在）→ React 元素
```

需要补的 4 个环节：

| 环节 | 现状 | 要做 |
|------|------|------|
| 工具渲染器调用 | 从不调用（前端自己画卡片） | tool_call/tool_result 事件时从 `_toolRegistry` 取 `renderCall`/`renderResult`，用真实 theme 调用 |
| setWidget 组件工厂 | `rpc-manager.ts:1207` 直接丢弃非数组 | 工厂 `(tui, theme) => Component` → headless render → ANSI 行 |
| theme | `PLAIN_TEXT_THEME` 把所有颜色剥掉（`rpc-manager.ts:166-188`） | 换用 pi 主题 JSON（`dist/modes/interactive/theme/`）或语义色→CSS 变量映射 |
| 事件驱动重渲染 | — | 运行中结果/widget 按事件（tool_update、async job 变更）重新执行渲染并推送 |

---

## 6. 映射落点表

| pi 部件 | Pidance 落点 | 现状 |
|--------|-------------|------|
| 1/2 工具调用行+结果块 | `MessageView.ToolCallBlock` 卡片 | 内置（subagent 硬编码 `SubagentResultCard`，其余走文本/diff）→ 桥接后可改为插件 `renderResult` 输出 |
| 3 编辑器 widget | `ChatWindow.ExtensionWidgets`（ChatWindow.tsx:831） | 已存在，但只接收字符串数组；组件工厂被 `rpc-manager.ts:1207` 丢弃 |
| 4 自定义消息 | 消息流内卡片（仿 InlineExtensionCard 样式） | 未桥接 |
| 5 自定义条目 | 消息流内条目 | 未桥接 |
| 6 全局杂项 | 通知条/状态栏/`document.title`/输入框/加载指示 | notify、setStatus、setTitle 已桥接；其余 no-op |
| 7 交互对话框 | `InlineExtensionCard` + `ExtensionCustomPanel` | 已完整桥接（select/confirm/input/editor/custom） |

---

## 7. 边界与风险

- **交互组件不可 0 代码**：有 `handleInput`/键盘焦点/滚动选择的组件
  （select-list、editor、菜单）无法映射，仍走现有 `extension-ui-bridge`
  （InlineExtensionCard 已处理）。**静态/状态显示部分**（subagent 结果卡片、
  async widget、状态行、通知框）可完全 0 代码。
- **宽度**：`render(width)` 需要固定 width（如 100 列），前端 `pre-wrap` 展示
  ——与现有 `ExtensionWidgets` 一致。
- **组件状态保持**：widget 的布局状态（如 pi-subagents 的 `widgetLayoutSession`）
  在 server 端闭包里，Pidance 需保留工厂引用，事件驱动时重调。
- **主题差异**：TUI 语义色（accent/toolOutput/warning...）需映射到 Pidance CSS
  变量，避免硬编码色值。
- **性能**：headless render 每次事件一次；运行中组件持续重建需防抖/节流。
- **兼容性**：dist 中 renderResult 字段名为 `ln`（压缩），取用需按工具定义
  结构兼容（`renderResult` 与 `ln` 双查）。

---

## 8. 建议实施路径（缺失项全景清单）

### 渲染桥主线（0 代码显示）

1. **阶段 A（最小闭环）**：tool_result 事件 → `_toolRegistry` 取渲染器 →
   headless render → ANSI 行 → SSE → ToolCallBlock 内通用 ANSI 渲染。
   以 subagent 工具为验证样例，对比 pi TUI 与 Pidance 显示。
2. **阶段 B**：`setWidget` 支持组件工厂（含 `widgetLayoutSession` 状态保持），
   补齐 Async agents widget。
3. **阶段 C**：`registerMessageRenderer` / `registerEntryRenderer` 桥接
   （自定义消息/条目 → 消息流内卡片）。
4. **阶段 D**：退役 `SubagentResultCard`/`parseSubagentResult` 内置逻辑
   （保留回退），完成「0 代码显示」。

### 配套缺失项（与主线并行/前置）

5. **M1 · 主题映射**：`PLAIN_TEXT_THEME`（rpc-manager.ts:166-188）剥掉全部颜色；
   需替换为 pi 主题 JSON（dist/modes/interactive/theme/）或语义色 → Pidance
   CSS 变量映射，否则 headless render 产出的 ANSI 行无颜色。**阶段 A 的前置**。
6. **M2 · 事件驱动重渲染**：⚠ **当前定界为 snapshot-only（oracle 审核 2026-08-04）**
   ——`setWidget` 组件工厂仅在每次调用时渲染一次静态行快照，工厂的
   state/invalidate 生命周期与事件驱动重渲染（防抖/节流）不支持；动态内容需
   插件主动再次 `setWidget` 才更新。运行中组件持续重建（widgetLayoutSession
   状态保持）待真实插件需求再扩展。**阶段 B 内已落地 snapshot 形态**。
7. **M3 · 兼容层**：dist 中 renderResult 字段名压缩为 `ln`，取渲染器需
   `renderResult` / `ln` 双查。**阶段 A 内**。
8. **M4 · 消息显示重设计**：当前 NoticeShelf 5 秒自动消失 + 单行 nowrap 剪裁
   （MAX_NOTICES=5 / NOTICE_VISIBLE_MS=5000 / ellipsis），无法满足「全部显示 +
   长时间停留 + 持久化保存」的需求。**进行中（des-1）**，设计要点：
   - 按重要性分级：info/success 短暂可自动消失；warning/error 常驻、多行完整
     显示、手动关闭；可固定（pin）不被 FIFO 淘汰
   - 持久化消息提供「查看详情」入口（warning/error 已写 `pidance.activity`，
     当前无 UI 查看入口）
9. **M5 · 持久化消息查看入口**：`pidance.activity` 条目（session-activity-events.ts
   写入）需有 UI 呈现位置，与 M4 联动。
10. **M6 · 通知生命周期与淘汰规则**：FIFO 淘汰只作用于短暂消息，不得挤掉常驻/
    固定消息；reducer（useAgentSession.ts:282-304）需区分消息类型。

### 验收基线

- 阶段 A 完成：subagent 工具结果在 Pidance 与 pi TUI 视觉同源（同一渲染代码）
- M4 完成：warning/error 消息完整多行常驻、可手动关闭、可查看持久化记录；
  info 消息轻量短暂
- 阶段 D 完成：MessageView 无任何 `SUBAGENT_TOOL_NAME` 硬编码

### 开发流程（本计划所有阶段/项必须遵守）

1. **每笔代码修改完成后立即部署**：执行
   `node .agents/skills/pidance-development/scripts/local-deploy.mjs restart`，
   将当前工作区部署为持续测试服务（生产模式，固定 **0.0.0.0:31416**，
   持久 systemd 守护）并报告健康状态；**不得跳过部署直接提交或结束任务**
   （即使小改动、文案改动、重构）。
2. **部署前置**：local-deploy 自动做增量 build（`.next-public` 隔离目录，
   不污染 dev 的 `.next`）；开发期禁止手动 `next build`。
3. **验证**：部署后通过 HTTP 冒烟确认关键路由可达（31416），修改涉及的
   功能手工验证（如 M4 触发 info/warning/error 各类型消息观察行为）。
4. **红线**：不得操作 30141（上游 pi-web）与 31415（正式安装版）；仅纯文档/
   Skill 修改可豁免重启。
5. **高风险只读验证**：使用 `isolated-test.mjs run`（127.0.0.1:31416），
   运行前停止持续测试部署、完成后恢复。

### 当前进度

- **M4 消息显示重设计**：✅ **已完成（des-1，designer lane）**。分级模型
  `tier: "transient" | "important"` + `pinned` + `activityRecord`；info/success
  短暂自动退出（仍可手动关闭），warning/error 常驻多行完整显示、可关闭可固定、
  不被 FIFO 淘汰；新增「已保存活动」历史面板（跨刷新保留，读取
  `pidance.activity`）；服务端实际持久化结果随通知事件返回（`activityRecord`），
  未写入时不再显示无效的「查看保存记录」。
  - 护栏保留：`TRANSIENT_NOTIFY_CONTENT_PREFIXES` 纯提示性 warning 过滤未破坏
    （session-activity-events.ts:112-117）
  - 改动：ChatWindow.tsx / useAgentSession.ts / extension-ui-bridge.ts /
    rpc-manager.ts / types.ts / globals.css / locales（en、zh-CN）/
    extension-ui-bridge.test.mjs
  - 验证：extension-ui-bridge 测试 17/17；tsc --noEmit 通过；ESLint 通过；
    全量 748 项通过；已部署 31416（生产模式，unit active，401 符合 Basic Auth）
  - 建议手动验证清单见 des-1 结果（各类型消息停留/剪裁/固定/淘汰/持久化入口）
- **阶段 A 工具结果渲染桥**：✅ **已完成（fix-1 + des-1）**。`lib/tui-render-bridge.ts`
  （theme 自有副本 lib/pi-themes/dark.json + `renderToolResultLines`/`renderToolCallLines`
  headless 渲染，兼容 dist `ln` 压缩字段）+ rpc-manager 对 tool_call/tool_result/
  tool_execution_update 附加 `renderedCallLines`/`renderedResultLines`/`renderedLines`；
  前端 ToolCallBlock 优先渲染 ANSI 行（回退 SubagentResultCard/diff/文本）。
- **阶段 B setWidget 组件工厂**：✅ **已完成（fix-2 + des-1）**。
  `renderWidgetFactoryLines` + rpc-manager setWidget 工厂分支；ExtensionWidgets
  逐行 ANSI 渲染（pi-subagents async widget 恢复显示）。
- **阶段 C 自定义消息渲染器**：✅ **已完成（fix-3 + des-2）**。
  `renderCustomMessageLines` + rpc-manager message_start/message_end（role=custom）
  附加 renderedLines；CustomMessageView 优先 ANSI 渲染（回退文本/details）。
- **阶段 D SubagentResultCard 降级**：✅ **已完成（确认）**。renderedResultLines
  优先，`SUBAGENT_TOOL_NAME`/parseSubagentResult 保留为回退（MessageView.tsx:925）。
- **集成验证**：✅ tsc 0 错；90 项定向测试通过（render-bridge/tool-execution-buffer/
  MessageView/ChatWindow/rpc-manager/extension-ui-bridge）；git diff --check 通过；
  31416 部署 active（401 符合 Basic Auth）。
- **排障记录（2026-08-04 发送消息失败）**：症状——发送消息无回显、前端卡
  「等待模型...」。根因——pi 的 `_emit` 对 listener **无 try/catch 保护**
  （agent-session.js:285-289），渲染桥 `withRenderedToolLines` 整体无 try/catch，
  内部 `extensionRunner.getToolDefinition`/`getMessageRenderer` 调用在保护之外，
  一旦扩展对象结构异常抛错，wrapper listener 中断整个事件广播循环，SSE 透传
  listener 不再执行。修复——`withRenderedToolLines` 整体包 try/catch（任何异常
  吞掉并返回原事件，渲染桥绝不允许阻断事件流）；另在 prompt catch 增加完整
  堆栈日志（`console.error("[pidance] prompt failed: ...")`）便于后续定位。
  验证——无头浏览器实测发送消息成功（PONG 回复），tsc 0 错、90 项测试通过。
  遗留——日志存在 `better-sqlite3 Module did not self-register` 警告
  （hermes-memory 的 live session indexing 在 Next 打包环境降级失败，console.warn
  级别，不影响发送消息，与渲染桥无关，待独立处理）。
- **排障记录（2026-08-04 新会话创建 500）**：症状——新会话创建后发消息无响应。
  根因——`hooks/useAgentSession.ts` 的 `ensureNewSession` 请求体缺失
  `type: "ensure_session"` 字段（提交 08705ad「P0 收口」误删），服务端
  `createNew` 解构后 `promptCommand` 为空对象 → `session.send({})` →
  `Unsupported command: undefined` 500。定位手段——无头浏览器 Network HAR 抓
  取 `/api/agent/new` 实际请求体（`{cwd, provider, modelId}` 无 type）+ 服务端
  堆栈日志。修复——恢复 `type: "ensure_session"`（保留 08705ad 有意的
  toolNames 删除），注释说明缺失后果。验证——无头浏览器新建会话发消息收到
  回复（PONG）；tsc 0 错、session-service/rpc-manager 测试 31 项通过。
- **oracle 审核修复（2026-08-04，ora-1）**：全量审查 1 P0 + 6 P1 + 4 P2，全部
  修复/记录完毕，结论由「不可提交」转「可提交」。
  - **P0-1**：ToolRenderContext 完整状态——`state`/`lastComponent`/
    `invalidate`/`executionStarted`/`argsComplete` 按 toolCallId 跨事件保持
    （wrapper 实例 Map，tool_execution_end 单删 / agent_end 全清 / destroy 释放）；
    pi-subagents 的 `clearLegacyResultAnimationTimer(context)` 不再必抛
  - **P1-2**：context.cwd 改从 `sessionManager.getHeader()?.cwd` 取真实项目目录
  - **P1-3**：tool_result 结果对象补 `isError`（对齐 AgentToolResult 契约）
  - **P1-4**：notify 不再全量 loadSession——新增 `liveNoticeActivities` 页内
    增量投影，agent_end 后按 requestId 与磁盘活动去重
  - **P1-5**：custom 消息 renderedLines 页面生命周期保留——新纯函数模块
    `lib/custom-rendered-lines.ts`（entryId 优先、身份回退匹配，不写回 .jsonl）
  - **P1-6**：渲染输出上限（500 行 / 4000 字符 / 200KB 总字符，超限回退）+
    tool_execution_update 按 toolCallId 节流（100ms）
  - **P1-7**：setWidget 工厂明确 snapshot-only 定界（注释 + 本文档 M2 描述）
  - **P2-8**：renderToLines 严格验证（混合数组/空数组整体回退）
  - **P2-10**：rpc-manager 测试由源码正则契约改为 11 个真实 wrapper 行为测试
    （注入假 extensionRunner/渲染器：异常隔离、context.state 契约、isError、
    cwd、节流、状态释放、setWidget 失败不污染）
  - **P2-9/11**：入 backlog（notice reducer 单测抽纯逻辑；error 语义色变量）
  - 验证：tsc 0 错；定向 128 项测试通过；无头浏览器回归（新会话收发正常）；
    31416 部署 active
- 其余 M1/M2/M3/M5/M6：随各阶段落地（M1 主题映射=阶段 A 内；M2 事件驱动重渲染
  =snapshot-only 定界（本次审核），动态 widget 待真实插件需求；M3 兼容层=阶段 A 内；
  M5 持久化查看入口=M4 内；M6 淘汰规则=M4 内）。

---

## Backlog（oracle 审核）

### P2-9 · notice reducer 纯逻辑测试

当前 `useAgentSession.ts` 内的 transient / important / pinned 通知状态机尚无独立
单元测试。后续应抽为纯逻辑模块并使用 `node:test` 覆盖以下状态转移：

- info/success 入队、5 秒退出标记与动画完成移除；
- 短暂通知达到上限后的 FIFO 淘汰与 pending 补位；
- warning/error 常驻，不参与短暂通知容量与 FIFO；
- 手动关闭短暂、常驻和 pending 通知；
- important 固定/取消固定，且固定项不被新通知挤掉；
- 多个 exiting、迟到 remove、未知 id 等幂等与边界输入。

### P2-11 · error 独立语义色

当前 warning/error 在 NoticeShelf 共用 `--warning`，错误级别的视觉区分尚不完整。
后续应先在 `globals.css` 为亮色/暗色主题增加统一的 error 语义色变量，再由通知组件
引用；禁止在组件中散落硬编码错误色值。本轮仅记录，不新增颜色变量。

---

## 9. 关键代码位置速查

| 位置 | 内容 |
|------|------|
| `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:122-131` | RPC setWidget 只支持字符串数组 |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1994-1998` | toolRegistry 构建（含扩展工具） |
| `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:2173-2294` | renderCall/renderResult 文档 |
| `node_modules/@earendil-works/pi-coding-agent/docs/tui.md:14-24` | Component 接口 |
| `~/.pi/agent/npm/node_modules/pi-subagents/src/tui/render.ts:1229-1348` | async widget 构建 |
| `~/.pi/agent/npm/node_modules/pi-subagents/src/tui/render.ts:1461` | renderSubagentResult |
| `~/.pi/agent/npm/node_modules/pi-subagents/src/extension/index.ts:131-161` | 结果盒三色重建 |
| `lib/rpc-manager.ts:1122-1250` | createExtensionUiContext（Pidance 自研 UI 上下文） |
| `lib/rpc-manager.ts:166-188` | PLAIN_TEXT_THEME（颜色被剥） |
| `components/MessageView.tsx:766-931` | ToolCallBlock（内置 subagent 卡片） |
| `components/ChatWindow.tsx:831-855` | ExtensionWidgets（字符串 widget） |
| `components/ChatWindow.tsx:928` | renderAnsiLine（ANSI→React） |

---

## 10. Pidance 现有提示框 ↔ pi TUI 部件对应表（调查）

Pidance 当前界面上的所有提示框/信息条，逐一对应到 pi TUI 的哪个显示部件：

| Pidance 提示框（渲染位置） | 信息来源（API/事件） | pi TUI 对应部件 | TUI 中的渲染形态 |
|--------------------------|---------------------|----------------|----------------|
| **NoticeShelf 通知条**（ChatWindow.tsx:857；空态页 / 消息区右上角浮动，info/success/warning/error 四色点 + 圆角胶囊，自动退出动画） | `ctx.ui.notify()` → `extension_ui_request method:"notify"`（warning/error 还经 `pidance.activity` 持久化） | **TUI 聊天流状态行**：`showExtensionNotify`（interactive-mode.js:1891） | 非 error/warning → `showStatus`：**追加到聊天消息流末尾**的一行 dim 文本（连续多条合并为一条，避免刷屏）；warning → `Warning: …`（warning 色一行）；error → `Error: …`（error 色一行） |
| **ExtensionStatusBar 状态条**（ChatWindow.tsx:804；消息列表顶部一排小胶囊，key + 文本） | `ctx.ui.setStatus(key, text)` → `extension_ui_request method:"setStatus"` | **TUI 底栏 footer 状态**：`setExtensionStatus` → `footerDataProvider.setExtensionStatus`（footer-data-provider.js:127，`extensionStatuses` Map） | 渲染在 TUI **底部 footer 栏**（与 git 分支、provider 计数同栏），key→文本 键值对 |
| **ExtensionWidgets 上方面板**（ChatWindow.tsx:831；输入框上方卡片组，key 标题 + 等宽 pre 行） | `ctx.ui.setWidget(key, lines, {placement:"aboveEditor"})` | **TUI 编辑器上方 widget 容器**：`widgetContainerAbove`（interactive-mode.js:282、489；`renderWidgetContainer` 1536-1539） | 编辑器上方固定面板，内容为字符串行或组件工厂渲染 |
| **ExtensionWidgets 下方面板**（ChatWindow.tsx:746） | `ctx.ui.setWidget(key, lines, {placement:"belowEditor"})` | **TUI 编辑器下方 widget 容器**：`widgetContainerBelow`（interactive-mode.js:283、491） | 编辑器下方固定面板 |
| **InlineExtensionCard 内联卡片**（InlineExtensionCard.tsx:158；消息流内 select/confirm/input/editor，含 Other 选项、过期态、响应状态条） | `ctx.ui.select/confirm/input/editor()` → `extension_ui_request method:"select"/"confirm"/"input"/"editor"` | **TUI 模态对话框**（SelectList / confirm / input / editor 组件，键盘焦点模态） | 居中模态窗口 + 键盘导航；Pidance 改为内联卡片（OpenChamber 语义），交互语义保留 |
| **ExtensionCustomPanel 全屏面板**（ChatWindow.tsx:504；绝对定位覆盖层，ANSI 行 + 输入区） | `ctx.ui.custom(factory)` → `extension_ui_request method:"custom"` | **TUI 自定义组件覆盖层**：`showExtensionCustom`（interactive-mode.js:1913，`overlay` 选项控制叠加/替换） | 带键盘焦点的自定义组件，覆盖在现有内容之上 |
| **SubagentResultCard**（MessageView.tsx:915；subagent 工具结果结构化卡片：agent/模型/turns/用量/打开会话） | 工具 `subagent` 的 toolResult `details`（**内置硬编码解析**，非 TUI 通道） | **工具结果块**：`renderResult`（pi-subagents renderSubagentResult） | Box 三色（pending/success/error）+ 状态字形 + 统计行 + 嵌套活动 + session 路径 |
| **ToolCallBlock 通用卡片**（MessageView.tsx:766；所有工具调用的折叠卡片：图标/状态点/命令/耗时/实时输出） | SSE `tool_call`/`tool_result`/`tool_execution` 事件 | **工具调用行**：`renderCall` + **结果块**：`renderResult`（tool-execution.ts 组合，Box 包裹） | 一行工具名+参数摘要；展开后结果区（Box 三色） |
| **⚠ 控制提示卡片**（当前**未实现**，规划中） | pi-subagents 自定义消息 `SUBAGENT_CONTROL_MESSAGE_TYPE` / steering | **TUI 自定义消息渲染器**：`pi.registerMessageRenderer`（SubagentControlNoticeComponent） | 消息流内 ⚠ 边框提示框（accent 边框） |

### 调查要点

1. **Pidance 的「提示框」绝大多数是 `extension_ui_request` 通道的产物**——notify/
   setStatus/setWidget/dialog/custom 五类，全部在 `lib/extension-ui-bridge.ts`
   `applyExtensionUiRequest` 中归约成 UI 状态，再渲染到 ChatWindow 对应槽位。
2. **已桥接**（语义对应 TUI）：notify、setStatus、setWidget(字符串)、dialog、custom。
3. **未桥接**（TUI 有而 Pidance 无）：`registerMessageRenderer`（自定义消息条目）、
   `registerEntryRenderer`（自定义条目）、setWidget **组件工厂**（pi-subagents async
   widget 因此缺失）、工具 `renderResult`（subagent 结果靠内置硬编码兜底）。
4. **位置语义差异**：TUI 的 notify 是「聊天流末尾追加一行」、setStatus 在底栏 footer；
   Pidance 分别呈现为「右上角浮动通知条」与「消息列表顶部状态条」——信息同源、位置平移。

---

## 11. 示意图

渲染效果对比示意图见：`docs/assets/pi-tui-vs-pidance-rendering.html`
（自包含 HTML，浏览器直接打开；左栏 pi TUI 终端效果，右栏 Pidance 映射后效果）。
