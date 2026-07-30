/**
 * 重要非原生事件 → pidance.activity 映射（纯函数）与 best-effort 写入 helper。
 *
 * 仅用于 live AgentSessionWrapper 事件生产边界；不写盘、不启动 AgentSession。
 * 自动持久化由调用方 best-effort 调用 append；映射/append 失败不得阻断原事件。
 *
 * 自动记录范围（仅此）：
 * - prompt_error
 * - extension_error
 * - extension ui.notify 的 warning | error
 *
 * 排除：assistant / toolResult / bashExecution、显式 append_activity、
 * notify info|success|缺省|未知、以及任何其它 SSE 事件。
 */

import type { SessionActivityInput } from "./session-activity";

/** 可自动持久化的 extension ui.notify 类型。 */
export type PersistableNotifyType = "warning" | "error";

/** notify 去重状态：有界 FIFO，仅 remember 成功写入的 id。 */
export type NotifyPersistState = {
  rememberedIds: Set<string>;
  maxIds: number;
};

/** 与 wrapper 默认一致的有界上限。 */
export const DEFAULT_NOTIFY_PERSIST_MAX_IDS = 64;

export type PromptErrorActivitySource = {
  errorMessage: string;
  streamingBehavior?: "steer" | "followUp";
};

export type ExtensionErrorActivitySource = {
  error: string;
  extensionPath?: string;
  event?: string;
};

export type ExtensionNotifyActivitySource = {
  message: string;
  notifyType?: string;
  requestId: string;
};

/**
 * 创建 notify 去重状态（每 wrapper 实例一份；不入 globalThis）。
 */
export function createNotifyPersistState(
  maxIds: number = DEFAULT_NOTIFY_PERSIST_MAX_IDS,
): NotifyPersistState {
  return {
    rememberedIds: new Set<string>(),
    maxIds: Math.max(1, maxIds),
  };
}

/**
 * prompt_error → activity 输入；无稳定 requestId。
 * streamingBehavior 仅在有值时写入 metadata。
 * 超长 content/metadata 不在此截断：交给 normalize fail closed。
 */
export function mapPromptErrorToActivity(
  source: PromptErrorActivitySource,
): SessionActivityInput {
  const input: SessionActivityInput = {
    kind: "error",
    title: "Prompt failed",
    content: source.errorMessage,
    source: "rpc.prompt_error",
  };
  if (source.streamingBehavior !== undefined) {
    input.metadata = { streamingBehavior: source.streamingBehavior };
  }
  return input;
}

/**
 * extension_error → activity 输入。
 * metadata 仅含有界字符串 extensionPath / event（有值才写）。
 * 超长不截断：normalize fail closed。
 */
export function mapExtensionErrorToActivity(
  source: ExtensionErrorActivitySource,
): SessionActivityInput {
  const input: SessionActivityInput = {
    kind: "error",
    title: "Extension error",
    content: source.error,
    source: "extension_error",
  };
  const metadata: Record<string, string> = {};
  if (typeof source.extensionPath === "string" && source.extensionPath.length > 0) {
    metadata.extensionPath = source.extensionPath;
  }
  if (typeof source.event === "string" && source.event.length > 0) {
    metadata.event = source.event;
  }
  if (Object.keys(metadata).length > 0) {
    input.metadata = metadata;
  }
  return input;
}

/**
 * extension ui.notify → activity；仅 warning/error。
 * info / success / 缺省 / 未知 → null（transient，不持久化）。
 */
export function mapExtensionNotifyToActivity(
  source: ExtensionNotifyActivitySource,
): SessionActivityInput | null {
  const notifyType = source.notifyType;
  if (notifyType !== "warning" && notifyType !== "error") {
    return null;
  }
  return {
    kind: notifyType,
    title: notifyType === "warning" ? "Extension warning" : "Extension error",
    content: source.message,
    source: "extension.ui.notify",
    requestId: source.requestId,
    metadata: { notifyType },
  };
}

/**
 * Best-effort 调用 append；任何抛错吞掉，不重试、不递归、不 console 敏感内容。
 * 返回是否成功写入（测试用）。
 */
export function tryAppendActivityBestEffort(
  append: (input: SessionActivityInput) => unknown,
  input: SessionActivityInput | null,
): boolean {
  if (input === null) return false;
  try {
    append(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录已成功持久化的 notify id；超出上限时删最早插入的键（FIFO）。
 * 仅在写入成功后调用；失败不 remember，允许同 id 重试一次路径。
 */
export function rememberPersistedNotifyId(
  state: NotifyPersistState,
  id: string,
): void {
  if (state.rememberedIds.has(id)) return;
  state.rememberedIds.add(id);
  while (state.rememberedIds.size > state.maxIds) {
    const first = state.rememberedIds.values().next().value;
    if (first === undefined) break;
    state.rememberedIds.delete(first);
  }
}

/**
 * notify 自动持久化单一 owner（可测）。
 *
 * 契约：
 * - 仅 warning/error 写入；info/success/缺省 → 不写、不 remember
 * - 同一 requestId 成功写入后二次调用不再写（dedup）
 * - 不同 requestId、同文案 → 各写一次
 * - append 失败不 remember，同 id 可再试；不得无限循环（每次调用最多一次 append）
 * - 映射/normalize 失败 fail closed，返回 false
 *
 * 生产路径每次 notify 现场 randomUUID，同 id 二次通常不发生；
 * 本 owner 仍保证可测的「同 id 只写一次」语义，供重入/测试路径使用。
 */
export function persistExtensionNotify(
  state: NotifyPersistState,
  append: (input: SessionActivityInput) => unknown,
  source: ExtensionNotifyActivitySource,
): boolean {
  const id = source.requestId;
  if (typeof id !== "string" || id.length === 0) return false;
  if (state.rememberedIds.has(id)) return false;

  const mapped = mapExtensionNotifyToActivity(source);
  if (mapped === null) return false;

  const wrote = tryAppendActivityBestEffort(append, mapped);
  if (wrote) {
    rememberPersistedNotifyId(state, id);
  }
  return wrote;
}
