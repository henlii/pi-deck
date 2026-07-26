import type { AgentMessage, AssistantMessage, ToolCallContent } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
}

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const TODO_PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && TODO_PRIORITIES.includes(value as TodoPriority);
}

function isTodoWrite(toolName: unknown): boolean {
  return typeof toolName === "string" && toolName.toLowerCase().replace(/[_-]/g, "") === "todowrite";
}

function readToolCall(block: unknown): ToolCallContent | null {
  if (!isRecord(block) || block.type !== "toolCall") return null;
  const input = isRecord(block.input)
    ? block.input
    : (isRecord(block.arguments) ? block.arguments : {});
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input,
  };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readSnapshot(block: ToolCallContent): readonly Omit<TodoItem, "id">[] | null {
  if (!isRecord(block.input) || !Array.isArray(block.input.todos)) return null;

  const todos: Array<Omit<TodoItem, "id">> = [];
  for (const item of block.input.todos) {
    if (!isRecord(item)
      || typeof item.content !== "string"
      || item.content.length === 0
      || !isTodoStatus(item.status)
      || !isTodoPriority(item.priority)) {
      return null;
    }
    todos.push({ content: item.content, status: item.status, priority: item.priority });
  }
  return todos;
}

/** 从助手消息中提取最后一个合法的 todowrite 快照。 */
export function parseTodos(messages: readonly AgentMessage[]): readonly TodoItem[] {
  let latest: readonly Omit<TodoItem, "id">[] = [];
  let snapshotFound = false;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = (message as AssistantMessage).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const toolCall = readToolCall(block);
      if (toolCall === null || !isTodoWrite(toolCall.toolName)) continue;
      const snapshot = readSnapshot(toolCall);
      if (snapshot === null) continue;
      latest = snapshot;
      snapshotFound = true;
    }
  }

  if (!snapshotFound) return [];
  return latest.map((todo, index) => ({
    ...todo,
    id: `todo-${index}-${stableHash(`${index}\u0000${todo.content}\u0000${todo.status}\u0000${todo.priority}`)}`,
  }));
}
