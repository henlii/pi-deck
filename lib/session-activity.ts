/**
 * Pidance 持久活动（session activity）通道。
 *
 * - 写入：仅通过 live SessionManager.appendCustomEntry("pidance.activity", data)
 * - 读取：从 active branch 上 type:"custom" 投影为 UI CustomMessage
 * - 不进入 LLM：Pi 对 type:"custom" 的 sessionEntryToContextMessages 返回空
 * - 禁止 custom_message（那会进入 LLM context）
 */

import type { CustomMessage } from "./types";

/** Pi custom entry 的 customType；固定，调用方不可覆盖。 */
export const PIDANCE_ACTIVITY_CUSTOM_TYPE = "pidance.activity";

/** 当前 schema 版本；未知版本 fail closed。 */
export const PIDANCE_ACTIVITY_VERSION = 1 as const;

export type ActivityKind = "result" | "warning" | "error" | "output";

export const ACTIVITY_KINDS = ["result", "warning", "error", "output"] as const;

/** 有界限制：超限拒绝，不静默截断。 */
export const ACTIVITY_TITLE_MAX = 200;
export const ACTIVITY_CONTENT_MAX = 32_768;
export const ACTIVITY_SOURCE_MAX = 200;
export const ACTIVITY_REQUEST_ID_MAX = 200;
export const ACTIVITY_METADATA_MAX_KEYS = 20;
export const ACTIVITY_METADATA_KEY_MAX = 64;
export const ACTIVITY_METADATA_STRING_MAX = 1_024;
export const ACTIVITY_METADATA_DEPTH_MAX = 3;
export const ACTIVITY_METADATA_ARRAY_MAX = 32;
/** 整条 activity 序列化后的 UTF-8 字节上限（含 metadata）。 */
export const ACTIVITY_SERIALIZED_MAX_BYTES = 48_000;

/** JSON-safe 叶子与嵌套结构（metadata 用）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 规范化后的持久活动记录（写入 SessionManager.data）。 */
export interface SessionActivity {
  version: typeof PIDANCE_ACTIVITY_VERSION;
  kind: ActivityKind;
  title: string;
  content: string;
  source?: string;
  requestId?: string;
  metadata?: Record<string, JsonValue>;
}

/** 写入侧输入（version 可省略，默认 1）。 */
export type SessionActivityInput = {
  version?: number;
  kind: ActivityKind | string;
  title: string;
  content: string;
  source?: string;
  requestId?: string;
  metadata?: unknown;
};

export class SessionActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionActivityError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 将 unknown 规范化为 JSON-safe 值；原型污染键、循环、非 JSON 类型、越界均抛错。
 */
function normalizeJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") {
    if (utf8ByteLength(value) > ACTIVITY_METADATA_STRING_MAX) {
      throw new SessionActivityError(
        `metadata string exceeds ${ACTIVITY_METADATA_STRING_MAX} bytes`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SessionActivityError("metadata number must be finite");
    }
    return value;
  }
  if (typeof value === "boolean") return value;

  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    throw new SessionActivityError("metadata contains non-JSON value");
  }

  if (typeof value !== "object") {
    throw new SessionActivityError("metadata contains non-JSON value");
  }

  if (seen.has(value as object)) {
    throw new SessionActivityError("metadata contains circular reference");
  }
  if (depth > ACTIVITY_METADATA_DEPTH_MAX) {
    throw new SessionActivityError(`metadata exceeds max depth ${ACTIVITY_METADATA_DEPTH_MAX}`);
  }

  if (Array.isArray(value)) {
    if (value.length > ACTIVITY_METADATA_ARRAY_MAX) {
      throw new SessionActivityError(
        `metadata array exceeds ${ACTIVITY_METADATA_ARRAY_MAX} items`,
      );
    }
    seen.add(value);
    try {
      return value.map((item) => normalizeJsonValue(item, depth + 1, seen));
    } finally {
      seen.delete(value);
    }
  }

  // 拒绝特殊对象（Date/Map/RegExp 等）与带原型的污染面：只接受 plain object 键
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new SessionActivityError("metadata must be a plain JSON object or array");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > ACTIVITY_METADATA_MAX_KEYS) {
    throw new SessionActivityError(
      `metadata exceeds ${ACTIVITY_METADATA_MAX_KEYS} keys`,
    );
  }

  seen.add(value);
  try {
    const out: Record<string, JsonValue> = Object.create(null);
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new SessionActivityError("metadata key is not allowed");
      }
      if (utf8ByteLength(key) > ACTIVITY_METADATA_KEY_MAX) {
        throw new SessionActivityError(
          `metadata key exceeds ${ACTIVITY_METADATA_KEY_MAX} bytes`,
        );
      }
      out[key] = normalizeJsonValue(record[key], depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxChars: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SessionActivityError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > maxChars) {
    throw new SessionActivityError(`${field} exceeds maximum length ${maxChars}`);
  }
  return trimmed;
}

/**
 * 写入前校验并规范化 activity；失败抛 SessionActivityError（fail closed）。
 */
export function normalizeActivityInput(input: unknown): SessionActivity {
  if (!isPlainRecord(input)) {
    throw new SessionActivityError("activity must be a plain object");
  }

  const version = input.version === undefined ? PIDANCE_ACTIVITY_VERSION : input.version;
  if (version !== PIDANCE_ACTIVITY_VERSION) {
    throw new SessionActivityError(
      `unsupported activity version: ${String(version)}`,
    );
  }

  if (!isActivityKind(input.kind)) {
    throw new SessionActivityError(
      `kind must be one of: ${ACTIVITY_KINDS.join(", ")}`,
    );
  }

  if (typeof input.title !== "string") {
    throw new SessionActivityError("title must be a string");
  }
  const title = input.title.trim();
  if (title === "") {
    throw new SessionActivityError("title is required");
  }
  if (title.length > ACTIVITY_TITLE_MAX) {
    throw new SessionActivityError(`title exceeds maximum length ${ACTIVITY_TITLE_MAX}`);
  }

  if (typeof input.content !== "string") {
    throw new SessionActivityError("content must be a string");
  }
  // content：trim 仅两端空白；空 content 允许（有 title 即可），但超长拒绝
  const content = input.content.trim();
  if (content.length > ACTIVITY_CONTENT_MAX) {
    throw new SessionActivityError(
      `content exceeds maximum length ${ACTIVITY_CONTENT_MAX}`,
    );
  }

  const source = normalizeOptionalString(input.source, "source", ACTIVITY_SOURCE_MAX);
  const requestId = normalizeOptionalString(
    input.requestId,
    "requestId",
    ACTIVITY_REQUEST_ID_MAX,
  );

  let metadata: Record<string, JsonValue> | undefined;
  if (input.metadata !== undefined) {
    if (!isPlainRecord(input.metadata)) {
      throw new SessionActivityError("metadata must be a plain object");
    }
    const normalized = normalizeJsonValue(input.metadata, 0, new WeakSet());
    if (!isPlainRecord(normalized) || Array.isArray(normalized)) {
      throw new SessionActivityError("metadata must be a plain object");
    }
    metadata = normalized as Record<string, JsonValue>;
    if (Object.keys(metadata).length === 0) {
      metadata = undefined;
    }
  }

  const activity: SessionActivity = {
    version: PIDANCE_ACTIVITY_VERSION,
    kind: input.kind,
    title,
    content,
  };
  if (source !== undefined) activity.source = source;
  if (requestId !== undefined) activity.requestId = requestId;
  if (metadata !== undefined) activity.metadata = metadata;

  let serialized: string;
  try {
    serialized = JSON.stringify(activity);
  } catch {
    throw new SessionActivityError("activity is not JSON-serializable");
  }
  if (utf8ByteLength(serialized) > ACTIVITY_SERIALIZED_MAX_BYTES) {
    throw new SessionActivityError(
      `activity exceeds maximum serialized size ${ACTIVITY_SERIALIZED_MAX_BYTES} bytes`,
    );
  }

  return activity;
}

/**
 * 只读侧解析：非法/未知版本返回 null（安全跳过），不抛。
 */
export function parseActivityData(data: unknown): SessionActivity | null {
  try {
    return normalizeActivityInput(data);
  } catch {
    return null;
  }
}

/**
 * 将规范化 activity 投影为 UI CustomMessage。
 * customType 固定为 pidance.activity；display 恒 true。
 */
export function activityToUiMessage(
  activity: SessionActivity,
  timestamp?: number,
): CustomMessage {
  const message: CustomMessage = {
    role: "custom",
    customType: PIDANCE_ACTIVITY_CUSTOM_TYPE,
    content: activity.title,
    display: true,
    details: activity,
  };
  if (timestamp !== undefined) message.timestamp = timestamp;
  return message;
}

/**
 * 判断 session entry 是否为合法 pidance.activity custom entry。
 */
export function isPidanceActivityEntry(entry: {
  type?: string;
  customType?: string;
  data?: unknown;
}): entry is { type: "custom"; customType: typeof PIDANCE_ACTIVITY_CUSTOM_TYPE; data: SessionActivity; id?: string; timestamp?: string } {
  if (entry.type !== "custom") return false;
  if (entry.customType !== PIDANCE_ACTIVITY_CUSTOM_TYPE) return false;
  return parseActivityData(entry.data) !== null;
}

/**
 * 从 append_activity 命令体提取 activity 输入。
 * 支持 { type, activity: {...} } 或顶层字段（忽略 type）。
 * 禁止调用方指定 customType。
 */
export function parseAppendActivityCommand(command: Record<string, unknown>): SessionActivity {
  if ("customType" in command && command.customType !== undefined) {
    throw new SessionActivityError("customType is not allowed on append_activity");
  }
  const nested = command.activity;
  if (nested !== undefined) {
    if (!isPlainRecord(nested)) {
      throw new SessionActivityError("activity must be a plain object");
    }
    if ("customType" in nested && nested.customType !== undefined) {
      throw new SessionActivityError("customType is not allowed on append_activity");
    }
    return normalizeActivityInput(nested);
  }
  const rest: Record<string, unknown> = { ...command };
  delete rest.type;
  return normalizeActivityInput(rest);
}
