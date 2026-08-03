import { existsSync } from "fs";
import { collectEntriesForBranchSummary, SessionManager } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "./file-access";
import {
  getRpcSession,
  getRunningRpcSessionIds,
  startRpcSession,
  subscribeRunningSessions,
  type AgentSessionWrapper,
} from "./rpc-manager";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  listAllSessions,
  resolveSessionPath,
  type SessionManagerReadView,
} from "./session-reader";
import type { SessionActivity, SessionActivityInput } from "./session-activity";
import { computeTurnEnd } from "./turn-end";
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
  /**
   * 按 id 只读取单条 SessionInfo（列表投影子集）；不启动 AgentSession。
   * 底层可能枚举磁盘/缓存，但只返回目标条目；不存在 → null。
   */
  getSessionInfo(sessionId: string): Promise<SessionInfo | null>;
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
  /**
   * 类型安全的持久活动写入：ensureLive（含 readOnly 门禁）后调用 wrapper.appendActivity。
   * 不得绕过 readOnly；customType 固定为 pidance.activity。
   */
  appendActivity(
    sessionId: string,
    input: SessionActivityInput,
  ): Promise<{ entryId: string; activity: SessionActivity }>;
  createNew(options: CreateNewSessionOptions): Promise<CreateNewSessionResult>;
  getRunningIds(): string[];
  subscribeRunning(listener: (ids: string[]) => void): () => void;
  isReadOnly(sessionId: string): Promise<boolean>;
  /** 精确 leaf 切换（user 叶也停在该 entry，不触发 Pi 的 user 编辑语义） */
  selectLeafExact(sessionId: string, entryId: string): Promise<{ cancelled: boolean }>;
  /** assistant 轮末分支：computeTurnEnd 后 navigateTree */
  branchFromAssistant(sessionId: string, assistantEntryId: string): Promise<{ cancelled: boolean }>;
  /** through-entry 线性新会话（assistant 锚点先 resolve 到 turnEnd） */
  createSessionFromLeaf(sessionId: string, entryId: string): Promise<{ cancelled: boolean; newSessionId: string }>;
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

    async getSessionInfo(sessionId) {
      if (!sessionId || typeof sessionId !== "string") return null;
      const sessions = await deps.listAllSessions();
      return sessions.find((item) => item.id === sessionId) ?? null;
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

    async appendActivity(sessionId, input) {
      const session = await service.ensureLive(sessionId);
      return session.appendActivity(input);
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

    async selectLeafExact(sessionId, entryId) {
      const wrapper = deps.getRpcSession(sessionId);
      if (!wrapper) throw new Error("Session is not live");
      if (wrapper.inner.isBashRunning) {
        throw new Error("Cannot switch branch while a shell command is running");
      }
      if (typeof entryId !== "string" || entryId.trim() === "") {
        throw new Error("entryId is required");
      }
      const trimmedId = entryId.trim();
      const sessionManager = wrapper.inner.sessionManager;
      const oldLeafId = sessionManager.getLeafId();
      if (trimmedId === oldLeafId) return { cancelled: false };
      const targetEntry = sessionManager.getEntry(trimmedId);
      if (!targetEntry) throw new Error(`Entry ${trimmedId} not found`);
      const extensionRunner = wrapper.inner.extensionRunner;
      try {
        if (extensionRunner?.emit) {
          const { entries, commonAncestorId } = collectEntriesForBranchSummary(
            sessionManager,
            oldLeafId,
            trimmedId,
          );
          const beforeResult = await extensionRunner.emit({
            type: "session_before_tree",
            preparation: {
              targetId: trimmedId,
              oldLeafId,
              commonAncestorId,
              entriesToSummarize: entries,
              userWantsSummary: false,
            },
          });
          if (beforeResult?.cancel) return { cancelled: true };
        }
        // 精确 leaf：与 navigateTree 的唯一差异——user 目标也停在自身
        sessionManager.branch(trimmedId);
        const sessionContext = sessionManager.buildSessionContext();
        if (wrapper.inner.agent.state) {
          wrapper.inner.agent.state.messages = sessionContext.messages as unknown[];
        }
        await extensionRunner?.emit?.({ type: "session_tree", newLeafId: trimmedId, oldLeafId });
        return { cancelled: false };
      } finally {
        deps.invalidateSessionListCache();
      }
    },

    async branchFromAssistant(sessionId, assistantEntryId) {
      const wrapper = deps.getRpcSession(sessionId);
      if (!wrapper) throw new Error("Session is not live");
      if (wrapper.inner.isBashRunning) {
        throw new Error("Cannot branch while a shell command is running");
      }
      if (typeof assistantEntryId !== "string" || assistantEntryId.trim() === "") {
        throw new Error("assistantEntryId is required");
      }
      const trimmedId = assistantEntryId.trim();
      const sessionManager = wrapper.inner.sessionManager;
      const leafId = sessionManager.getLeafId();
      if (!leafId) throw new Error("Session has no leaf");
      const path = sessionManager.getBranch(leafId);
      const targetEntry = sessionManager.getEntry(trimmedId);
      if (!targetEntry) throw new Error("Entry not found");
      if (targetEntry.type !== "message" || targetEntry.message?.role !== "assistant") {
        throw new Error("Only assistant messages can be branched from");
      }
      const turnEnd = computeTurnEnd(path, trimmedId);
      try {
        const result = await wrapper.inner.navigateTree(turnEnd, { summarize: false });
        return result;
      } finally {
        deps.invalidateSessionListCache();
      }
    },

    async createSessionFromLeaf(sessionId, entryId) {
      const wrapper = deps.getRpcSession(sessionId);
      if (!wrapper) throw new Error("Session is not live");
      if (typeof entryId !== "string" || entryId.trim() === "") {
        throw new Error("entryId is required");
      }
      const trimmedId = entryId.trim();
      const sessionManager = wrapper.inner.sessionManager;
      const currentSessionFile = wrapper.inner.sessionFile;
      if (!currentSessionFile) throw new Error("Session is not persisted");
      const entry = sessionManager.getEntry(trimmedId);
      if (!entry) throw new Error("Invalid entry ID");

      // assistant 锚点：与 branch_from_assistant 对称，先 resolve 到 turnEnd，避免中间 tool-call 卡片丢后续 toolResult/final
      let branchLeafId = trimmedId;
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const leafId = sessionManager.getLeafId();
        if (!leafId) throw new Error("Session has no leaf");
        const path = sessionManager.getBranch(leafId);
        branchLeafId = computeTurnEnd(path, trimmedId);
      }

      const sessionDir = sessionManager.getSessionDir();
      const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
      const newSessionFile = sourceManager.createBranchedSession(branchLeafId);
      if (!newSessionFile) throw new Error("Failed to create session");
      const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
      cacheSessionPath(newSessionId, newSessionFile);
      deps.invalidateSessionListCache();
      // fork 后立即 destroy 源 wrapper，避免 in-place 污染 registry（经 SessionService 暴露，不绕过 seam）
      deps.getRpcSession(sessionId)?.destroy();
      return { cancelled: false, newSessionId };
    },
  };

  return service;
}

export const sessionService = createSessionService();
