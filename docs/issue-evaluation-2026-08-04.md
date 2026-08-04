# Open Issue 未完成任务整体评估（2026-08-04）

> 评估对象：`henlii/pidance` 全部 open issue（#4、#9、#14、#15、#16）中未完成的任务。
> 评估方法：逐条目对照当前 `main` 实际代码与 openchamber 源码（本机 `/root/works/open/openchamber`），判定
> 每项「仍适用 / 已过时 / 应合并 / 应废弃 / 保留但降级」。
> 结论来源：oracle 整体评估（2026-08-04）。本文件为评估的权威记录；issue 正文如有出入，以本文件与代码事实为准。

## 总体结论

5 个 open issue 中：

- **真正应优先推进**：`#16 D1` Skills 写安全（P0）、`#9` 正式发布（P1）、`#16 D6` 浏览器交互回归（P1）。
- **应保留但缩小**：`#16` 其余收尾、`#15 D1` 侧栏拆分、`#14` PTY 设计验证。
- **适合合并而非单独实施**：`#4 D3` 克隆当前分支并入会话行管理；`#4 D5` 剩余版本更新提示并入正式发布后的维护能力。
- **大部分应降级或废弃**：`#15` 的整体 OpenChamber 移植、zustand 强制要求、recent/扁平 zones/文件夹等；`#4` 的缓存趋势面板和 web-access 专用浏览器。
- **`#9` 不是"已经发布"**：本地 tgz 交叉部署已完成，但 npm 仍为 404、没有 v0.1.0 tag/GitHub Release，反代也不能据本地未公开包切换。

---

## 一、Issue #4：辅助信息面与低频能力

### D1 缓存命中统计面板 —— 保留但降级 P2

**现状**：会话级即时统计已存在（`hooks/useAgentSession.ts:611-648` 累计 input/output/cache read/write；
`components/AppShell.tsx:998-1078` 顶部缓存 tooltip；`components/SessionInfoPanel.tsx:169-187` 面板展示）。
真正缺失的是 `pi-cache-optimizer-stats.json` 的 provider/model 聚合、命中率与按天趋势——仓库内无该统计文件读取或专用 API/UI。

**openchamber 参考**：只有当前上下文 cache 展示（`ContextSidebarTab.tsx:482-483`）与命中率纯逻辑
（`stores/utils/tokenUtils.ts:61-91`），无历史趋势面板可参考。

**建议**：不按原 D1 直接实施。若确需成本趋势，先确认该扩展统计文件的稳定 schema、更新方式与多项目归属；
当前会话级统计已覆盖最常见需求，历史趋势属低频增强。

### D2 web-access 结果浏览与 curator 链接 —— 保留但降级 P2

**现状**：未发现 `web-search-results` custom entry 专用解析、curator URL 识别或"审阅搜索结果"入口。

**openchamber 参考**：无对应实现（Pi 扩展生态专属能力，openchamber 没有同构参考）。

**建议**：不为一套尚未证明稳定的扩展私有 schema 建通用抽象。收集至少一个真实成功会话文件与 curator URL
输出后再决定：仅增加安全链接识别 / 增加结构化结果卡；若普通 Markdown 链接已足够，D2 直接废弃。

### D3 克隆当前分支为新会话 —— 合并（入 #15 会话行动作，P2）

**现状**：底层能力已具备——用户消息"从此处开始新会话"（`hooks/useSessionCommands.ts:265-294`）、
assistant 回答创建新会话（`useSessionCommands.ts:297-327`）、`create_session_from_leaf` + SDK branched session、
新会话乐观插入侧栏（`components/AppShell.tsx:642-663`）、fork 关系保留（`components/session-tree.ts:37-63`）。
缺失的是会话级"克隆当前 leaf"菜单入口（现有 kebab 仅重命名/复制 ID/导出 HTML/导出 JSONL/删除，
`components/SessionSidebar.tsx:3191-3195`）。

**openchamber 参考**：fork API 与消息级 fork 状态机（`client.ts:1013-1021`、`session-actions.ts:1562-1609`），
但它是"从消息 fork"，不是独立 current-leaf clone；Pidance SessionService 语义更接近需求，不照抄 OpenCode runtime。

**建议**：并入 #15 D3 会话行动作；实现走 SessionService 的 current-leaf branched-session 能力，不在
`rpc-manager` 再造裸文件克隆；只读 subagent 必须禁用；优先级低于安全、发布和测试。

### D4 prompt 模板浏览器 —— 保留但降级 P2

**现状**：斜杠命令列表仅有 name/description/source（`lib/rpc-manager.ts:813-830`、`ChatInput.tsx`），
无模板 Markdown 正文、frontmatter 参数、作用域浏览与 Settings 独立入口。

**openchamber 参考**：Magic Prompts 设置面成熟（`SettingsView.tsx:410`、`useMagicPromptsStore.ts`），
但是 OpenChamber 自有模板与 OpenCode 工作流，**不等同于 Pi `DefaultResourceLoader` 加载的 prompt templates**。

**建议**：参考其"左侧模板列表 + 右侧正文/参数"的信息架构；数据权威必须来自 Pi resource loader；
首版只读；无用户需求前不增加编辑/覆盖/版本迁移。

### D5 版本与更新可见性 —— 大部分完成，剩余 P2

**已完成**：Pidance About 显示版本 + 实际安装 SDK 版本 + GitHub 链接（`components/AboutDialog.tsx:39-78,113-159`、
`app/api/about/route.ts:6-26`、`lib/about-info.ts`）；Plugins 有 installed/configured version 与 update
（`PluginsConfig.tsx:29-32,502-550`）；Skills 有版本/检查更新/update available/执行更新（`SkillsConfig.tsx`）。

**未完成**：Pidance 自身版本更新检查、changelog 摘要、所有扩展包统一"可更新"状态展示。

**openchamber 参考**：`useUpdatePolling.ts:13-45`（启动 3s 后轮询）、`useUpdateStore.ts`——但 openchamber 支持
desktop/mobile/VS Code 自动更新；Pidance 是 npm/Web 部署，只需信息性 npm/GitHub Release 检查。

**建议**：D5 拆分——About/Skills/Plugins 版本展示视为完成；Pidance npm/GitHub 最新版本提示 + changelog 摘要
为 P2，可与 #9 正式发布完成后的维护能力合并（v0.1.0 未公开前做更新检查价值有限）。

---

## 二、Issue #9：v0.1.0 正式发布

### 总体判定：仍适用，P1

- 本地正式安装（`0.1.0-local-9c3fe02-6421a251`，见 `docs/release.md:213-218`）**不是** npm/GitHub 正式发布的替代品
  （`docs/release.md:1-4` 明确"本文不表示任何版本已发布"）。
- npm 官方查询当前返回 404；无 v0.1.0 tag；`gh release list` 无 Pidance Release。
- main 已推进到 `acaeb85`（本地 tgz 之后又有 UI 提交），正式公开制品不能直接把现有本地 tgz 当作最终制品。

### D1 发布前门禁 —— 仍适用（基础设施已完成）

已具备 `release:check`、pre/post 包审计（`package.json:43-53`）、完整发布顺序（`docs/release.md:53-96,98-175`）、
PR #10/#12 与品牌改名；本地部署 tgz 已通过同等级前后审计。但 D1/A1 针对**最终公开发布提交与最终 tgz**，
需在干净隔离 checkout 重新执行，不能引用旧 tgz 结果代替。

### D2 单一制品 npm + GitHub —— 未完成

无官方 npm publish、GitHub v0.1.0 Release、v0.1.0 tag、同一公开 tgz 附件。发布文档规定 npm 与 GitHub 必须
使用同一 tgz（`docs/release.md:17-20,137-164`）。

### D3 正式安装 31415 —— 本地交叉部署完成，正式验收语义未完成

已完成：独立 tgz 安装、31415 正式服务、版本 `0.1.0-local-9c3fe02-6421a251`、关键路由/Basic Auth/bin 仅
pidance 验收（`docs/release.md:182-217`）。未完成：当前安装不是"npm/GitHub 同一公开 v0.1.0 tgz"；
main 后续提交若纳入公开发版需重新 build/审计/安装。按 #9 严格闭环（D2/D3 同一制品）仍需最终再部署验收一次。

### D4 测试部署 31416 —— 完成，issue 正文过时

实际约定不是 issue 所写的 "Next dev"，而是 `.next-public` 隔离构建 + `next start` 生产模式 + systemd 持久守护
（见项目 `AGENTS.md` 端口约定与本地测试部署章节）。**不应回退到 Next dev**；整理 issue 时校正文字即可。

### D5 反代迁移 —— 仍适用，但排在公开发布之后（高风险 P1）

规则：只有正式发布且验收通过的 31415 才能成为反代上游（`AGENTS.md`、`deploy/README.md:218-222`）。
**域名已过时**：issue 写 `deck.namixinxi.cn`，当前 README 使用 `https://pidance.namixinxi.cn`（`README.md:112`）。
操作目标仍适用，但必须以当前 Pidance 域名与现有 Nginx 配置为准。

### D6 发布验证 —— 本地部分完成，公开部分未完成

已完成：31415 本地服务、31416 测试服务、bin 名称隔离、关键路由、30141 治理规则。未完成：npm exact version、
GitHub Release、v0.1.0 tag、同一 tgz/SHA256、公网反代、最终发布前后 30141 状态证据。

### #9 推荐执行顺序

1. 先完成 #16 D1 Skills 写边界（避免把任意路径写能力带进首个公开版本）；
2. 明确首发包含的最终 main 提交；
3. D1 门禁（隔离 checkout 重新执行）；
4. D2 同一 tgz；
5. D3 用最终 tgz 重新安装 31415；
6. npm/GitHub；
7. D5 反代；
8. D6 全面验证。

---

## 三、Issue #14：PTY 交互式终端

### 判定：保留但降级 P2；实施前先做架构 spike

**收益仍成立**：运行交互程序、Ctrl+C、手工操作 dev server/rebase/调试器，与 Agent bash 历史输出语义互补。
Pidance 当前无 PTY/xterm/可写 shell（`package.json:55-64` 无对应运行时依赖）。

**openchamber 有成熟参考**：
- 服务端 `packages/web/server/lib/terminal/runtime.js`：`node-pty`/`bun-pty` 选择（43-53）、会话数/历史/输入/
  空闲超时上限（14-18）、进程组终止 + SIGKILL 兜底（76-103）、session 去重/cwd 绑定/多 session 上限（201-234）、
  二进制 WebSocket 协议（237-269）、Origin/Auth WS 门禁（272-285）、create/resize/restart API（287-329）；
- 前端 `packages/ui/src/components/views/TerminalView.tsx`：多目录/多 tab/生命周期/buffer（47-105）、
  主题/字体/移动端输入/重连（29-45,107-205）。

**不能直接移植**：openchamber 有独立 Express/Node server 直接拿到 HTTP `upgrade` 事件（`runtime.js:272-285`）；
Pidance 是 Next.js Route Handler，**不是稳定持有 WebSocket upgrade 与 PTY 进程的理想 owner**。
另有 `node-pty` native module 与 npm tgz / Next 生产构建打包 / systemd 进程组回收 / Origin-Auth / 多实例 /
输出缓冲内存上限 / 31415-31416 隔离等风险。

**spike 必须先回答**：
1. 是否给 Pidance CLI 增加受控 custom server（同时托管 Next 与 WS）；
2. native module 如何进入 release audit、tgz、`npm install --omit=dev`；
3. 断线立即杀进程还是允许短重连；
4. cwd 需 realpath/symlink/allow-list 二次验证（不能只复制 openchamber 的 stat）；
5. 进程退出与 systemd stop 如何保证整个进程组回收。

**结论**：不是废弃，而是保留 P2，先设计验证，不抢占首发与安全收尾。

---

## 四、Issue #15：OpenChamber 会话体系移植

### 总体判定：原"大规模整体移植"应废弃，拆成少量 P1 架构收尾 + 按需 P2 产品增强

openchamber 的 SessionSidebar 约 1987 行（`SessionSidebar.tsx:1-99`），依赖全局 session/OpenCode stores、
GitHub、归档、通知等；Pidance 使用 Pi `.jsonl` 树与 SessionService，**不能把其 store 拆分方式等同于产品需求**。

### D1 会话列表渲染架构

| 子项 | 判定 | 依据 |
|------|------|------|
| 编排拆分 | **合并入 #16 D5，P1** | SessionSidebar 约 3507 行，持有搜索/偏好/SWR/pending/worktree preload/渲染（`SessionSidebar.tsx:530-694,1249-1314`）；参考 openchamber 职责边界（`SessionSidebar.tsx:23-69`）但不复制其 store |
| recent zone | 保留但降级 P2 | openchamber 有 `deriveRecentSessions`/`showRecentSection`（`useSessionDisplayStore.ts:13-24,50-67`）；Pidance 现有每组 5 条 + Show more（`session-sidebar-state.ts:19-21`）已缓解密度；recent 会造成同一会话双区显示，需处理展开/选中/未读/菜单上下文 |
| 扁平项目 zones | **废弃为默认目标** | 与当前固定 Project→Worktree→Session 语义冲突（`SessionSidebar.tsx:2646-2713`）；openchamber 自身也支持 by-worktree/flat 两种（`useSessionDisplayStore.ts:4-8,50-57`）；若未来做 flat 只应作为可选视图 |
| 单行布局 | 已部分实现，不单独追踪 | standard/compact 模式与状态标记已有 |

### D2 zustand 状态层 / 置顶 / 文件夹 / 多选 / 显示偏好

| 子项 | 判定 | 依据 |
|------|------|------|
| zustand 强制 | **废弃** | 技术手段不是产品需求；Pidance 已有独立 `lib/ui-preferences.ts` seam（1-7,47-76），先按行为/所有权拆分，只有确实无法维护时才选 store 库 |
| 置顶 | 保留但降级 P2 | openchamber 有 `useSessionPinnedStore`（SessionSidebar.tsx:69），价值明确、实现相对独立，但无用户频繁使用证据 |
| 文件夹 | **废弃/无限期暂缓** | 与 Project/Worktree/fork/subagent 四层叠加成第五种层级，需定义 fork 子树移动/搜索/删除/项目边界语义，收益不足 |
| 多选批量删除 | 保留但降级 P2 | 单条删除已完成（`SessionSidebar.tsx:3280-3301`）；批量需处理部分失败/parent-fork 重挂/subagent 级联/当前选中/readOnly 混选 |
| 生命周期排序/项目拖拽/sticky | 保留但降级 P2 | 当前修改时间排序与折叠已可用；不引入一组持久排序状态 |

### D3 会话管理动作 —— 大部分已完成

已完成：重命名、复制 ID、HTML/JSONL 导出、删除、行内确认（`SessionSidebar.tsx:3191-3195,3251-3301`）。
剩余：置顶 P2、文件夹移动废弃、后代计数确认 P2（**注意**：当前删除 route 语义是普通 fork 子会话重挂到
被删会话 parent、验证过的 subagent 后代删除（`app/api/sessions/[id]/route.ts:121-155`），**不能直接复制**
openchamber 的"后代数量=全部级联删除"提示）、多选批量 P2、#4 D3 克隆合并入本条 P2。

### D4 工作树管理 —— 主体已有；全页 surface 降 P2

已有：项目行新建 worktree（`SessionSidebar.tsx:2623-2634`）、非主 worktree 分组与删除（2682-2711）、
`/api/worktrees` GET/POST/DELETE（`app/api/worktrees/route.ts:16-97`）、引导页创建 pending 锁定与成功后目标切换
（`NewSessionGuide.tsx:188-232`）。openchamber 全页 `WorktreesView.tsx:9-41` 本身很薄；分支搜索/创建校验
按具体缺陷补，不整体重写 NewWorktreeDialog。

### D5 会话引导页 selectors —— 已完成

现状已包括 draft target 只记录不创建（`NewSessionGuide.tsx:58-63`）、项目 localStorage SWR（101-128）、
worktree in-flight 去重 + TTL + 持久缓存（93-176）、Project→Worktree 选择（233-299）、新建 worktree pending
与目标切换（188-232,319-361）。已满足 #15 A5 的产品结果；剩余只可能是分支搜索/预设 chips 等锦上添花，
**不能以"源码形态未完整移植"为未完成标准**。

### D6 搜索集成 —— 大部分已有，重做降 P2

已有 meta/fulltext 双模式（`SessionSidebar.tsx:537-550`）、全文 debounce + 迟到响应防护 + FTS/JSONL source
（1249-1300）、`/api/sessions/search`。openchamber 的文件夹/组命中计数依赖其 folder/zones 模型，既然这些
不再是目标，无需移植相应搜索复杂度；仅保留具体可用性改进。

### D7 删减与质量 —— 大部分应废弃

Scheduled/Multi-run/归档/分享/PR/Goal 等从未成为 Pidance 当前实现，不需要"零残留移植审计"；P5 已完成用户侧
死代码清理（`bd7853f`）；性能语义可作为拆分时的回归要求，但不需要翻译全部 memo/store 结构；i18n 键一致性
继续作为普通质量门禁。

---

## 五、Issue #16：会话重构收尾

### D1 Skills PATCH 写边界 —— 确认真实存在，P0

当前 PATCH 直接信任客户端 `filePath`，只检查 `existsSync`，直接 readFileSync/writeFileSync
（`app/api/skills/route.ts:24-31,39-50`），缺失：当前 cwd、loader 权威 skills 列表确认、SKILL.md 约束、
global/project/package 来源可写性、project trust、realpath 根校验、symlink 拒绝、原子写。

可复用能力：GET 已有 loader 权威入口（`lib/skills-service.ts:5-13`）；项目 allow-list/trust 已有
（`lib/project-trust.ts:43-49,85-111,172-180`）。

**修正**：除"同目录临时文件原子替换"外，还应保持项目 CRLF/原 frontmatter 行尾——现代码在 CRLF 文件中插入
固定 LF（`route.ts:42-44`）。即使 middleware 已有 Basic Auth/CSRF，这仍是服务端授权边界错误：被授权用户
也不应能借 skill API 写任意存在文件。

### D2 撤回 RPC 兼容链 —— 适用，P1

UI 已下线但实现仍存在（`lib/rpc-manager.ts:632-725`、globalThis 栈 1289-1298、destroy 清理 930、
`retract-stack` import 34）。P5 计划明确为用户侧下线能力（`docs/chat-refactor-plan.md:146-149,206-210`）。
Pidance 0.1 尚未公开发布，正是删除内部兼容协议的合适时间；删除前做一次外部 API 消费者确认。

### D3 Om/WH 投影 —— 确认仍存在，P1

主会话 GET 计算并返回 `observationalMemory`/`workspaceHistory`（`app/api/sessions/[id]/route.ts:32,62-70`）；
context GET 每次计算并返回（`context/route.ts:2-5,25-34`）；hook 维护类型/state/两处回填/最终返回
（`hooks/useAgentSession.ts:75-77,398-399,688-749,2048`）。ChatWindow 不消费这些字段，OmPanel/
WorkspaceHistoryPanel 已删除（`bd7853f`）。主响应投影确为无消费者成本，应删除；专用 `/api/workspace-history/diff`
未找到 UI 消费者，可退役；删除专用 lib 前确认无外部调用约定；**旧 Pi custom entries 必须保留在 .jsonl，只停止投影**。

### D4 未挂载面板与 toolNames —— 部分适用（修正原表述）

| 子项 | 判定 | 依据 |
|------|------|------|
| SubagentRunsPanel 组件 | 适用 P1 删除 | 无挂载引用（`SubagentRunsPanel.tsx:169-176`） |
| **`/api/subagent-runs` API** | **不可删除**（修正） | SessionSidebar 仍在用（`SessionSidebar.tsx:534-536,754-757`） |
| LensDiagnosticsPanel 组件 + `/api/lens-diagnostics` | 适用 P1 退役 | 仅面板自身调用（`LensDiagnosticsPanel.tsx:245`），无其它 UI 消费者；无外部 API 承诺则可一起删除 |
| toolNames 新会话 preset | 适用 P1/P2 边界清理 | 正常 UI 已不传（`useAgentSession.ts:793`），但 `/api/agent/new` 将任意字段作 command（`route.ts:8-16`）、`createNew` 解构传给启动器（`session-service.ts:235-253`）、启动器仍支持空列表全关/非空收窄（`rpc-manager.ts:1369-1406,1427-1435`） |
| `set_tools` RPC | **单独审计，不误删** | 仍存在（`rpc-manager.ts:842-847`）；是否属兼容 API 单独决定，不与新会话 preset 混删 |

### D5 组件拆分 —— 适用，P1（先建行为门禁再逐段实施）

`useAgentSession.ts` 约 2081 行（返回面 2046-2069）；`SessionSidebar.tsx` 约 3507 行。
openchamber 参考职责切分（`useSessionGrouping`/`useSessionActions`/`useSidebarPersistence`/
`useSessionSearchEffects`/`SidebarProjectsList`/`SessionNodeItem`），但不照搬 zustand/OpenCode 全局同步。

**优先顺序**：先删 Om/WH 与未挂载兼容状态 → 先补 D6 浏览器测试 → 再拆 SessionSidebar 的 row/menu、actions、
worktree preload → `useAgentSession` 保留 SSE/runId/completion claim 在同一个 owner，小步拆。

### D6 浏览器交互回归 —— 适用，P1

`package.json:49` 只有 Node test，无 Playwright/Cypress 项目级入口。最近高风险交互：项目/工作树整行点击折叠
与 stopPropagation（`SessionSidebar.tsx:2558-2633`）、kebab 菜单 focus/Escape（3188-3196）、重命名/删除确认
（3251-3306）、右栏常驻图标与可关面板、pointer capture 调宽、移动端抽屉。纯逻辑测试与 SSR 字符串断言无法覆盖
真实事件冒泡/焦点/pointer capture/localStorage hydration。执行 6–8 个高价值用例，不扩成全产品 E2E。

### D7 架构债校正 —— 部分完成

当前 app/api 无 route import `rpc-manager`（事件 route 走 SessionService，`app/api/agent/[id]/events/route.ts:23-26`），
且已有静态测试固定 5 个 route 不得 import `rpc-manager`（`lib/read-only-routes.test.mjs:180-197`）。
因此：删除 AGENTS.md 中"5 个 route 双 import"的过期债描述仍需做；**新增静态测试已完成，不要重复实现**；
`file-index/route.ts` 下沉 P2；Skills PATCH 下沉由 D1 覆盖。

---

## 六、总表

| Issue / 条目 | 判定 | 优先级 | 处理建议 |
|---|---:|---:|---|
| `#4 D1` 缓存趋势统计 | 保留但降级 | P2 | 已有会话级统计；历史 provider/model/日趋势先验证需求 |
| `#4 D2` web-access/curator | 保留但降级 | P2 | 无 openchamber 同构参考；等真实稳定样本 |
| `#4 D3` current-leaf clone | 应合并 | P2 | 并入缩减后的 #15 D3 会话行动作 |
| `#4 D4` prompt 浏览器 | 仍适用但降级 | P2 | 只读 Pi resource 浏览；不复制 openchamber Magic Prompts schema |
| `#4 D5` 版本/更新 | 部分完成 | P2 | About/插件/Skills 已有；仅保留产品更新与 changelog |
| `#9 D1` 发布门禁 | 仍适用 | P1 | 基础设施完成；最终发布提交需重新执行 |
| `#9 D2` 单一公开制品 | 仍适用 | P1 | npm/GitHub/tag 均未完成 |
| `#9 D3` 31415 | 部分完成 | P1 | 本地安装位已完成；最终公开 tgz 需再安装验收 |
| `#9 D4` 31416 | 已完成，正文过时 | — | 实际为 `.next-public` 生产模式，不是 Next dev |
| `#9 D5` 反代 | 仍适用 | P1 | 公开发布和最终 31415 验收后再做；域名需改为当前 Pidance 域名 |
| `#9 D6` 发布验证 | 部分完成 | P1 | 本地部分完成；npm/GH/tag/公网仍未完成 |
| `#14` PTY | 保留但降级 | P2 | 先做 custom server/WS/native package spike |
| `#15 D1` 拆分 | 应合并 | P1 | 并入 #16 D5 |
| `#15 D1` recent | 保留但降级 | P2 | 当前每组 recent 5 + Show more 已缓解密度 |
| `#15 D1` 扁平 zones | 废弃为硬目标 | — | 与 Pi worktree/fork/subagent 语义不匹配；最多做可选 flat |
| `#15 D2` zustand | 废弃 | — | 技术手段不是产品需求，现有 preferences seam 可用 |
| `#15 D2` 置顶 | 保留但降级 | P2 | 相对独立、可能有价值 |
| `#15 D2` 文件夹 | 废弃/无限期暂缓 | — | 与现有四层语义叠加，复杂度大 |
| `#15 D2/D3` 多选批量 | 保留但降级 | P2 | 需定义部分失败与树删除语义 |
| `#15 D3` 基础菜单 | 已完成 | — | 重命名/ID/双导出/删除已具备 |
| `#15 D4` 全页 Worktrees | 保留但降级 | P2 | 当前行内流程已满足核心需求 |
| `#15 D5` 引导 selectors | 已完成 | — | draft target、SWR、持久化、pending 均已有 |
| `#15 D6` 搜索重做 | 保留但降级 | P2 | meta/fulltext 已有，按具体问题优化 |
| `#15 D7` 整体移植审计 | 废弃 | — | P5 已清理；未移植能力无需"零残留" |
| `#16 D1` Skills 写边界 | 仍适用 | **P0** | 当前确有客户端路径直接写文件问题 |
| `#16 D2` 撤回 RPC | 仍适用 | P1 | UI 已下线，删除兼容状态机 |
| `#16 D3` Om/WH | 仍适用 | P1 | 主 GET/context/hook 无消费者投影应删 |
| `#16 D4` SubagentRunsPanel | 部分适用 | P1 | 删面板，但保留 Sidebar 正在使用的 runs API |
| `#16 D4` Lens 面板/API | 仍适用 | P1 | 无其它消费者，可退役 |
| `#16 D4` toolNames | 仍适用 | P1/P2 | 删除新会话 preset；单独审计 `set_tools` |
| `#16 D5` 组件拆分 | 仍适用 | P1 | 先测试再按稳定 owner 拆 |
| `#16 D6` 浏览器测试 | 仍适用 | P1 | 最近高频 UI 最重要的回归护栏 |
| `#16 D7` 债校正 | 部分完成 | P1 文档 | 双 import 已修且已有测试，只需更新过期文档 |

---

## 七、最终"值得做"清单（10 项）

1. **P0：收紧 Skills PATCH 写边界**——直接消除任意存在路径写入风险；主要风险是误判合法 global/package skill 的可写范围。
2. **P1：完成 v0.1.0 npm + GitHub 单一制品发布**——建立真实公开安装基线；发布不可逆，必须按最终 tgz 双审计执行。
3. **P1：用最终公开 tgz 重验 31415 并再决定反代**——保证公网运行内容与发布物一致；保留回滚与 30141 前后证据。
4. **P1：补 6–8 个浏览器交互回归测试**——直接保护折叠、菜单、右栏、resize、移动抽屉；收益高于继续加 UI。
5. **P1：移除主会话 GET/context/useAgentSession 的 Om/WH 无消费者投影**——减少每次会话加载与类型负担；删除前审计外部消费者。
6. **P1：退役撤回 RPC/globalThis 兼容链**——收敛会话语义并移除额外状态机；风险是未文档化外部调用者。
7. **P1：删除未挂载 Lens/SubagentRuns 面板，但保留侧栏依赖的 subagent-runs API**——减少约千行无 owner UI；避免误删 subagent 运行徽标数据源。
8. **P1：在测试护栏后拆分 SessionSidebar 和 useAgentSession**——降低后续改动回归半径；SSE/runId 与乐观 pending 竞态必须小步拆。
9. **P2：为 PTY 做 custom server/WS/native package 架构 spike**——验证高价值终端能力能否可靠发布；风险最高，不应直接进入实现。
10. **P2：按真实使用反馈选择置顶或 current-leaf clone**——两者是剩余会话增强中收益/复杂度比最好的选项；不要同时引入文件夹、recent、zustand 与批量体系。

---

## 八、对现有 Issue 的调整建议（供后续同步）

- **#16**：D4 表述需修正——subagent-runs API 保留（侧栏在用）；D7 静态测试已完成，仅剩文档校正；D1 补充 frontmatter 行尾保持要求。
- **#15**：改为「精简会话侧栏：拆分编排组件并按需补充高频管理能力」，删除整体移植/zustand/recent/扁平 zones/文件夹/引导页重做等硬范围。
- **#9**：D4 标记完成并校正正文（生产模式而非 Next dev）；D5 域名改为 `pidance.namixinxi.cn`。
- **#14**：保留 open 降 P2，补充"实施前需完成 WS/native package 设计 spike"。
- **#4**：D1/D2 降 P2 待需求验证；D3 并入 #15；D5 拆分标记大部分完成。
