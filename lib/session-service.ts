import { existsSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "./file-access";
import {
  getRpcSession,
  getRunningRpcSessionIds,
  startRpcSession,
  subscribeRunningSessions,
  type AgentSessionWrapper,
} from "./rpc-manager";
import {
  invalidateSessionListCache,
  listAllSessions,
  resolveSessionPath,
  type SessionManagerReadView,
} from "./session-reader";
import type { SessionInfo } from "./types";

export type SessionCommand = Record<string, unknown> & { type: string };

export const READ_ONLY_SUBAGENT_ERROR = "Subagent sessions are read-only";
export class ReadOnlySubagentError extends Error {
  constructor() { super(READ_ONLY_SUBAGENT_ERROR); }
  override toString() { return this.message; }
}

export async function requireWritableSession(
  sessionId: string,
  isReadOnly: (id: string) => Promise<boolean>,
): Promise<void> {
  if (await isReadOnly(sessionId)) throw new ReadOnlySubagentError();
}

export type CreateNewSessionOptions = {
  cwd: string;
  command: SessionCommand & {
    provider?: string;
    modelId?: string;
    toolNames?: string[];
    thinkingLevel?: string;
  };
};

export type CreateNewSessionResult = {
  sessionId: string;
  data: unknown;
};

/** 只读会话视图：live leaf 优先，否则磁盘 open；不启动 AgentSession。 */
export type SessionReadView = {
  source: "live" | "disk";
  filePath: string;
  manager: SessionManagerReadView;
};

export type SessionServiceDeps = {
  listAllSessions: () => Promise<SessionInfo[]>;
  resolveSessionPath: (sessionId: string) => Promise<string | null>;
  getRpcSession: (sessionId: string) => AgentSessionWrapper | undefined;
  startRpcSession: (
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolNames?: string[],
  ) => Promise<{ session: AgentSessionWrapper; realSessionId: string }>;
  getRunningRpcSessionIds: () => string[];
  subscribeRunningSessions: (listener: (ids: string[]) => void) => () => void;
  allowFileRoot: (root: string) => void;
  invalidateSessionListCache: () => void;
  openSessionCwd: (filePath: string) => string;
  openSessionManager: (filePath: string) => SessionManagerReadView;
  existsSync: (path: string) => boolean;
  now: () => number;
};

const defaultDeps: SessionServiceDeps = {
  listAllSessions,
  resolveSessionPath,
  getRpcSession,
  startRpcSession,
  getRunningRpcSessionIds,
  subscribeRunningSessions,
  allowFileRoot,
  invalidateSessionListCache,
  openSessionCwd: (filePath) => SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd(),
  openSessionManager: (filePath) => SessionManager.open(filePath) as unknown as SessionManagerReadView,
  existsSync,
  now: () => Date.now(),
};

export type SessionService = {
  listSessions(): Promise<{ sessions: SessionInfo[]; runningSessionIds: string[] }>;
  resolvePath(sessionId: string): Promise<string | null>;
  /** 只读，不启动，不套 readOnly 门禁；readOnly subagent 仍可浏览 */
  getReadView(sessionId: string): Promise<SessionReadView | null>;
  /** 只取 alive wrapper，绝不启动 */
  getLive(sessionId: string): AgentSessionWrapper | undefined;
  /** @deprecated 使用 getLive；保留兼容 agent GET 等调用方 */
  getLiveSession(sessionId: string): AgentSessionWrapper | undefined;
  isLive(sessionId: string): boolean;
  /** 复用或启动；启动前必须 readOnly 门禁 */
  ensureLive(sessionId: string): Promise<AgentSessionWrapper>;
  /** 销毁 alive/dead wrapper；不存在 no-op；不走 readOnly 门禁 */
  destroy(sessionId: string): void;
  start(
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolNames?: string[],
  ): Promise<{ session: AgentSessionWrapper; realSessionId: string }>;
  send(sessionId: string, command: SessionCommand): Promise<unknown>;
  createNew(options: CreateNewSessionOptions): Promise<CreateNewSessionResult>;
  getRunningIds(): string[];
  subscribeRunning(listener: (ids: string[]) => void): () => void;
  isReadOnly(sessionId: string): Promise<boolean>;
};

export function createSessionService(overrides: Partial<SessionServiceDeps> = {}): SessionService {
  const deps: SessionServiceDeps = { ...defaultDeps, ...overrides };

  const service: SessionService = {
    async listSessions() {
      const sessions = await deps.listAllSessions();
      return {
        sessions,
        runningSessionIds: deps.getRunningRpcSessionIds(),
      };
    },

    resolvePath(sessionId) {
      return deps.resolveSessionPath(sessionId);
    },

    async isReadOnly(sessionId) {
      const session = (await deps.listAllSessions()).find((item) => item.id === sessionId);
      return session?.readOnly === true;
    },

    async getReadView(sessionId) {
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) return null;

      const wrapper = deps.getRpcSession(sessionId);
      if (wrapper?.isAlive()) {
        return {
          source: "live",
          filePath,
          manager: wrapper.inner.sessionManager as unknown as SessionManagerReadView,
        };
      }

      return {
        source: "disk",
        filePath,
        manager: deps.openSessionManager(filePath),
      };
    },

    getLive(sessionId) {
      const session = deps.getRpcSession(sessionId);
      return session?.isAlive() ? session : undefined;
    },

    getLiveSession(sessionId) {
      return service.getLive(sessionId);
    },

    isLive(sessionId) {
      return Boolean(service.getLive(sessionId));
    },

    async ensureLive(sessionId) {
      await requireWritableSession(sessionId, service.isReadOnly);
      const live = service.getLive(sessionId);
      if (live) return live;

      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) {
        throw new Error("Session not found");
      }

      const cwd = deps.openSessionCwd(filePath);
      const { session } = await deps.startRpcSession(sessionId, filePath, cwd);
      return session;
    },

    destroy(sessionId) {
      // 含 dead wrapper；不存在 no-op；不走 readOnly
      deps.getRpcSession(sessionId)?.destroy();
    },

    async start(sessionId, sessionFile, cwd, toolNames) {
      await requireWritableSession(sessionId, service.isReadOnly);
      return deps.startRpcSession(sessionId, sessionFile, cwd, toolNames);
    },

    async send(sessionId, command) {
      const session = await service.ensureLive(sessionId);
      return session.send(command);
    },

    async createNew({ cwd, command }) {
      if (!cwd || typeof cwd !== "string") {
        throw new Error("cwd is required");
      }
      if (!deps.existsSync(cwd)) {
        throw new Error(`Directory does not exist: ${cwd}`);
      }

      const {
        provider,
        modelId,
        toolNames,
        thinkingLevel,
        ...promptCommand
      } = command;

      // 临时 key 只用于启动锁，真正 id 由 pi 生成。
      const tempKey = `__new__${deps.now()}`;
      const { session, realSessionId } = await deps.startRpcSession(tempKey, "", cwd, toolNames);

      deps.allowFileRoot(cwd);
      deps.invalidateSessionListCache();

      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      if (promptCommand.type === "ensure_session") {
        return { sessionId: realSessionId, data: null };
      }

      const data = await session.send(promptCommand as SessionCommand);
      return { sessionId: realSessionId, data };
    },

    getRunningIds() {
      return deps.getRunningRpcSessionIds();
    },

    subscribeRunning(listener) {
      return deps.subscribeRunningSessions(listener);
    },
  };

  return service;
}

export const sessionService = createSessionService();
