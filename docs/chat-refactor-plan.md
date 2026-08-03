# Pidance 会话系统重构方案（终稿 · Oracle 有条件通过后修订）

> 状态：**P0a 可开工**（Oracle 有条件通过；阻塞项已吸收）  
> 原则：UI 可参考 OC；**会话数据以 Pi 树为准**；不做物理剪枝；无回退坞  

---

## 0. 模型一句话

- Pi **jsonl 内树**保留；主聊天只显示 **当前 leaf 路径**。  
- **分支树** = 唯一旁支切换入口（**exact leaf**，见 §1.2.2）。  
- **从此处分支**（user）：`navigate_tree(userId)` 编辑语义 + **预填**；**发送后**长新枝。  
- **基于此回答分支**（assistant，**选项 B**）：leaf = **turnEnd**（见算法）；**不预填**；发送后长新枝。  
- **开始新会话**：`SessionManager.createBranchedSession` 路径克隆（before user / through turnEnd）；用户侧预填、assistant 侧不预填。  
- 无回退坞、无剪枝、无 pin；工具不限制；package 未装静默降级。

### 0.1 书签

显示用 `label`，方便认节点。**非必须**；UI 可弱化。切换靠树，不靠书签。

### 0.2 Package

保留：子代理侧栏展开、Todo（输入上方）、问答卡。  
去掉：坞、Om/WH、顶栏诊断/runs/标题、tool preset、btw 自定义弹窗协议。

> **决策（P4，2026-08-03）**：btw 无协议基础，跳过自定义实现。外部研究确认 Pi 官方
> 扩展 UI 协议（select/confirm/input/editor/notify/setStatus/setWidget/setTitle）与
> 上游 pi-web 均无 `btw` method；社区 `/btw` 扩展经标准 setWidget/setStatus 展示，
> Pidance 已原生支持（extensionWidgets/extensionStatuses）。不新增私有协议，YAGNI；
> 真实 btw 扩展出现后再按需设计。

### 0.3 阶段

```
P0a  exact leaf 树切换 · 同文件分支（user/assistant）· 去坞（状态+入口）
P0b  线性新会话（SDK createBranchedSession before|through）
P0c  顶栏/package/tool 运行时不收窄
P1   左右分屏
P2   滚动
P3   流式同构 + hooks
P4   块渲染 · 实时输出 · 实命令 · 耗时（btw 已决策跳过，见 §0.2）
P5   回归 · REFACTOR-DEAD
```

---

## 1. 壳层

### 1.1 侧栏

会话树 +（若装 subagent）子会话展开。无顶栏 runs。

### 1.2 顶栏

| 项 | 决策 |
|----|------|
| 分支树 | **保留**，主切换入口 |
| 标题/诊断/runs | 删入口 |
| 导出/系统/会话信息 | 右栏「会话信息」Tab |

### 1.2.2 分支树切换 ≠ 消息「从此处分支」（Oracle Blocker 1）

| 入口 | 语义 |
|------|------|
| 用户「从此处分支」 | `navigate_tree(**user** id)` → Pi：**leaf=parent + editorText**（编辑） |
| 分支树点选 | **`select_leaf_exact(entryId)`** → leaf **精确**落在该 entry（**即使用户叶也不退 parent**） |

- 经 **SessionService** 暴露；内部仍触发 `session_before_tree`，**禁止**静默绕过扩展。  
- **禁止**树点击直接 `navigate_tree(userId)`（会变成又一次「从此处分支」）。

### 1.3 分屏

左聊天固定；右可关 Tab：文件 / diff / 会话信息（含导出）。初装右栏关，之后记住。Todo 在输入上方。

---

## 2. 生命周期

jsonl 树 + live AgentSession；context = leaf 路径。  
新会话不传 preset `toolNames`；退役 `toolNames=[]` 清空 systemPrompt 特殊路径。

---

## 3. 消息与分支

### 3.1 列表

只渲当前路径；P3 live slot。

### 3.2 用户三键

| 键 | 行为 |
|----|------|
| 复制 | 文本 |
| 从此处分支 | await `navigate_tree(userId)`；cancelled 则全不改；成功 **replace 预填**；发送后新枝 |
| 从此处开始新会话 | `createBranchedSession(user.parentId)`（before）；预填该 user；源不动 |

### 3.3 用户「从此处分支」事务（Oracle High 4）

```
busy gate → await navigate_tree(userId)
→ cancelled：不改 leaf UI、不预填
→ 成功：replace 草稿 + load 当前路径
→ 用户发送 → append 新枝
```

禁止 fire-and-forget `handleNavigate`。

### 3.4 用户「开始新会话」

- SDK **`createBranchedSession(parentId)`**（路径克隆、无旁支、设 parentSession）。  
- 首条 user 无 parent → 空新会话 + 预填。  
- **禁止**手写 jsonl 重映射器。

### 3.5 Assistant 三键

| 键 | 行为 |
|----|------|
| 复制回答 | 文本 |
| 基于此回答分支 | `navigate_tree(turnEnd)`；**不预填**；发送后新枝 |
| 基于此回答开始新会话 | `createBranchedSession(turnEnd)` through；**不预填** |

### 3.5.1 turnEnd 算法（选项 B · Oracle Blocker 2）

```
path = 点击瞬间所见 root→leaf 路径
定位 selectedAssistant ∈ path
从 selectedAssistant 向后扫到下一条 role===user 之前
turnEnd = 该范围内最后一条 entry
若无后继 → turnEnd = selectedAssistant
```

覆盖：无 tool、多轮 assistant↔toolResult、最终 assistant、custom_message、路径上 compaction。  
`navigate_tree(turnEnd)` 时 turnEnd **非 user** → Pi 精确设 leaf；context 含本轮工具结果。  
**建议**操作栏只挂**每轮最终回答**。

### 3.5.2 导出截断对齐

| 动作 | SDK leaf 参数 |
|------|----------------|
| 用户开始新会话 | before：`user.parentId` |
| Assistant 开始新会话 | through：`turnEnd` |

现有 rpc `fork` 若是 before-entry，assistant 需 **through-entry** 语义（SessionService 扩展，勿裸写文件）。

### 3.6 无回退坞（Oracle High 5）

停：Dock 挂载、`list_retracted`、retracted 状态、`onRetract`、相关返回字段。  
RPC/globalThis 可 REFACTOR-DEAD 暂留。

### 3.7 Thinking / Tool（P4）

展开→结束折叠；SSE update + terminal buffer；rtk customTools；耗时 tick。

---

## 4–5. 滚动与事件

following/released；runState 以 SSE 为准；透传 tool_execution_update；工具不收窄（UI+运行时）。

---

## 6–10. 输入 / 扩展 / 导出

短扩展内联；导出在会话信息 Tab。（btw 弹窗已决策跳过：无上游协议、标准 widget/status 已覆盖，见 §0.2）

复制到新会话的内容 = 路径上 Pi entry（message/tool/compaction/model…）。  
**不**复制：running 态、队列、usage 快照、未落盘 stream、pending extension UI。  
新会话 systemPrompt **按 cwd/settings 重建**。

---

## 11. 模块

```
lib/turn-end.ts                 # path + assistantId → turnEnd
SessionService.select_leaf_exact
SessionService.createBranchedSession({ mode: before|through, entryId })
hooks/useSessionCommands.ts
BranchNavigator                 # 仅 exact leaf
# 无 session-path-export 裸写；无 session-linearize
```

---

## 12. 验收（含 Assistant）

| 项 | 标准 |
|----|------|
| 用户三键 / assistant 三键 | 文案与预填规则正确 |
| 从此处分支 | cancelled 不预填；发送后 sibling；树可切回 |
| 基于此回答分支 B | 多 tool 轮 turnEnd 正确；context 含 toolResult |
| 两处开始新会话 | SDK 路径克隆；用户预填/assistant 不预填；无旁支 |
| 树点 user 叶 | **停在该 user**，不误编辑 |
| 无坞 | 无 list_retracted / Dock |
| 工具 | 无 preset 收窄 |

---

## 13. 风险

exact leaf 须保留 tree 扩展钩子；through-entry 勿复用错 fork；首条 user 延迟落盘；树 UI 须明显。

---

## 14–16. 死代码 / 不做 / 确认表

REFACTOR-DEAD：坞全链路用户侧、标题/诊断/runs、Om/WH、tool preset、剪枝。  

已确认：树、无坞、B=turnEnd、三+三按钮、预填矩阵、SDK 导出、exact leaf、Todo/导出/右栏。

---

**Oracle 结论：有条件通过 → 本文已吸收 3 Blocker + High 项 → 可启动 P0a。**
