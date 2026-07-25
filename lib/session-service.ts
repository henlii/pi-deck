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
  existsSync,
  now: () => Date.now(),
};

export type SessionService = {
  listSessions(): Promise<{ sessions: SessionInfo[]; runningSessionIds: string[] }>;
  resolvePath(sessionId: string): Promise<string | null>;
  getLiveSession(sessionId: string): AgentSessionWrapper | undefined;
  isLive(sessionId: string): boolean;
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

  return {
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

    getLiveSession(sessionId) {
      const session = deps.getRpcSession(sessionId);
      return session?.isAlive() ? session : undefined;
    },

    isLive(sessionId) {
      return Boolean(deps.getRpcSession(sessionId)?.isAlive());
    },

    async start(sessionId, sessionFile, cwd, toolNames) {
      await requireWritableSession(sessionId, this.isReadOnly);
      return deps.startRpcSession(sessionId, sessionFile, cwd, toolNames);
    },

    async send(sessionId, command) {
      await requireWritableSession(sessionId, this.isReadOnly);
      const live = deps.getRpcSession(sessionId);
      if (live?.isAlive()) {
        return live.send(command);
      }

      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) {
        throw new Error("Session not found");
      }

      const cwd = deps.openSessionCwd(filePath);
      const { session } = await deps.startRpcSession(sessionId, filePath, cwd);
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
}

export const sessionService = createSessionService();
