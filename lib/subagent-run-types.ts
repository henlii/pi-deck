/**
 * 异步 subagent 可观测性 API 的共享类型（UI 仅 type-only import）。
 * 字段形状对齐 pi-subagents 的 status.json，但做了 UI 友好裁剪。
 */

/** 顶层 run 生命周期状态 */
export type SubagentRunState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "paused"
  | "stopped";

/** 运行模式 */
export type SubagentRunMode = "single" | "parallel" | "chain";

/** 活动/注意力状态（仅 running 时有意义） */
export type SubagentActivityState = "active_long_running" | "needs_attention";

/** token 用量（input/output/total） */
export interface SubagentTokenUsage {
  input: number;
  output: number;
  total: number;
}

/** 单步投影 */
export interface SubagentRunStepView {
  index: number;
  agent: string;
  label?: string;
  status: string;
  model?: string;
  /** 仅作字符串回传，后端不扩大文件 allow-list */
  sessionFile?: string;
  /**
   * 仅当 /api/sessions 已发现对应只读 child（SessionInfo.path 匹配 sessionFile）时附加。
   * UI 仅在 sessionId 与 sessionFile 同时存在时显示「打开会话」，避免假 affordance。
   */
  sessionId?: string;
  error?: string;
  activityState?: SubagentActivityState;
  currentTool?: string;
  recentOutput?: string[];
  tokens?: SubagentTokenUsage;
  costUsd?: number;
  startedAt?: number;
  endedAt?: number;
}

/** 最近事件（来自 events.jsonl 尾部） */
export interface SubagentRunEventView {
  type: string;
  timestamp?: number;
  message?: string;
}

/** 单个异步 run 的 UI 视图 */
export interface SubagentRunView {
  id: string;
  state: SubagentRunState;
  mode: SubagentRunMode;
  activityState?: SubagentActivityState;
  startedAt: number;
  endedAt?: number;
  lastUpdate?: number;
  cwd?: string;
  error?: string;
  currentStep?: number;
  chainStepCount?: number;
  totalTokens?: SubagentTokenUsage;
  totalCostUsd?: number;
  steps: SubagentRunStepView[];
  recentEvents: SubagentRunEventView[];
  /** output 文件尾部文本 */
  outputTail?: string;
  /** 是否因尾部/体积上限截断 */
  outputTruncated?: boolean;
}

/** GET /api/subagent-runs 响应体 */
export interface SubagentRunsResponse {
  runs: SubagentRunView[];
  generatedAt: number;
  rootAvailable: boolean;
}
