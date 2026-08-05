import type { AgentMessage } from "./types";

export type FailedSendRecovery = {
  messages: AgentMessage[];
  /** 已消费的乐观 key（恒 null：调用方同步清空 ref）。 */
  optimisticKey: null;
  /** 消息未确认进入权威视图 → 调用方应恢复 draft 文本到输入框。 */
  restoreDraft: boolean;
};

/**
 * P0-1：发送失败恢复决策（纯函数）。
 *
 * 发送失败（HTTP 非 2xx / prompt 预检失败）意味着首条 user 消息**未确认**进入
 * live/disk 权威视图，此时：
 * - 若乐观 user 消息仍在列表末尾（未被 message_end 消费），它是「假 bubble」——
 *   移除，避免留下假的发送成功 / 永久 pending；
 * - 并标记应恢复 draft（调用方经 insertIfEmpty 只在输入框为空时写入，不覆盖
 *   用户新输入）。
 *
 * 边界：
 * - 末尾不匹配（bubble 已被 message_end 消费 / 中间插入其它消息）→ 消息已确认，
 *   保持列表且不恢复 draft；
 * - optimisticKey 为 null（从未设置或已消费）→ 不做任何变更。
 */
export function recoverFailedSend(args: {
  messages: readonly AgentMessage[];
  optimisticKey: string | null;
  isOptimisticMatch: (message: AgentMessage) => boolean;
}): FailedSendRecovery {
  const { messages, optimisticKey, isOptimisticMatch } = args;
  if (!optimisticKey) {
    return { messages: [...messages], optimisticKey: null, restoreDraft: false };
  }
  const last = messages[messages.length - 1];
  if (last === undefined || !isOptimisticMatch(last)) {
    return { messages: [...messages], optimisticKey: null, restoreDraft: false };
  }
  return { messages: messages.slice(0, -1), optimisticKey: null, restoreDraft: true };
}
