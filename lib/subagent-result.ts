/**
 * 归一化 pi-subagents 持久化在父会话 `subagent` toolResult 里的 `details`
 * （契约见 pi-subagents `src/shared/types.ts` 的 `Details` / `SingleResult`）。
 *
 * 纯函数、只读：不触碰 Pi 会话 schema，也不访问文件系统。形状不匹配时返回
 * `null`，由调用方回退到既有文本渲染。个别子运行损坏时只跳过该条，保留其余
 * 可读信息——与 todo 快照「整体拒绝」相反，因为这里是展示增强而非状态重建。
 */

export type SubagentRunStatus =
  | "ok"
  | "error"
  | "timeout"
  | "interrupted"
  | "stopped"
  | "detached";

export interface SubagentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly turns: number;
}

export interface SubagentRunSummary {
  /** 在 results[] 中的位置，用作稳定 key。 */
  readonly index: number;
  readonly agent?: string;
  readonly task?: string;
  readonly status: SubagentRunStatus;
  readonly model?: string;
  /** 成功模型之前失败的模型（回退链可见性）。 */
  readonly failedModels?: readonly string[];
  readonly usage?: SubagentUsage;
  readonly acceptanceStatus?: string;
  readonly finalOutput?: string;
  readonly error?: string;
  /** 子会话文件绝对路径；用于跳转侧栏已发现的只读子会话。 */
  readonly sessionFile?: string;
  /** 嵌套子运行数量（链式/递归 subagent）。 */
  readonly nestedRuns?: number;
}

export interface SubagentResultSummary {
  readonly mode?: string;
  readonly runId?: string;
  /** 链式运行的 agent 顺序。 */
  readonly chainAgents?: readonly string[];
  readonly runs: readonly SubagentRunSummary[];
  readonly totalUsage?: SubagentUsage;
  readonly totalCost?: number;
  readonly timedOut?: boolean;
  readonly stopped?: boolean;
}

/** pi-subagents 的工具名，父会话中 toolResult.toolName 与之相等。 */
export const SUBAGENT_TOOL_NAME = "subagent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): SubagentUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = readNumber(value.input);
  const output = readNumber(value.output);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: readNumber(value.cacheRead) ?? 0,
    cacheWrite: readNumber(value.cacheWrite) ?? 0,
    cost: readNumber(value.cost) ?? 0,
    turns: readNumber(value.turns) ?? 0,
  };
}

function readStatus(result: Record<string, unknown>): SubagentRunStatus {
  if (result.timedOut === true) return "timeout";
  if (result.stopped === true) return "stopped";
  if (result.interrupted === true) return "interrupted";
  if (result.detached === true) return "detached";
  const exitCode = readNumber(result.exitCode);
  if (readString(result.error) !== undefined || (exitCode !== undefined && exitCode !== 0)) return "error";
  return "ok";
}

/** 本次运行之前尝试过的其它模型；modelAttempts 缺失时回退 attemptedModels。 */
function readFailedModels(result: Record<string, unknown>, model: string | undefined): readonly string[] | undefined {
  const names = Array.isArray(result.modelAttempts)
    ? result.modelAttempts
      .filter((attempt): attempt is Record<string, unknown> => isRecord(attempt) && attempt.success !== true)
      .map((attempt) => readString(attempt.model))
    : Array.isArray(result.attemptedModels)
      ? result.attemptedModels.map((name) => readString(name))
      : null;
  if (names === null) return undefined;
  // 最终生效的模型单独展示，回退链里不重复它。
  const failed = names.filter((name): name is string => name !== undefined && name !== model);
  return failed.length > 0 ? failed : undefined;
}

function readRun(value: unknown, index: number): SubagentRunSummary | null {
  if (!isRecord(value)) return null;
  const model = readString(value.model);
  const acceptance = isRecord(value.acceptance) ? readString(value.acceptance.status) : undefined;
  return {
    index,
    agent: readString(value.agent),
    task: readString(value.task),
    status: readStatus(value),
    model,
    failedModels: readFailedModels(value, model),
    usage: readUsage(value.usage),
    acceptanceStatus: acceptance,
    finalOutput: readString(value.finalOutput),
    error: readString(value.error),
    sessionFile: readString(value.sessionFile),
    nestedRuns: Array.isArray(value.children) && value.children.length > 0 ? value.children.length : undefined,
  };
}

/**
 * `details` 形如 `{ results: SingleResult[] }` 时返回展示模型，否则返回 `null`。
 * 空 `results` 也视为不可展示，交回文本渲染。
 */
export function parseSubagentResult(details: unknown): SubagentResultSummary | null {
  if (!isRecord(details) || !Array.isArray(details.results)) return null;

  const runs: SubagentRunSummary[] = [];
  for (const [index, entry] of details.results.entries()) {
    const run = readRun(entry, index);
    if (run !== null) runs.push(run);
  }
  if (runs.length === 0) return null;

  const chainAgents = Array.isArray(details.chainAgents)
    ? details.chainAgents.map((name) => readString(name)).filter((name): name is string => name !== undefined)
    : undefined;
  const totalCost = isRecord(details.totalCost) ? readNumber(details.totalCost.costUsd) : undefined;

  return {
    mode: readString(details.mode),
    runId: readString(details.runId),
    chainAgents: chainAgents !== undefined && chainAgents.length > 0 ? chainAgents : undefined,
    runs,
    totalUsage: readUsage(details.totalChildUsage),
    totalCost,
    timedOut: details.timedOut === true ? true : undefined,
    stopped: details.stopped === true ? true : undefined,
  };
}
