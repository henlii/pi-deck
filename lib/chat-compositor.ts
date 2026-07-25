import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "./types";
import { countToolCallBlocks, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "./message-display";

export interface ChatCompositorInput {
  messages: AgentMessage[];
  isStreaming: boolean;
  agentOrBashRunning: boolean;
}

export interface ChatRenderItem {
  kind: "message";
  messageIndex: number;
  messageOverride?: AgentMessage;
  showTimestamp?: boolean;
  keyPrefix: string;
  attachRef: boolean;
}

export interface ChatProcessGroup {
  kind: "processGroup";
  userIdx: number;
  finalAssistantIdx: number;
  messageCount: number;
  toolCallCount: number;
  children: ChatRenderItem[];
  attachRefMessageIndex?: number;
}

export type ChatRenderPlanItem = ChatRenderItem | ChatProcessGroup;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  return message.role === "custom";
}

function withAssistantBlocks(message: AssistantMessage, content: AssistantContentBlock[], omitUsage = false): AssistantMessage {
  const next = { ...message, content };
  if (omitUsage) next.usage = undefined;
  return next;
}

function timestampFor(messages: AgentMessage[], idx: number, isStreaming: boolean): boolean | undefined {
  if (messages[idx]?.role !== "assistant") return undefined;
  let show = true;
  for (let j = idx + 1; j < messages.length; j++) {
    const role = messages[j].role;
    if (role === "user") break;
    if (role === "assistant") { show = false; break; }
  }
  if (show && isStreaming && idx === messages.length - 1) show = false;
  return show;
}

function messageItem(messages: AgentMessage[], idx: number, isStreaming: boolean, options: Partial<ChatRenderItem> = {}): ChatRenderItem {
  return {
    kind: "message",
    messageIndex: idx,
    keyPrefix: options.keyPrefix ?? "message",
    attachRef: options.attachRef ?? true,
    showTimestamp: options.showTimestamp ?? timestampFor(messages, idx, isStreaming),
    ...(options.messageOverride ? { messageOverride: options.messageOverride } : {}),
  };
}

export function composeChatPlan(input: ChatCompositorInput): ChatRenderPlanItem[] {
  const { messages, isStreaming, agentOrBashRunning } = input;
  const lastUserIdx = messages.findLastIndex((message) => message.role === "user");
  const plan: ChatRenderPlanItem[] = [];

  for (let idx = 0; idx < messages.length;) {
    if (messages[idx].role !== "user") {
      plan.push(messageItem(messages, idx, isStreaming));
      idx++;
      continue;
    }
    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && messages[endIdx].role !== "user") endIdx++;
    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    if (finalAssistantIdx === -1 || ((agentOrBashRunning || isStreaming) && endIdx === messages.length && userIdx === lastUserIdx)) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) plan.push(messageItem(messages, renderIdx, isStreaming));
      idx = endIdx;
      continue;
    }

    plan.push(messageItem(messages, userIdx, isStreaming));
    const visibleProcessIndices: number[] = [];
    for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
      if (hasDisplayableProcessMessage(messages[processIdx])) visibleProcessIndices.push(processIdx);
    }
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, true)
      : undefined;
    const finalAnswerMessage = finalSplit.answerBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
      : undefined;
    const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
    if (processCount > 0) {
      const refTarget = visibleProcessIndices.find((processIdx) => messages[processIdx].role === "assistant" || messages[processIdx].role === "user")
        ?? (finalAnswerMessage ? undefined : finalAssistantIdx);
      plan.push({
        kind: "processGroup",
        userIdx,
        finalAssistantIdx,
        messageCount: processCount,
        toolCallCount: visibleProcessIndices.reduce((count, processIdx) => count + (messages[processIdx].role === "assistant" ? countToolCallBlocks(getDisplayableAssistantBlocks(messages[processIdx] as AssistantMessage)) : 0), 0) + countToolCallBlocks(finalSplit.processBlocks),
        children: [
          ...visibleProcessIndices.map((processIdx) => messageItem(messages, processIdx, isStreaming, { attachRef: false, keyPrefix: "process" })),
          ...(finalProcessMessage ? [messageItem(messages, finalAssistantIdx, isStreaming, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })] : []),
        ],
        ...(refTarget === undefined ? {} : { attachRefMessageIndex: refTarget }),
      });
    }
    if (finalAnswerMessage) plan.push(messageItem(messages, finalAssistantIdx, isStreaming, { messageOverride: finalAnswerMessage }));
    for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) plan.push(messageItem(messages, renderIdx, isStreaming));
    idx = endIdx;
  }
  return plan;
}
