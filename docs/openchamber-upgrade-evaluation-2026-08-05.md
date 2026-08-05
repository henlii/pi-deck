# OpenChamber v1.17.2 → v1.18.1 升级评估

> 评估日期：2026-08-05
> 评估范围：`git log --first-parent v1.17.2..v1.18.1`
> 范围结果：69 个主干提交，tag 对 tag；合并提交按其实际引入内容评估，不展开第二父提交噪音。
> 目标项目：Pidance（Pi `.jsonl` 会话语义，不写入 Pi 原生 session schema）

---

## 1. 结论总览

本区间的大部分提交属于 OpenChamber 特有的 OpenCode 同步层、Electron/VS Code/移动壳、Walkthrough、Relay 和多 runtime 架构，不能直接移植到 Pidance。

真正值得 Pidance 吸收的内容集中在五类：

1. **会话与发送正确性**
   - `77d317b8`：不得把未真正落盘的 prompt 报告为发送成功。
   - `1adeb7b7`：排队消息进入 in-flight 后不得被 composer 再次合并发送；Pidance 不采用相同客户端队列架构，但应做等价竞态审计。
   - `d33cf518`：异步发送必须以服务端确认状态为准；具体目录同步实现不适用，但原则适用。

2. **归档功能**
   - `d3178338`、`e6b73679`、`7935ab8b`、`33f1e5c7`（内部功能提交 `ffbd139c`）形成了一套较完整的归档、运行时门禁、查询边界和恢复语义。
   - Pidance 应采用独立 sidecar，不写 Pi `.jsonl`，并把归档、恢复、永久删除明确分成三种行为。

3. **安全和有界渲染**
   - `3de9be9f`：禁止 assistant Markdown 中的活动 HTML。
   - Pidance 已在 `lib/markdown.ts:20-29` 使用 `rehypeRaw` 后接 `rehypeSanitize`，不是裸渲染；应补安全回归测试，而不是照搬 OpenChamber 实现。
   - `1c27155b`：终端输出展开必须有界，适合作为现有 bash/tool output 路径的审计项。

4. **Git 与 diff**
   - `68d7247a`：diff 刷新应按文件/事件定向失效，避免整个 Git 工作区重载。
   - `5fc61373`：Git 子进程须尊重安全 SSH 配置。
   - 本区间后的 `c9ab916c` 更系统地解决 base branch 推断，应作为独立后续候选。

5. **UI 一致性与性能**
   - `54d24a48`：会话标题不得被裁切到不可辨认。
   - `9753ffdd`：信息型次级按钮应有统一语义样式。
   - 主题颜色提交可作为视觉参考，但不能逐值复制。
   - 本区间后的 `faa9c243` 用静态圆点和低频计时替代持续 spinner，值得 Pidance 单独采用。

### 建议优先级

- **P0**：prompt 落盘确认、归档 sidecar 与恢复、Markdown 安全回归测试。
- **P1**：provider 认证可见性、模型手动覆盖保留、diff 定向刷新、Git base branch、运行状态圆点。
- **P2**：主题校准、info button、上下文面板编号、tablet 布局、输出展开上限和会话标题细节。

### 不建议做的事

- 不要直接拷贝 OpenChamber 的 session store、runtime key、OpenCode `time.archived`、目录 child-store 或 Zustand 同步层。
- 不要把归档状态写入 Pi `.jsonl` header、`session_info` 或自定义 entry。
- 不要为了视觉接近而整体搬运 OpenChamber 组件；两边状态所有权、会话协议、CSS 体系和移动壳差异过大。
- 不要把归档实现成"软删除的另一个名字"；归档必须可恢复，删除仍是不可逆文件操作。

---

## 2. 范围与提交口径说明

69 个 first-parent 提交中包含若干 merge commit。以下表格逐项覆盖 first-parent 主线上的 69 个提交：

- 普通提交直接按该提交评估。
- merge commit 按它引入主干的实际功能评估。
- 用户点名的 `2725c482`、`ffbd139c`、`2ea14335`、`b6a4b746`、`5809f3f3` 位于这些 merge commit 的第二父历史中，虽然不单独占 first-parent 行，但确实包含在 `v1.18.1` 中，正文另行展开。
- `faa9c243`、`c9ab916c`、`8274dd82` 位于 `v1.18.1` 之后，不属于本次 69 个提交；作为补充候选单列，不能计入本区间结论。

分类含义：

- **值得移植**：需求或修复原则与 Pidance 直接相关，应纳入计划。
- **可选**：有价值，但需要 Pidance 原生重做，或优先级低于当前核心正确性。
- **不适用**：依赖 OpenChamber/OpenCode/Electron/VS Code/Relay/Walkthrough 特有架构，或只是发布和文档变更。

---

## 3. 69 个 first-parent 提交全量评估

| # | 提交 | 分类 | Pidance 判定与理由 |
|---:|---|---|---|
| 1 | `ce519219` release v1.18.1 | 不适用 | 仅版本、锁文件和 changelog 发布提交，不承载可移植实现。 |
| 2 | `22d36f83` complete OAuth logins that finish in browser | 可选 | Pidance 已有 OAuth/device-code SSE；应核对"浏览器完成后原页面是否可靠收敛"，但 OpenChamber proxy/UI 实现不能直接复用。 |
| 3 | `2444dd2f` identify outdated walkthrough server HTML | 不适用 | 仅 OpenChamber Walkthrough 服务版本兼容。 |
| 4 | `e815dbb9` stop importance tag reading as review finding | 不适用 | Walkthrough 内容解析问题，Pidance 无对应功能。 |
| 5 | `c81a52d1` merge unexpected walkthrough message handling | 不适用 | 小模型/Walkthrough 消息协议专用。 |
| 6 | `a6ad0e34` merge model override persistence | 值得移植 | 内含 `2ea14335`；应保证用户手动选择的模型不会被 subagent 完成通知或 session 恢复逻辑覆盖。 |
| 7 | `063566cb` merge OAuth-only provider auth fixes | 值得移植 | 内含 `5809f3f3`、`b6a4b746`；provider 未认证时不应展示不可用模型，OAuth-only provider 不应显示 API Key 表单。 |
| 8 | `33f1e5c7` merge restore archived sessions | 值得移植 | 内含 `ffbd139c`；恢复、批量恢复和服务端确认语义是 Pidance 归档设计的核心参考。 |
| 9 | `44b7c177` add selection to chat shortcut | 可选 | 文本选中加入输入框有一定效率价值，但不属于本轮升级核心；Pidance 已有 draft/insert seam，可后续原生实现。 |
| 10 | `77d317b8` stop reporting a dispatched prompt that never landed | 值得移植 | 发送成功必须以 user message 已进入会话为依据，不能只以异步调度接受为依据；Pidance 新建会话首条 prompt 尤其要验证。 |
| 11 | `e257acbb` Linux terminal launcher attribution | 不适用 | Electron Linux 应用发现专用。 |
| 12 | `7f0d87cb` release v1.18.0 | 不适用 | 仅发布元数据和 changelog。 |
| 13 | `1b22bf21` render sessions in newly created worktrees | 可选 | Pidance 已有 worktree preload/refresh seam；可补"运行期间新建 worktree 后会话立即出现"的回归测试，不照搬同步实现。 |
| 14 | `9753ffdd` info button variant | 可选 | 建议为信息型次级动作统一按钮语义，避免各面板自行拼样式；收益偏 UI 一致性。 |
| 15 | `de25fa58` German download label | 不适用 | Pidance 当前只维护中英文，不应因上游单键补丁扩展 locale。 |
| 16 | `e6802123` dark theme color adjustment | 可选 | 可参考暗色背景、边框和选择态层级，但 Pidance 应基于 `globals.css` 现有 token 重新校准，不复制 JSON 色值。 |
| 17 | `f3f1ff13` hide desktop reveal action in browser | 可选 | Pidance 是浏览器应用，应持续避免暴露无后端能力的"在文件管理器显示"等桌面动作；当前无该动作则无需改。 |
| 18 | `733d44fa` self-heal Electron installs | 不适用 | Electron 安装与 postinstall 专用。 |
| 19 | `2489c3fb` directory cache/runtime-key performance merge | 可选 | 内含 `2725c482`；其"render 与 effect pin 之间不得同步淘汰"的原则有价值，但 Pidance 没有同构 child-store，应只对 worktree/session 缓存做压力测试。 |
| 20 | `d96e34a1` drop better-sqlite3 packaging | 不适用 | OpenChamber Electron/依赖打包清理。 |
| 21 | `c290ce6a` stop writing worktree registration into OpenCode storage | 值得移植 | 原则与 Pidance 边界一致：worktree UI 投影不得污染 Pi/OpenCode 原生存储；Pidance 当前设计已遵循，应以测试继续固定。 |
| 22 | `1adeb7b7` stop composer re-sending queued in-flight message | 值得移植 | Pidance 队列由 Pi runtime 管理而非相同客户端 store，不能直接 cherry-pick；仍应做 send/clear/reconcile 并发审计，确保 in-flight 文本不会重复进入 prompt。 |
| 23 | `00c19eb9` lost relay sends are ambiguous | 不适用 | Pidance 无 OpenChamber Relay；若未来有网络代理，应保留"未知结果不能自动重发"的原则。 |
| 24 | `119e7556` normalize DeepSeek timeout quota errors | 不适用 | Pidance 当前没有 OpenChamber quota provider 层；普通模型调用错误不应引入 quota 专用抽象。 |
| 25 | `c8974c29` add DeepSeek quota provider | 不适用 | 产品能力和 provider API 均不对应。 |
| 26 | `85d38db0` Kimi quota provider fixes | 不适用 | 同上，属于 OpenChamber quota 面板。 |
| 27 | `50c69d5a` inherit argv0 path for managed OpenCode | 不适用 | OpenCode managed process/Electron 环境继承专用；Pidance 的 Pi CLI 桥接已有独立 `PI_SUBAGENT_PI_BINARY` 约束。 |
| 28 | `b96b5a74` preserve skill content during rename | 可选 | Pidance skill toggle 已要求只手术式修改 frontmatter；若增加重命名功能，应沿用"保留正文和格式"，当前无需预留。 |
| 29 | `338cec76` changelog entries | 不适用 | 纯文档。 |
| 30 | `4e8fc1d2` Walkthrough language availability | 不适用 | Walkthrough/i18n 专用。 |
| 31 | `0d1a2d9f` preserve managed OpenCode process liveness | 不适用 | Pidance 不管理 OpenCode server；也不得迁入其生命周期模型。 |
| 32 | `2f5677a3` custom OpenAI-compatible providers | 可选 | Pidance 已有 `models.json` 配置和测试接口，功能大体重叠；可借鉴错误 UX 和认证可见性，而非新增第二套 provider 管理。 |
| 33 | `1c27155b` bound terminal output expansion | 值得移植 | 超大 bash/tool output 展开应有行数和字节上限，防 DOM 与内存失控；应审计 `bash-output`、`MessageView` 和延迟下载路径。 |
| 34 | `7c068159` prevent mobile status controls overlap | 可选 | 属于窄屏基础可用性；Pidance 应在 320–430px 做状态行和输入区回归检查。 |
| 35 | `d33cf518` server-confirmed directory and queued-send recovery | 可选 | OpenChamber 多 server/目录同步逻辑不适用；"服务端确认是权威、失败后队列不得卡死"值得用于 Pidance reconcile 测试。 |
| 36 | `a545cf5e` normalize bash ANSI/control codes | 不适用/已具备 | Pidance 已有 `lib/ansi.ts`、`bash-output.ts` 和 terminal adapter；只需保持回归测试，不需重复移植。 |
| 37 | `8797e5f1` terminal viewport/runtime fixes | 不适用 | PTY、bun patch 和 OpenChamber terminal server 专用。 |
| 38 | `716084be` repository-local skills discovery | 不适用/已具备 | Pidance `/api/skills` 已通过 Pi `DefaultResourceLoader` 读取项目 `.agents/skills`，能力已覆盖。 |
| 39 | `773a4cdf` add German locale | 不适用 | Pidance 当前中英文边界明确，完整德语引入成本与收益不匹配。 |
| 40 | `63a29cb0` Linux desktop documentation credit | 不适用 | 纯文档。 |
| 41 | `4de802a0` hide status todo text sooner | 可选 | Pidance Todo 是独立面板/投影；若状态文本会压迫 composer，可借鉴 CSS 时序，但当前无明确缺陷证据。 |
| 42 | `b92456fe` localized Walkthrough generation | 不适用 | Walkthrough 和小模型生成专用。 |
| 43 | `e1dc8d5a` refresh product positioning | 不适用 | OpenChamber 产品文档，不应覆盖 Pidance 产品身份。 |
| 44 | `ba49d633` multi-file patch icon spacing | 可选 | 纯视觉微调；只有在 Pidance 对齐 patch 卡片时顺带处理。 |
| 45 | `34a5c881` context surface icon alignment | 可选 | Pidance 已有右侧工作区 icon rail，可统一图标尺寸和 optical alignment，但优先级低。 |
| 46 | `5fc61373` secure SSH config in Git | 值得移植 | Pidance Git 子进程应尊重用户安全 SSH 配置及自定义 command，不能以简化环境破坏企业仓库连接。 |
| 47 | `ac2d79de` performance changelog | 不适用 | 纯文档。 |
| 48 | `68d7247a` keep diff refreshes targeted | 值得移植 | Git 文件变更只应失效相关 diff/status，避免每个工具事件重抓全部 diff；适合落在 `lib/git-changes.ts` 与右栏状态 owner。 |
| 49 | `fe867cd4` align multi-file patch interactions | 可选 | 可参考逐文件展开、定位和点击行为，但 Pidance 组件结构不同，应重做。 |
| 50 | `0e778c24` simplify walkthrough action label | 不适用 | Walkthrough 文案专用。 |
| 51 | `932dbd69` merge/rebase banner cleanup | 可选 | Pidance Git 面板若展示进行中操作，应采用清晰的状态与继续/中止动作；当前不是升级阻塞项。 |
| 52 | `1bbb451b` bundle chunking optimization | 不适用 | Vite/Bun chunking 配置不适用于 Next.js；不能直接迁移。 |
| 53 | `00fe4779` remove unused delete-worktree options | 不适用 | OpenChamber 旧参数清理；Pidance 删除会话与删除 worktree 已是不同端点。 |
| 54 | `170cf0b6` changelog update | 不适用 | 纯文档。 |
| 55 | `9fbf632f` guard delete actions by default | 值得移植 | 删除必须等待服务端确认、在作用域变化时拒绝迟到结果；Pidance 单 runtime 较简单，但仍应防重复点击、迟到 refresh 和部分批量失败。 |
| 56 | `0b393e5b` widen Android edge swipe zones | 不适用 | Pidance 无 Android 原生壳和对应 edge-swipe 手势。 |
| 57 | `cc40ff9f` QR scan without Play Services | 不适用 | 移动原生连接功能专用。 |
| 58 | `54d24a48` avoid clipping session titles | 值得移植 | 会话标题应保留稳定可辨认区域，并为完整标题提供 title/tooltip；适合检查 compact 与 recent 两种行布局。 |
| 59 | `38a32b41` changelog update | 不适用 | 纯文档。 |
| 60 | `086b6597` correct apply_patch diff path in VS Code | 不适用 | VS Code editor URI/path 映射专用；Pidance 文件链接已有自己的 path encoding seam。 |
| 61 | `7935ab8b` archived-session query boundary | 值得移植 | 归档过滤必须在数据投影边界统一完成，避免 active 与 archived 重叠或重复；Pidance sidecar 设计应直接吸收。 |
| 62 | `e6b73679` guard archive actions by default | 值得移植 | 归档动作应捕获发起时作用域、等待持久层确认后再改 UI，并正确报告部分失败；不采用 OpenChamber runtime key 形式。 |
| 63 | `d3178338` archive runtime guard merge | 值得移植 | 与 `e6b73679` 共同固定"迟到响应不得污染当前视图"；Pidance 应通过服务端权威返回和请求 generation 实现。 |
| 64 | `7adcd0ef` light theme color adjustment | 可选 | 可参考亮色层级和文字对比度，但必须映射到 Pidance 已有 CSS variables。 |
| 65 | `d6848ff7` tablet/foldable layout pass | 可选 | Pidance 当前只有单一 mobile breakpoint；建议单独增加 tablet 验收，不复制 OpenChamber 原生壳与 size-class 代码。 |
| 66 | `2ea828b8` guided AI Walkthrough | 不适用 | 规模大、领域不同且引入小模型/PR/diff 服务；不符合 Pidance 当前 YAGNI。 |
| 67 | `3de9be9f` block active HTML in assistant Markdown | 值得移植（测试） | Pidance 已有 sanitize 链，重点是加入 XSS 回归用例，确认 raw HTML、事件属性、iframe/object/form/style 和危险 URL 均不可执行。 |
| 68 | `1b1a3797` Git session context merge | 可选 | 会话 cwd 驱动 Git 上下文与 Pidance 右栏方向一致；可补 worktree/cwd 路由测试，具体 OpenChamber API 不复用。 |
| 69 | `7bb9b898` dedupe shared worktree ownership | 可选 | Pidance 已将 worktree 解析回主 `projectRoot`；应确认同一路径不会同时归属多个项目，原则可测试固定。 |

---

## 4. 重点提交专项判定

### 4.1 `1adeb7b7`：composer 重发竞态

**判定：值得移植其不变量，不直接移植实现。**

OpenChamber 的问题来源是：

1. 队列条目在 send 完成前仍留在持久队列；
2. auto-send 已发起但尚未 resolve；
3. 此时用户再次 submit，composer 又把整个队列合并到新请求；
4. 相同消息被发送两次。

其修复为队列条目引入仅内存的 in-flight 状态，所有 dispatcher 跳过 in-flight，且 `clearQueue` 不能抢先删除当前 send 用来完成确认的条目。

Pidance 当前队列主要由 Pi `AgentSession` 的 steering/follow-up 队列维护，客户端只投影 `queuedMessages`，没有 OpenChamber 同构的本地持久 queue store，因此不能照搬字段或 store。

仍建议补以下竞态测试：

- running 时提交 follow-up 后立即再次提交；
- follow-up 请求未返回时执行 recall/clear；
- SSE `queue_update` 与 POST 响应乱序；
- reconcile 返回旧 queue snapshot；
- 请求超时但服务端可能已经接受时，不自动重发相同文本；
- 相同文本的两次用户主动提交不得被错误去重。

核心不变量是：**每个发送意图只能有一个 owner；是否可重发不能仅由"客户端队列里还看得见"推断。**

### 4.2 `2725c482`：会话目录缓存抖动

**范围说明：包含在 `v1.18.1`，通过 first-parent merge `2489c3fb` 引入；不单独占 69 行。**

**判定：可选，迁移测试思想而非缓存实现。**

OpenChamber 的故障是 child directory store 在 render 期间被 `ensureChild` 创建，但保护 pin 要等 effect commit 后才建立；同步 eviction 将正在渲染但尚未 pin 的目录淘汰，导致下一次 render 再创建、再 loading、再请求，形成无限循环。

Pidance 的会话目录缓存基于：

- `lib/session-metadata-cache.ts` 的磁盘元数据缓存；
- `lib/session-reader.ts` 的进程内 session list cache；
- `useWorktreePreload`/侧栏派生的项目与 worktree 快照。

它没有相同的"每目录 child store + render 时同步 eviction"结构，因此不应引入 OpenChamber 的 grace window/soft target 抽象。

建议只补压力验证：

- 单项目 50+ worktree；
- 数百会话同时展开；
- 展开期间 session refresh 与 worktree preload 并发；
- 不产生请求循环；
- session refresh 不触发 worktree 全量重抓；
- 缓存超限时允许短暂软溢出，不得淘汰当前可见/正在加载项目。

### 4.3 `77d317b8`：prompt 调度成功但未落地

**判定：P0，值得移植。**

OpenChamber 的 `prompt_async` 在调度后立即返回，而无效 model/agent/variant 可能只在事件流报告失败，最终出现：

- API 返回 `promptDispatched: true`；
- 会话已创建；
- 但 user message 从未进入会话。

Pidance 的 `/api/agent/new` 当前直接调用 `sessionService.createNew()`，路由本身只根据调用是否抛错返回成功，见 `app/api/agent/new/route.ts:8-27`。应确认 `SessionService.createNew` 的成功语义是否已经包含：

1. model/provider/tool 配置校验；
2. `session.prompt()` 已接受；
3. 新 user entry 已写入或至少被 live session 权威状态确认；
4. 首条 prompt 失败时不会留下被 UI 当成已发送的 optimistic bubble；
5. 不会错误清空用户 draft。

建议将"请求已接受"和"首条 user message 已落地"区分为明确状态，UI 只有在后者确认后才移除 draft/optimistic pending。

### 4.4 `119e7556`：配额错误规范化

**判定：当前不适用。**

该提交只修正 DeepSeek quota provider 将特定 timeout 错误归一为统一 quota 错误。Pidance 当前没有独立 quota provider/配额面板，不应为一个未存在的功能引入错误分类层。

如果未来增加配额展示，应统一设计：

- authentication failure；
- provider unavailable；
- timeout；
- rate limit；
- quota exhausted；
- unknown/ambiguous。

在此之前普通模型调用失败继续走现有 AgentSession 错误路径即可。

### 4.5 provider 认证可见性

涉及范围内 merge：

- `063566cb`
- 内部提交 `5809f3f3`
- 内部提交 `b6a4b746`
- 后续补丁 `22d36f83`

**判定：P1，值得移植。**

推荐规则：

1. OAuth-only provider 只显示 Connect/OAuth，不显示 API Key 表单。
2. 支持 API Key 的 provider 才显示 Key 编辑入口。
3. provider 未认证且没有可用环境凭据时，不展示占位模型列表，避免用户选择必然失败的模型。
4. 认证方式还在加载时，不要提前断定其为 API Key provider。
5. OAuth 已在外部浏览器完成时，原设置页必须重新拉取 auth status 和 model registry。
6. 状态接口不得返回原始 key。

Pidance 已有 `/api/auth/*`、`ModelsConfig`、`AuthStorage` 和 `ModelRegistry`，适合在现有边界内实现，不需要复制 OpenChamber provider store。

### 4.6 `e6802123` / `7adcd0ef`：主题颜色

**判定：P2，可选。**

可以参考：

- 暗色下 panel/background 的亮度差应足以表达层级；
- hover 与 selected 不应只靠极小亮度差；
- muted/dim 文字仍须满足可读性；
- light theme 的 border 不应过重；
- accent、error、running、unread 应有不同语义。

不能直接复制 OpenChamber theme JSON，因为 Pidance 当前只有 `--bg`、`--bg-panel`、`--bg-hover`、`--bg-selected`、`--border`、`--text*`、`--accent*` 等 token。应先以 Pidance 现有页面做视觉回归，再调整 token，不要在组件内引入色值。

### 4.7 模型手动覆盖保留

范围内通过 `a6ad0e34` 引入，实际功能提交为 `2ea14335`。

**判定：P1，值得移植。**

OpenChamber 的问题是 subagent 完成后产生的 synthetic prompt 被误判为最新用户模型选择，从而把 agent 默认模型重新写回；切换 agent 时也错误优先使用 agent pin，而非 session 的手动 override。

Pidance 应固定以下优先级：

1. 当前 session 内用户明确选择的 provider/model；
2. session 已持久化的 model change；
3. agent/default 配置；
4. 全局默认模型。

extension 通知、subagent 完成提示、activity、自定义消息均不得被当成用户模型选择。现有 model 恢复、`set_model`、session reload 和 subagent completion 应覆盖同一组测试。

### 4.8 `68d7247a`：diff 性能

**判定：P1，值得移植。**

OpenChamber 将 diff 刷新从广域重载改为：

- 针对被工具修改的文件刷新；
- Git status 与单文件 diff 分离失效；
- 保留滚动锚点；
- Files/Git/Diff 视图只刷新自身需要的数据。

Pidance 当前已有：

- `/api/git/status`
- `/api/git/diff`
- `lib/git-changes.ts`
- 右侧 Files/Git 工作区

建议采用"事件 → 受影响路径集合 → 定向失效"模型，而不是每个 tool result 都重抓全仓 diff。应避免把缓存所有权塞进 `ChatWindow`；由 Git/RightPanel 数据 owner 管理。

### 4.9 `3de9be9f`：HTML 注入防护

**判定：P0 安全验证；现有实现基本具备，不应重复实现。**

Pidance `lib/markdown.ts:20-29` 的插件顺序为：

1. `rehypeRaw`
2. `rehypeSanitize`
3. `rehypeKatex`

并显式 strip `iframe`、`object`、`style`、`form`。这比仅阻止 raw HTML 解析更灵活，但安全性依赖 schema 和插件顺序。

应补用例：

- `<script>`；
- `<img onerror=...>`；
- `<svg onload=...>`；
- `<iframe srcdoc=...>`；
- `<object data=...>`；
- `<form action=...>`；
- `javascript:` / `data:text/html` 链接；
- 混入 Markdown link/image；
- KaTeX 生成节点不被错误剥离；
- FileViewer Markdown preview 与聊天 Markdown 使用一致安全边界。

---

## 5. `v1.18.1` 之后的补充候选

以下提交不属于本次 69 个 first-parent 提交，不能写成"本区间已引入"，但用户点名要求评估。

| 提交 | 范围状态 | 判定 | 理由 |
|---|---|---|---|
| `faa9c243` spinner → 圆点 + turn timer | `v1.18.1` 之后 | P1，值得移植 | 静态 running 圆点比每行持续 spinner 更省重绘；选中会话可显示低频运行时长，折叠父组只显示聚合圆点。 |
| `c9ab916c` Git base branch resolution | `v1.18.1` 之后 | P1，值得移植 | 应从 repo/remote HEAD 解析默认分支，不能猜 `main/master`；还要避开"当前分支与 base 相同"和错误后缀匹配。 |
| `8274dd82` numbered context-panel surfaces | `v1.18.1` 之后 | P2，可选 | Pidance 右侧工作区已有 icon rail，可增加 Ctrl/Cmd+1..9 快捷切换；应由统一 shortcut registry 和 surface 顺序 owner 管理。 |

### `faa9c243` 对 Pidance 的具体建议

Pidance `SessionSidebar.tsx` 已有 `RunningSessionIndicator` 与 `UnreadSessionIndicator`，可在现有 owner 内调整：

- running：静态 accent 圆点；
- unread：静态 info/secondary 圆点；
- 当前可见 session 行右侧显示运行时长；
- 项目/worktree/fork 折叠节点只显示聚合圆点，不显示一个无法代表多个任务的时长；
- ticker 最多 1Hz；
- 不为所有会话各建 interval，使用共享 ticker；
- refresh 后若无法确认真实开始时间，显示"运行中"而不是伪造精确时长。

### `c9ab916c` 对 Pidance 的具体建议

Pidance 当前没有统一 base branch seam，应新增单一 Git 层解析函数，候选顺序建议为：

1. 当前仓库对应 remote 的 symbolic HEAD；
2. `refs/remotes/<remote>/HEAD`；
3. `git remote show`/`ls-remote --symref` 的默认分支；
4. 本地可解析的 `main`；
5. 本地可解析的 `master`；
6. 无可靠结果则返回 null，不伪造分支。

必须验证：

- 当前正位于默认分支时，不拿当前分支与自身做 diff；
- 多 remote；
- remote 名不是 `origin`；
- offline 但本地存在 remote-tracking ref；
- `origin/feature/main` 不能误判为 `main`；
- worktree 与主仓默认分支一致；
- branch 不存在时 UI 明确显示不可比较。

### `8274dd82` 对 Pidance 的具体建议

只在右侧 surface 稳定后实施。编号必须来自用户实际可见顺序，而不是硬编码组件名；隐藏 surface 不占编号。快捷键和 UI 提示要经统一 i18n/shortcut seam，不能散落在 `AppShell`、`RightPanel` 和各面板组件。

---

## 6. 值得移植清单

## P0：正确性与安全

### P0-1 首条 prompt 必须确认落地

来源：`77d317b8`

- 新建 session + 首条 prompt 的成功响应不得只表示 runtime 已创建。
- 必须确认 user entry 已进入 live/disk 权威视图。
- 失败时保留 draft，不留下假的发送成功 bubble。
- model/provider/tool 配置错误应在创建前尽可能校验。
- 异步失败必须能回流为明确错误，而不是永久 pending。

### P0-2 归档与恢复

来源：`d3178338`、`e6b73679`、`7935ab8b`、`33f1e5c7`/`ffbd139c`

- 归档状态独立 sidecar。
- active/archived 在服务端投影边界分开。
- 归档和恢复等待持久层确认。
- 支持单条与批量操作及部分失败。
- 永久删除与归档分离。
- 不写 Pi 原生 schema。

### P0-3 Markdown 活动 HTML 防护回归

来源：`3de9be9f`

- 保留现有 sanitize 实现。
- 增加聊天与文件预览安全测试。
- 所有 raw HTML 入口经过同一安全配置。
- 外部链接继续应用安全协议和 `rel` 约束。

---

## P1：高收益能力

### P1-1 provider 认证可见性

来源：`063566cb`、`5809f3f3`、`b6a4b746`、`22d36f83`

- OAuth-only provider 不显示 API Key。
- 未认证时不展示不可用模型。
- 外部 OAuth 完成后自动重新确认状态。
- 认证状态和模型列表的加载/失败态分离。

### P1-2 模型手动覆盖保留

来源：`a6ad0e34`/`2ea14335`

- synthetic/subagent/activity 消息不得覆盖用户模型选择。
- session override 优先于 agent/global default。
- reload、fork、subagent completion 均覆盖测试。

### P1-3 diff 定向刷新

来源：`68d7247a`

- 单文件修改只失效对应 diff。
- Git status 与 diff 分开缓存。
- 保留滚动锚点。
- 避免工具事件触发全仓 diff。

### P1-4 Git base branch 解析

来源：范围外 `c9ab916c`

- 从仓库实际引用解析，不猜名称。
- 支持多 remote、offline 和 worktree。
- 无可靠结果时显式空态。

### P1-5 running spinner 改静态圆点

来源：范围外 `faa9c243`

- 减少持续动画和 compositor 活动。
- 共享 1Hz ticker。
- 运行、未读使用不同语义。
- 折叠组只显示聚合状态。

---

## P2：体验和稳健性

### P2-1 终端/tool output 有界展开

来源：`1c27155b`

- 默认展示有界 preview。
- 超限后显式"展开更多/下载"。
- 不一次性挂载超大 DOM。
- 与已有 bash output download seam 复用。

### P2-2 主题颜色校准

来源：`e6802123`、`7adcd0ef`

- 基于 Pidance token 调整。
- 覆盖 light/dark、hover、selected、muted、error、running。
- 不复制组件级色值。

### P2-3 info button 统一变体

来源：`9753ffdd`

- 统一非主要、非危险、信息型动作。
- 避免各组件内联拼装 hover/border/color。

### P2-4 tablet 响应式布局

来源：`d6848ff7`

- 增加 tablet size class 或至少双断点。
- 验证 600–1024px、横竖屏和触摸目标。
- 不引入 OpenChamber 原生移动壳代码。

### P2-5 上下文面板编号切换

来源：范围外 `8274dd82`

- Ctrl/Cmd+1..9 按可见顺序切换。
- 统一 shortcut registry。
- 长按 modifier 的数字提示属于可选增强。

---

# 7. Pidance 归档功能 D/A 规格

## 7.1 设计目标

归档用于从日常会话列表移除低频历史会话，同时完整保留 Pi `.jsonl` 文件和会话关系，之后可以无损恢复。

归档不是：

- 删除文件；
- 修改 Pi session header；
- 追加自定义 Pi entry；
- 重命名或搬迁 `.jsonl`；
- 改写 `parentSession`；
- 修改 fork/subagent 关系；
- 用 localStorage 隐藏某一浏览器里的行。

归档状态必须是 Pidance 自己的、服务端权威的元数据。

---

## D1. 归档状态存储

采用 agent 级独立 sidecar 目录：

```text
~/.pi/agent/pidance-archive/
  <session-id>.json
```

单条记录建议形状：

```json
{
  "version": 1,
  "sessionId": "uuid",
  "sessionPath": "/absolute/path/to/session.jsonl",
  "archivedAt": "2026-08-05T12:34:56.789Z"
}
```

### 设计理由

1. **不写 Pi 原生 schema**：符合仓库对 todos、UI 偏好和只读投影的边界要求。
2. **不能只用 localStorage**：归档必须在不同浏览器、刷新、31415/31416 进程之间一致。
3. **每会话单文件优于一个大 JSON**：
   - 不同进程归档不同会话时不会覆盖整表；
   - 单记录可使用同目录临时文件 + rename 原子替换；
   - 单个损坏记录可跳过，不拖垮全部归档；
   - 删除/恢复单个会话无需重写全局文件。
4. **记录 path 用于校验，不把 path 当唯一身份**：
   - 主键为 session id；
   - 读取时必须验证目标文件存在、非 symlink 且 header id 匹配；
   - path 变化后可通过 `resolveSessionPath(id)` 修复记录。
5. **记录文件不得影响 Pi 会话扫描**：放在 sessions 目录之外。

### IO 与安全规则

- sidecar 目录只允许普通目录，不跟随 symlink。
- 记录读取设置单文件字节上限。
- JSON 损坏安全跳过并记录诊断，不导致 `/api/sessions` 500。
- 写入使用临时文件、flush/close、原子 rename。
- 临时文件与目标文件必须同目录。
- 文件名只允许规范 UUID/session id 字符集。
- 服务端确认 sidecar 已写入后，客户端才把会话移入 archived 区。
- 多实例对同一 session 的 archive/restore 应通过 session-id 级锁或 compare-and-confirm 串行化。
- sidecar orphan 不应自动删除真实会话；仅在明确维护/GC 中清理不存在且无法解析的记录。

---

## D2. 服务层与 API

归档逻辑应落在 seam 1，即 `lib/session-service.ts` 或其下层专用模块，例如 `lib/session-archive.ts`；Route Handler 只做参数校验和响应映射。

建议接口：

```text
POST   /api/sessions/[id]/archive
DELETE /api/sessions/[id]/archive
GET    /api/sessions?scope=active
GET    /api/sessions?scope=archived
GET    /api/sessions?scope=all
```

也可由现有 `/api/sessions` 一次返回 active/archived 两个数组，但不建议让每个客户端组件自行读取 sidecar 和分组。

服务层建议能力：

```ts
archiveSession(id)
restoreSession(id)
archiveSessions(ids)
restoreSessions(ids)
partitionSessionsByArchiveState(sessions, archiveIndex)
removeArchiveRecordAfterPermanentDelete(id)
```

### 动作语义

- `archiveSession`：
  1. 解析 session；
  2. 拒绝只读 subagent；
  3. 验证 `.jsonl` header id；
  4. 原子写 sidecar；
  5. 失效 session list/客户端 SWR；
  6. 返回服务端确认后的 `archivedAt`。

- `restoreSession`：
  1. 验证记录和真实 session；
  2. 删除 sidecar；
  3. 确认记录已不存在；
  4. 失效列表缓存；
  5. 返回恢复后的 `SessionInfo`。

- 批量动作：
  - 顺序或受限并发执行；
  - 返回 `{ succeededIds, failed: [{ id, error }] }`；
  - 单条失败不回滚已经成功的其他条目；
  - UI 必须准确显示部分成功。

### 与 live wrapper 的关系

归档不必销毁 `AgentSessionWrapper`，但应限制行为：

- 正在运行的会话默认禁止归档，返回 `409`；
- 不自动 abort 当前运行；
- 已打开但 idle 的会话可归档；
- 归档成功后当前聊天进入"已归档，只读浏览"状态，显示恢复按钮；
- 恢复后才重新启用 composer；
- 如果选择更简单的首版，也可以归档成功后清空当前 selection，但不能让已归档会话继续发送而仍留在 Archive。

---

## D3. 会话列表与树投影

服务端内部的"全部真实会话"仍必须包含归档会话，因为：

- archived viewer 需要解析文件；
- file allow-list 不能因归档而意外拒绝会话相关路径；
- fork/subagent 关系投影可能引用归档祖先；
- 永久删除和恢复需要定位文件。

面向普通侧栏的 active 投影才排除归档会话。

### 普通列表

- 默认只展示 active session。
- project/worktree 的会话数量只统计 active。
- 一个项目只有归档会话时，普通项目区默认不因归档记录保持展开。
- 已归档 parent 的 active fork child 仍显示，按现有缺失祖先降级规则提升到可见层级。
- 归档不得改写 child 的 `parentSession`。

### Archive 列表

参考 OpenChamber `ArchiveView.tsx:26-273` 的结构，但采用 Pidance 原生实现：

- 左侧/上方按 Project → Worktree 分组或筛选；
- 右侧显示归档会话；
- 默认按 `archivedAt` 降序；
- 行显示标题、项目/工作树、归档日期；
- 行动作：恢复、永久删除；
- 支持每批 100 条或虚拟列表；
- 支持项目级"永久删除全部"，必须二次确认；
- archived session 可打开只读浏览。

---

## D4. 搜索、最近区和命令面板

### 元数据搜索

- 普通侧栏搜索默认只搜索 active。
- Archive 页面搜索只搜索 archived。
- 不提供一个含糊的混合结果列表。
- 如命令面板需要跨域搜索，结果必须明确标记"已归档"，选择后进入只读 archived view。

### 全文搜索

- FTS/JSONL 索引可以继续包含全部真实会话。
- 查询入口必须传明确 scope：`active | archived | all`。
- 默认 scope 为 active。
- Archive 页面使用 archived。
- 如果现有索引没有归档字段，可先查 session ids，再在服务层按 sidecar 过滤；不要把归档状态写回 `.jsonl`。

### 最近会话

Pidance `deriveRecentSessions` 位于 `components/session-sidebar-state.ts:212-239`。应增加归档排除规则：

- archived session 永不进入 Recent；
- 归档后立即从 Recent 消失；
- 恢复后按原 `modified` 重新参与 Recent；
- 恢复行为本身不修改 `.jsonl`，因此不应把 `archivedAt` 当聊天活动时间；
- 如果恢复后旧会话不够新，不应仅因"刚恢复"强行置顶。

### 命令面板

- 默认会话搜索仅 active。
- 增加"打开归档"动作。
- 可选增加 `Archive current session` / `Restore current session`。
- 永久删除不应放进无确认的快捷命令。

---

## D5. 统计语义

必须区分以下统计：

| 统计 | 默认是否包含归档 |
|---|---|
| 当前会话 token/cost/message stats | 打开 archived session 时仍可查看 |
| 普通项目会话数 | 否 |
| Recent 数量 | 否 |
| 搜索 active 命中数 | 否 |
| Archive 总数 | 仅归档 |
| 全部磁盘会话总数 | 是，但必须明确标注"含归档" |
| running 会话数 | 不应存在归档 running；归档 running 被拒绝 |
| subagent 运行统计 | 不因父会话归档而改写历史数据 |

归档不能改变会话原始：

- `created`
- `modified`
- `messageCount`
- token/cost
- fork parent
- subagent relation

`archivedAt` 只用于 Archive 列表排序与显示。

---

## D6. 恢复流程

单会话恢复：

1. 用户在 Archive 行、只读会话顶部或上下文菜单点击"恢复"。
2. UI 进入 pending，禁止重复点击。
3. 服务端验证 sidecar 与 `.jsonl`。
4. 服务端删除 sidecar 并确认删除完成。
5. 失效：
   - session list cache；
   - 客户端 localStorage SWR；
   - Archive 查询；
   - active 查询；
   - 搜索 scope 投影。
6. 服务端返回恢复后的 `SessionInfo`。
7. UI 从 Archive 移除，插入 active project/worktree。
8. 若当前正打开该 session，退出只读状态并恢复 composer。
9. 不修改会话 `modified`，不自动选中或滚动到 Recent 顶部。

批量恢复与 OpenChamber 一样保留部分结果：成功的立即恢复，失败项留在 Archive 并显示原因。

---

## D7. UI 落点

### 桌面侧栏

建议在侧栏顶部显示控制区增加 Archive 图标按钮，与搜索和显示选项同级：

- 带 archived 总数 badge；
- 点击进入主内容区 Archive 页面；
- 不把全部 archived rows 塞进普通项目树底部，避免长列表拖慢日常侧栏。

### 会话行菜单

active session：

- Rename
- Export
- Archive
- Delete permanently

archived session：

- Open read-only
- Restore
- Export
- Delete permanently

"Archive"和"Delete permanently"不得相邻且使用同一视觉权重；删除保持 destructive 样式和确认。

### 当前会话

已归档会话顶部显示明显但不遮挡内容的状态条：

> 此会话已归档。恢复后可继续发送消息。

动作：

- 恢复
- 永久删除
- 返回归档列表

### 移动端

- Archive 作为会话抽屉中的独立入口。
- Archive 页面使用单列结构：搜索、项目筛选下拉、会话列表。
- 行动作放入 overflow menu，避免恢复和删除按钮重叠。
- 触摸目标至少 40–44px。

---

## D8. 与删除语义的关系

| 动作 | `.jsonl` | sidecar | fork child | subagent 文件 | 可恢复 |
|---|---|---|---|---|---|
| 归档 | 保留 | 创建 | 不改写 | 保留 | 是 |
| 恢复 | 保留 | 删除 | 不改写 | 保留 | 已恢复 |
| 永久删除 | 删除 | 同步删除 | 按现有规则 reparent | 按现有验证规则清理 | 否 |

关键规则：

1. 归档不是删除前的自动步骤。
2. 普通 active session 也可直接永久删除，但必须保持现有确认。
3. 从 Archive 永久删除时复用现有 DELETE 语义，不复制第二套文件删除实现。
4. DELETE 成功后必须清理对应 sidecar。
5. DELETE 失败时 sidecar 保留，会话继续出现在 Archive。
6. 仅删除 sidecar 不能被当成永久删除。
7. archived parent 被永久删除时，继续执行当前 `app/api/sessions/[id]/route.ts:126-153` 的 direct child reparent 与验证过的 subagent 清理。
8. 归档时绝不执行 reparent，因为恢复后必须无损回到原树。

---

## 7.2 归档验收标准

### A1. 持久化与 schema 边界

归档一个普通 session 后：

- 原 `.jsonl` 字节内容不变；
- 不新增 Pi entry；
- `parentSession` 不变；
- `~/.pi/agent/pidance-archive/<id>.json` 原子生成；
- 刷新浏览器和重启 Pidance 后归档状态仍存在。

### A2. 列表、搜索与最近区

归档后，该 session：

- 立即从普通项目树和 Recent 消失；
- 不出现在默认元数据搜索、全文搜索和命令面板 active 结果；
- 出现在 Archive 页面；
- Archive 中按 `archivedAt` 排序；
- 项目 active 会话数同步减少；
- 全部磁盘会话统计仍可明确包含它。

### A3. 恢复

恢复 archived session 后：

- sidecar 被删除；
- `.jsonl` 内容仍不变；
- session 回到原 project/worktree；
- fork/subagent 关系恢复为原投影；
- 不因恢复改写 `modified`；
- 当前打开该会话时 composer 重新可用；
- 刷新后仍保持 active。

### A4. 删除语义

从 Archive 永久删除时：

- 必须二次确认；
- 复用现有 DELETE 服务；
- `.jsonl` 与 sidecar 都被清理；
- child reparent 和 subagent 安全删除规则与 active 删除一致；
- 删除失败时 session 仍留在 Archive，不能只清 sidecar。

### A5. 并发与部分失败

- 重复点击 archive/restore 不产生重复记录或假成功。
- 31415 与 31416 同时操作同一 session 时，最终状态与服务端确认一致。
- 批量归档/恢复中单条失败不回滚其他成功条目。
- UI 准确显示成功数、失败数和失败项。
- 迟到响应不得把用户已经恢复的会话再次移入 Archive，反之亦然。

### A6. 运行中与只读会话

- running session 归档返回 `409`，不自动 abort。
- 持久化 subagent/read-only session 默认不可单独归档。
- archived session 可查看消息、文件引用和统计，但不能发送、fork、navigate 写操作或修改设置。
- 恢复成功后写能力按原 session 权限恢复。

### A7. 损坏与安全降级

- sidecar JSON 损坏、超限、symlink、path/header id 不一致时安全跳过，不导致列表 500。
- 损坏记录不得隐藏一个正常 active session。
- orphan sidecar 不得删除任何 `.jsonl`。
- Archive 页面能显示诊断性空态或忽略计数，但不泄露越权路径。

---

# 8. UI 对齐建议

## 8.1 OpenChamber v1.18.1 关键界面结构

OpenChamber 当前主要结构为：

1. **全局会话侧栏**
   - Recent；
   - project/worktree/session 层级；
   - 搜索、分页/批量操作；
   - archived 独立入口；
   - 运行、未读、文件夹等状态。

2. **主内容 surface**
   - Chat；
   - Archive；
   - Walkthrough；
   - Settings 等整页 surface。

3. **右侧 Context Panel**
   - 独立 icon rail；
   - Files、Git、Diff、Terminal、PR、Walkthrough 等 surface；
   - surface 顺序和快捷键统一注册。

4. **聊天 composer**
   - queued message；
   - model/agent 控件；
   - 多状态动作；
   - terminal/tool output 与 diff 联动。

5. **移动与 tablet**
   - 独立移动应用 shell；
   - session sheet、workspace drawer、fullscreen surface；
   - tablet/foldable size class；
   - 原生硬件键盘和平台 chrome 适配。

6. **ArchiveView**
   - 独立主页面；
   - 左侧目录筛选；
   - 全局标题搜索；
   - 分批渲染；
   - 恢复和永久删除；
   - archived count。

---

## 8.2 Pidance 当前结构

Pidance 已有相当一部分结构性对齐：

- `AppShell.tsx` 是整体布局 owner；
- 左侧 `SessionSidebar` 已有 Project → Worktree → Session → child；
- 已有 Recent、元数据搜索和全文搜索；
- 已有可调侧栏；
- 右侧已有 `RightPanel` 与 `SessionInfoPanel`；
- 文件预览/编辑与右侧导航已经分离；
- 已有 command palette；
- 已有移动抽屉；
- 已有 branch navigator、todo、subagent、memory、diagnostics 等 Pi 原生增值面板；
- Markdown 已有 sanitize；
- 会话列表已有磁盘元数据缓存与客户端 SWR。

主要差异：

| 维度 | OpenChamber v1.18.1 | Pidance 现状 | 建议 |
|---|---|---|---|
| 归档 | 独立 Archive page、恢复、批量操作 | 无归档 | 新增 Pidance sidecar + 独立 Archive surface |
| 主 surface registry | 较统一 | AppShell 中仍有较多显式状态 | 暂不大重构，只为 Archive 增加最小主页面状态 |
| 右侧 surface | registry + icon rail | 已有 RightPanel，但统一注册程度较低 | 后续小步统一，不为编号快捷键先重写 |
| 会话状态 | running/unread/计时较完整 | running/unread 已有，计时较弱 | 采用静态圆点；计时可 P1 后续 |
| Provider UX | 认证方式驱动可见性 | auth/model 已有但页面逻辑需核对 | 先修可见性，不复制 provider store |
| Model override | 明确区分用户选择和 synthetic message | 需审计 subagent/reload | 增加纯逻辑优先级和测试 |
| Git base branch | 后续版本已有仓库级解析 | 尚无统一 seam | 增加 Git 层解析函数 |
| tablet | 独立 size class | 主要 mobile/desktop 二分 | 增加中间断点和验收 |
| 主题 | JSON theme 系统较完整 | CSS variables 较少但边界清晰 | 保持 Pidance token 简单化 |
| 组件样式 | shared variants/Tailwind 较统一 | 较多 inline style | 新功能优先复用现有组件，逐步收敛，不全量翻修 |

---

## 8.3 "参考重做"还是"拷贝适配"

**结论：参考重做，不建议拷贝适配。**

### 原因

1. **会话协议不同**
   - OpenChamber 依赖 OpenCode session API 和 `time.archived`。
   - Pidance 以 Pi `.jsonl` 为权威，且明确禁止写入自定义原生 schema。

2. **状态架构不同**
   - OpenChamber 大量使用 Zustand global/live directory stores、runtime key 和 sync reducer。
   - Pidance 以 Next Route Handler、`SessionService`、磁盘扫描缓存、React owner 和 SSE 为核心。

3. **组件体系不同**
   - OpenChamber 的 `ArchiveView` 使用自身 Icon、Tooltip、Button、toast、surface/store。
   - Pidance 有自己的 CSS variables、i18n、sidebar model、AppShell 和 API 层。

4. **移动端边界不同**
   - OpenChamber 同时服务 Electron、VS Code、Android/iOS 和 browser。
   - Pidance 当前是 Web 产品，不应复制原生壳条件分支。

5. **直接拷贝会引入隐性依赖**
   - `ArchiveView.tsx` 看似只有 273 行，实际依赖 global session store、session UI store、directory store、events、surface 状态和 OpenCode archive 字段。
   - 适配成本接近重写，且更难维护。

### 可以参考的部分

- Archive 页面信息架构；
- directory/project filter + session list 双栏布局；
- 100 条分批展示；
- restore/delete 行动作；
- server-confirmed action；
- 批量部分失败反馈；
- active/archived 查询边界；
- running/unread 圆点语义；
- context surface icon rail 的编号提示。

### 不应复制的部分

- `time.archived = 0` 恢复 sentinel；
- OpenCode inclusive archived query；
- runtime key；
- Zustand global/live store reconciliation；
- OpenChamber Tailwind class；
- mobile native shell；
- OpenCode directory resolution；
- archive 前 review metadata cleanup。

---

## 8.4 工作量量级

以下为熟悉 Pidance 现有架构的单人净开发量级，不含发布流程和跨设备人工回归等待。

| 项目 | 量级 | 估算 |
|---|---:|---:|
| Prompt 落地确认与竞态测试 | 小至中 | 1–2.5 人日 |
| Markdown 安全回归测试 | 小 | 0.5–1 人日 |
| Provider 认证可见性 | 中 | 1.5–3 人日 |
| 模型 override 保留 | 中 | 1.5–3 人日 |
| Diff 定向刷新 | 中 | 2–4 人日 |
| Git base branch 解析 | 中 | 2–4 人日 |
| spinner → 圆点 | 小 | 0.5–1.5 人日 |
| info button + 主题微调 | 小至中 | 1–3 人日 |
| tablet 布局验收与修补 | 中 | 2–5 人日 |
| 上下文面板编号快捷键 | 中 | 2–4 人日 |
| 归档首版：sidecar/API/列表/恢复/删除 | 中至大 | 5–8 人日 |
| 归档完善：批量、全文搜索 scope、并发、移动端 | 中 | 3–6 人日 |
| 整体 UI 参考重做（不含功能新增） | 大 | 10–20 人日 |
| 直接复制 OpenChamber UI 后适配 | 表面中、实际大 | 预计 15–30 人日且维护风险更高 |

### 推荐实施顺序

1. Prompt 落地确认与 Markdown 安全测试。
2. 归档服务层、sidecar 和 active/archived 查询边界。
3. Archive 桌面页面、恢复和永久删除。
4. Recent、搜索、统计、命令面板 scope。
5. 批量归档/恢复与移动端。
6. Provider 可见性和模型 override。
7. Diff/base branch。
8. 圆点、主题、info button、tablet 和编号快捷键。

---

# 9. 最终建议

Pidance 不应把这次升级理解为"同步 OpenChamber 69 个提交"，而应提炼为以下五个原生改造：

1. **发送成功以会话落盘/权威 live 状态为准。**
2. **归档使用 Pidance sidecar，完整保留 Pi `.jsonl`。**
3. **active、archived、recent、search 和统计在服务投影边界统一分流。**
4. **对 Markdown、terminal output、diff 刷新和 Git base branch 做安全与性能加固。**
5. **UI 参考 OpenChamber 的信息架构，但基于 Pidance 现有 AppShell、SessionService、RightPanel、i18n 和 CSS token 重做。**

其中归档是本轮最值得投入的新增能力；它与 Pidance 现有会话列表缓存、Recent、全文搜索、fork/subagent 树和永久删除都有交叉，必须先把 sidecar 与投影边界设计正确，再实现 UI。直接从 `ArchiveView.tsx` 开始复制会把状态语义放错层，后续返工概率高。
