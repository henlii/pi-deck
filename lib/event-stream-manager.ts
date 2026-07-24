export type AgentStreamEvent = {
  type: string;
  [key: string]: unknown;
};

export type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

export type EventSourceLike = {
  close(): void;
  readyState: number;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

export type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSourceLike;
};

export class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

// 定时器句柄类型：浏览器 setTimeout 返回 number，Node 返回 NodeJS.Timeout。
// 这里宽松成 any 以避免两套 lib 类型混入时的并集不兼容。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TimerHandle = any;

export type EventStreamManagerOptions = {
  createEventSource?: (url: string) => EventSourceLike;
  getEventsUrl?: (sessionId: string) => string;
  connectTimeoutMs?: number;
  reconnectDelayMs?: number;
  shouldAutoReconnect?: () => boolean;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  clearSchedule?: (id: TimerHandle) => void;
};

// EventSource 就绪状态常量（避免直接引用 DOM 类型以便在服务端测试中复用）。
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

export type EventStreamManager = {
  connect(
    sessionId: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<EventStreamConnectionResult>;
  ensureConnected(
    sessionId: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<void>;
  close(): void;
  getCurrentSource(): EventSourceLike | null;
};

export function createEventStreamManager(options: EventStreamManagerOptions = {}): EventStreamManager {
  const createEventSource = options.createEventSource ?? defaultCreateEventSource;
  const getEventsUrl = options.getEventsUrl
    ?? ((sessionId: string) => `/api/agent/${encodeURIComponent(sessionId)}/events`);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  const shouldAutoReconnect = options.shouldAutoReconnect ?? (() => false);
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearSchedule = options.clearSchedule ?? ((id: TimerHandle) => clearTimeout(id));

  let current: EventSourceLike | null = null;
  let reconnectTimer: TimerHandle = null;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearSchedule(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const close = () => {
    clearReconnect();
    if (current) {
      current.close();
      current = null;
    }
  };

  const connect = (
    sessionId: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<EventStreamConnectionResult> => {
    clearReconnect();
    if (current) {
      current.close();
      current = null;
    }

    const source = createEventSource(getEventsUrl(sessionId));
    current = source;

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: TimerHandle = null;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          clearSchedule(timeoutId);
          timeoutId = null;
        }
        resolve({ status, source });
      };
      timeoutId = schedule(() => settle("timeout"), connectTimeoutMs);

      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as AgentStreamEvent;
          if (event.type === "connected") settle("connected");
          onEvent(event);
        } catch {
          // 忽略坏帧，保持连接。
        }
      };

      source.onerror = () => {
        // 仅在 CLOSED 状态（404/500/content-type 不匹配等致命错误，浏览器
        // 不会自动重连）才结算 Promise 并视策略手动重连；CONNECTING 状态
        // 属可恢复错误，浏览器会自动重连。
        if (source.readyState === CLOSED) {
          settle("closed");
          if (current === source && shouldAutoReconnect()) {
            current = null;
            reconnectTimer = schedule(() => {
              if (shouldAutoReconnect()) {
                void connect(sessionId, onEvent);
              }
            }, reconnectDelayMs);
          }
        }
      };
    });
  };

  return {
    connect,
    async ensureConnected(sessionId, onEvent) {
      const result = await connect(sessionId, onEvent);
      if (result.status === "connected" || result.source.readyState === OPEN) return;
      if (current === result.source) current = null;
      result.source.close();
      throw new EventStreamConnectionError(result.status);
    },
    close,
    getCurrentSource() {
      return current;
    },
  };
}

// CONNECTING 仅为可读性保留，当前实现未直接使用该状态分支。
void CONNECTING;