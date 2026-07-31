"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  AttachedImage,
  ChatInputHandle,
} from "@/lib/types";
import type { ObservationalMemoryView } from "@/lib/om-ledger";
import type { WorkspaceHistoryView } from "@/lib/workspace-history";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  buildBranchSwitchCommand,
  buildSetBranchLabelCommand,
  gateBranchAction,
  type BranchActions,
  type BranchActionResult,
  type BranchSwitchChoice,
} from "@/lib/branch-bookmarks";
import type { RetractedRecord } from "@/lib/retract-stack";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import { createEventStreamManager, EventStreamConnectionError, type EventStreamManager, type EventStreamConnectionResult } from "@/lib/event-stream-manager";
import type { SessionStatsInfo } from "@/lib/pi-types";
import {
  applyExtensionUiRequest,
  clearAllExtensionUiBlocking,
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
  type ExtensionUiState,
} from "@/lib/extension-ui-bridge";
import type { ExtensionUiInlineRequest } from "@/lib/extension-ui-bridge";
import { parseTodos } from "@/lib/todo-parser";
import { getSessionCapabilities } from "@/components/session-capabilities";
import {
  PROGRAMMATIC_SMOOTH_IGNORE_MS,
  RUN_SETTLE_MS,
  canNestedScrollerConsumeUp,
  getBottomZoneSize,
  getDistanceFromBottom,
  getScrollDirection,
  isEntryStickActive,
  reduceAutoFollow,
  shouldShowJumpButton,
  type AutoFollowMode,
} from "@/lib/chat-auto-follow";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  /** om 只读 ledger 投影；无有效 om entry 时为 null；旧响应可能缺省 */
  observationalMemory?: ObservationalMemoryView | null;
  /** workspace-history 只读 snapshot 时间线；无有效 entry 时为 null；旧响应可能缺省 */
  workspaceHistory?: WorkspaceHistoryView | null;
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /**
   * 新建意图代际 id（AppShell NewSessionIntent.id）。
   * ensure/promote 时回传，供父层丢弃迟到的旧 intent 结果；缺省时行为与仅 cwd 一致。
   */
  newSessionIntentId?: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo, intentId?: string | null) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, actions: BranchActions) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
  /** 移动端断点（与 useIsMobile 同源）：决定末端区域与底部 spacer 尺寸。 */
  isMobile?: boolean;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
// 只有明确向上的键才构成 release 意图；向下滚动的键交给 scroll 几何判定恢复跟随。
const RELEASE_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * wheel/touch 的向上意图若发生在可自己继续向上滚的嵌套区（代码块、工具输出等），
 * 让嵌套区优先消费，外层不 release。
 */
function isInsideNestedUpScrollable(target: EventTarget | null, container: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  let el: Element | null = target;
  while (el && el !== container) {
    if (el instanceof HTMLElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll")
        && canNestedScrollerConsumeUp({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })
      ) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export type { AttachedImage, ChatInputHandle } from "@/lib/types";

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, newSessionIntentId, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  // intent 捕获的 cwd/id：避免用户随后切项目导致 ensure body 漂移。
  const newSessionCwdRef = useRef(newSessionCwd);
  const newSessionIntentIdRef = useRef(newSessionIntentId ?? null);
  newSessionCwdRef.current = newSessionCwd;
  newSessionIntentIdRef.current = newSessionIntentId ?? null;
  // 只读（subagent 持久化）会话能力：UI 层先行拦截一切会产生 AgentSession
  // 或写会话的操作；后端 requireWritableSession 仍是权威防线。
  const capabilities = getSessionCapabilities(session);
  const isReadOnly = capabilities.readOnly;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [observationalMemory, setObservationalMemory] = useState<ObservationalMemoryView | null>(null);
  const [workspaceHistory, setWorkspaceHistory] = useState<WorkspaceHistoryView | null>(null);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionInlineRequest, setExtensionInlineRequest] = useState<ExtensionUiInlineRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  // 分支切换/总结进行中：树节点、发送与再次导航全部暂停，避免与 navigateTree 并发写。
  const [branchBusy, setBranchBusy] = useState(false);

  // 消息撤回坞（OpenChamber 风格）：服务端内存栈，会话切换时重新拉取。
  const [retractedMessages, setRetractedMessages] = useState<RetractedRecord[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  const branchBusyRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // ── OpenChamber 风格自动跟随（纯状态机见 lib/chat-auto-follow.ts）──────────
  // 唯一 scrollTop 写入方是本控制器的 pinToBottom；明确例外：顶部懒加载 prepend
  // 补偿（markExternalScrollWrite）与扩展卡片就近滚动（notifyProgrammaticSmooth），
  // 二者都通过时间窗让 scroll 事件不参与状态判定。minimap 不需要标记：它产生的
  // 向上位移本就应该 release、向下进入末端区域本就应该恢复。
  const autoFollowModeRef = useRef<AutoFollowMode>("following");
  const [jumpButtonVisible, setJumpButtonVisible] = useState(false);
  const initialScrollDoneRef = useRef(false);
  const pendingSendPinRef = useRef(false);
  /** 分支导航成功应用新 context 后，下一次消息提交 effect 做 instant 钉底（与 send 分离，避免普通增长误触发）。 */
  const pendingResetPinRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const externalWriteUntilRef = useRef(0);
  const programmaticSmoothUntilRef = useRef(0);
  const entryStickArmedAtRef = useRef<number | null>(null);
  const entryLastGrowthAtRef = useRef(0);
  const runSettleUntilRef = useRef(0);
  const wasSessionBusyRef = useRef(false);
  const isMobileRef = useRef(false);
  const prefersReducedMotionRef = useRef(false);
  /**
   * 稳定容器元素：供 wheel/scroll/RO 绑定，避免 messages.length 每次变化断开重绑。
   * 通过 layout effect 在 loading→容器出现 / 容器替换时从 scrollContainerRef 同步。
   */
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  // 渲染期同步（与本文件 handleAgentEventRef 等既有模式一致）：事件回调里读最新断点。
  isMobileRef.current = opts.isMobile ?? false;

  // ── 自动跟随控制器 ────────────────────────────────────────────────────────
  // following：内容增长（ResizeObserver，paint 前）instant 钉底，绝不对 token 用 smooth。
  // released：流式增长、工具块重排、懒加载 prepend 都不回拉；只有用户向下进入
  // 末端区域或到真实底部才恢复（几何判定在 lib/chat-auto-follow.ts）。

  /** 回到底部按钮可见性：可滚动 + released + 不在末端区域。state 相同则不触发重渲染。 */
  const updateJumpButtonVisibility = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setJumpButtonVisible(false);
      return;
    }
    const show = shouldShowJumpButton(
      autoFollowModeRef.current,
      container.scrollHeight - container.clientHeight,
      getDistanceFromBottom(container.scrollHeight, container.scrollTop, container.clientHeight),
      getBottomZoneSize(container.clientHeight, isMobileRef.current),
    );
    setJumpButtonVisible((prev) => (prev === show ? prev : show));
  }, []);

  const applyAutoFollowMode = useCallback((mode: AutoFollowMode) => {
    if (autoFollowModeRef.current === mode) return;
    autoFollowModeRef.current = mode;
    updateJumpButtonVisibility();
  }, [updateJumpButtonVisibility]);

  /** 唯一钉底写入。instant 直接赋值（RO 回调内 paint 前生效）；smooth 标记程序化窗口。 */
  const pinToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const top = Math.max(0, container.scrollHeight - container.clientHeight);
    if (behavior === "smooth") {
      programmaticSmoothUntilRef.current = Date.now() + PROGRAMMATIC_SMOOTH_IGNORE_MS;
      container.scrollTo({ top, behavior: "smooth" });
      return;
    }
    // 预登记目标位置，pin 自身的 scroll 事件方向为 down/none，不参与状态判定。
    lastScrollTopRef.current = top;
    container.scrollTop = top;
  }, []);

  /** 发送消息：无论此前是否 released，立即回到 following；pin 等 DOM 就绪后在 messages effect 执行。 */
  const notifyAutoFollowSend = useCallback(() => {
    entryStickArmedAtRef.current = null;
    autoFollowModeRef.current = "following";
    pendingSendPinRef.current = true;
    setJumpButtonVisible(false);
  }, []);

  /**
   * 分支导航 / leaf 切换：在实际开始应用新 context 时调用（fetch 失败不调用）。
   * 恢复 following、隐藏 jump、标记 pendingReset 钉底，并重新 arm entry-stick 以覆盖异步重排。
   */
  const notifyAutoFollowBranchReset = useCallback(() => {
    const now = Date.now();
    entryStickArmedAtRef.current = now;
    entryLastGrowthAtRef.current = now;
    autoFollowModeRef.current = "following";
    pendingResetPinRef.current = true;
    setJumpButtonVisible(false);
  }, []);

  /** 回到底部按钮：smooth 到底并恢复 following；prefers-reduced-motion 时 instant。 */
  const jumpToBottom = useCallback(() => {
    applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "jump-button" }));
    pinToBottom(prefersReducedMotionRef.current ? "instant" : "smooth");
  }, [applyAutoFollowMode, pinToBottom]);

  /** 顶部懒加载 prepend 补偿写入前的标记：随后的 scroll 事件不参与状态判定。 */
  const markExternalScrollWrite = useCallback(() => {
    externalWriteUntilRef.current = Date.now() + 150;
  }, []);

  /** 扩展 inline 卡片「附近才滚到可见」的 smooth 滚动：不覆盖用户 released 状态。 */
  const notifyProgrammaticSmooth = useCallback(() => {
    programmaticSmoothUntilRef.current = Date.now() + PROGRAMMATIC_SMOOTH_IGNORE_MS;
  }, []);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const promptRunIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const extensionUiStateRef = useRef<ExtensionUiState>(createEmptyExtensionUiState({
    customUi: extensionCustomUi,
    statuses: extensionStatuses,
    widgets: extensionWidgets,
  }));
  const commitExtensionUiState = useCallback((next: ExtensionUiState) => {
    extensionUiStateRef.current = next;
    setExtensionDialog(next.dialog);
    setExtensionInlineRequest(next.inlineRequest ?? null);
    setExtensionCustomUi(next.customUi);
    setExtensionStatuses(next.statuses);
    setExtensionWidgets(next.widgets);
  }, []);
  const patchExtensionUiState = useCallback((patch: Partial<ExtensionUiState>) => {
    commitExtensionUiState({ ...extensionUiStateRef.current, ...patch });
  }, [commitExtensionUiState]);
  /** 按 id 移除阻塞请求并推进队列；不发送协议响应（本地过期 / 服务端已结算） */
  const dismissExtensionUiRequest = useCallback((requestId: string) => {
    const currentState = extensionUiStateRef.current;
    const nextState = clearExtensionUiRequest(currentState, requestId);
    if (nextState === currentState) return;
    commitExtensionUiState(nextState);
  }, [commitExtensionUiState]);

  const todos = useMemo(() => {
    const todoMessages = streamState.streamingMessage
      ? [...messages, streamState.streamingMessage as AgentMessage]
      : messages;
    return parseTodos(todoMessages);
  }, [messages, streamState.streamingMessage]);

  // SSE 连接管理交由可注入、可独立测试的 EventStreamManager（见
  // lib/event-stream-manager.ts）。这里只保留 lazy 初始化的 ref 通过引用
  // 复用同一实例，并把 agentRunningRef 作为重连门控注入。外部可见的
  // eventSourceRef 与之同步以便消费方契约不变。
  const eventStreamManagerRef = useRef<EventStreamManager | null>(null);
  if (eventStreamManagerRef.current === null) {
    eventStreamManagerRef.current = createEventStreamManager({
      connectTimeoutMs: EVENT_STREAM_CONNECT_TIMEOUT_MS,
      reconnectDelayMs: 1_000,
      shouldAutoReconnect: () => agentRunningRef.current,
    });
  }

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, session?.id, session?.name]);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    reportSuccess = false,
    resetBranchFollow = false,
  ) => {
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setEntryIds([]);
          setObservationalMemory(null);
          setWorkspaceHistory(null);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      // 只有分支导航成功拿到整体会话、即将应用新 context 时才重置跟随；
      // 请求失败/取消不会改变当前阅读位置。
      if (resetBranchFollow) notifyAutoFollowBranchReset();
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setObservationalMemory(d.observationalMemory ?? null);
      setWorkspaceHistory(d.workspaceHistory ?? null);
      setCurrentModelOverride(null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      // D3 写动作按需请求成功标记；其它既有调用仍保持 null 返回语义。
      if (!includeState) return reportSuccess ? true : null;

      try {
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) patchExtensionUiState({ statuses: liveState.extensionStatuses ?? [] });
          if (liveState.extensionWidgets !== undefined) patchExtensionUiState({ widgets: liveState.extensionWidgets ?? [] });
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [notifyAutoFollowBranchReset, patchExtensionUiState]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: { messages: AgentMessage[]; entryIds: string[] };
        observationalMemory?: ObservationalMemoryView | null;
        workspaceHistory?: WorkspaceHistoryView | null;
      };
      // 仅在成功拿到新 context、即将写入 state 时重置跟随；fetch 失败不遗留 pending。
      notifyAutoFollowBranchReset();
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      // leaf 切换时同步 om / workspace-history 投影；字段缺省时清空，避免旧 leaf 数据残留
      setObservationalMemory(d.observationalMemory ?? null);
      setWorkspaceHistory(d.workspaceHistory ?? null);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, [notifyAutoFollowBranchReset]);

  const loadTools = useCallback(async (sid: string) => {
    // 只读会话：get_tools 会经 /api/agent 启动 AgentSession，跳过。
    if (isReadOnly) return;
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [isReadOnly, setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    const cwd = newSessionCwdRef.current;
    if (!isNew || !cwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    }, newSessionIntentIdRef.current);
  }, [isNew, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const cwd = newSessionCwdRef.current;
    if (!isNew || !cwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    // 捕获本次 ensure 的 cwd：并发/切项目不得改写已发出的 body。
    const ensureCwd = cwd;
    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: ensureCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      // 真实 sid 一旦返回即写入 ref：后续 prompt/SSE 失败也必须复用，禁止二次创建。
      sessionIdRef.current = realId;
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionModel, newSessionDefaultModel, toolPreset, thinkingLevel]);

  const loadSlashCommands = useCallback(async () => {
    // 只读会话：get_commands 会经 /api/agent 启动 AgentSession，直接返回空集。
    if (isReadOnly) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    // 新会话空态：禁止因 slash 菜单 mount 而提前 POST /api/agent/new。
    // 仅当已有真实 sid（用户已写操作 ensure 成功）才拉 commands。
    const sid = sessionIdRef.current ?? session?.id ?? null;
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [isReadOnly, session?.id]);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    // 当前调用点均已按能力门禁；保留显式错误，防止未来误把只读会话接入 SSE。
    if (!capabilities.canConnectEvents) {
      return Promise.reject(new Error("Read-only sessions do not connect to agent events"));
    }
    const manager = eventStreamManagerRef.current!;
    return manager.connect(sid, (event) => {
      handleAgentEventRef.current?.(event as unknown as AgentEvent);
    });
  }, [capabilities.canConnectEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    if (!capabilities.canConnectEvents) return;
    try {
      await eventStreamManagerRef.current!.ensureConnected(sid, (event) => {
        handleAgentEventRef.current?.(event as unknown as AgentEvent);
      });
    } finally {
      // 同步外部可见的 eventSourceRef，保留清理与既有消费者的读取契约。
      eventSourceRef.current = eventStreamManagerRef.current?.getCurrentSource() as unknown as EventSource | null;
    }
  }, [capabilities.canConnectEvents]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest | ExtensionUiInlineRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    if (!capabilities.canSendSessionCommands) return;
    const sid = sessionIdRef.current;
    // 按 id 从 FIFO 移除并推进；旧卡片延迟回调若 id 已不在队列则忽略，绝不伪造响应。
    const currentState = extensionUiStateRef.current;
    const nextState = clearExtensionUiRequest(currentState, request.id);
    if (nextState === currentState) return;
    commitExtensionUiState(nextState);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, [capabilities.canSendSessionCommands, commitExtensionUiState]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    if (!capabilities.canSendSessionCommands) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    // 关闭或切换到下一次 custom 请求后，旧输入事件不能再写入代理会话。
    if (extensionUiStateRef.current.customUi?.id !== request.id) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, [capabilities.canSendSessionCommands]);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    const result = applyExtensionUiRequest(extensionUiStateRef.current, request);
    commitExtensionUiState(result.state);
    for (const effect of result.effects) {
      if (effect.type === "notice") {
        addNotice({ id: effect.id, message: effect.message, type: effect.noticeType });
      } else if (effect.type === "setTitle") {
        document.title = effect.title;
      } else {
        opts.chatInputRef?.current?.insertText(effect.text);
      }
    }
  }, [addNotice, commitExtensionUiState, opts.chatInputRef]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId?: number) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (runId !== undefined && promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      optimisticUserMessageKeyRef.current = null;
      if (!agentRunningRef.current) return;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      dispatch({ type: "end" });
      onAgentEnd?.();
    }
  }, [loadSession, onAgentEnd]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as prompt_done.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: state.extensionStatuses ?? [] });
        if (state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: state.extensionWidgets ?? [] });
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, patchExtensionUiState]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // A late agent_end can arrive over SSE after reconcileAgentState
        // already finished this run — don't re-trigger completion.
        if (!agentRunningRef.current) break;
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) patchExtensionUiState({ statuses: d.state.extensionStatuses ?? [] });
              if (d.state?.extensionWidgets !== undefined) patchExtensionUiState({ widgets: d.state.extensionWidgets ?? [] });
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "prompt_done":
        if (!agentRunningRef.current) break;
        void finishPromptWithoutStream(sessionIdRef.current);
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, finishPromptWithoutStream, handleExtensionUiRequest, loadSession, onAgentEnd, patchExtensionUiState]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    // 只读会话：发送入口 UI 已替换为提示条，这里再拦一层。
    if (isReadOnly) return;
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) return;
    // 分支切换/摘要进行中：prompt 会与 navigateTree 并发写会话文件，先拦住。
    if (branchBusyRef.current) {
      addNotice({ type: "info", message: "Branch switch in progress — please wait" });
      return;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    // 发送即回到 following 并 instant 到底（pin 在 messages effect 中等 DOM 就绪执行），
    // 不再把刚发出的用户消息 smooth 推到顶部。
    notifyAutoFollowSend();

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      let sentSessionId: string | null = null;
      if (isNew && newSessionCwdRef.current) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          // ensure 成功即 promote：即使后续 SSE/prompt 失败也保留 sid，禁止二次创建。
          promoteNewSession(1, message);
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      if (e instanceof EventStreamConnectionError) {
        const optimisticKey = optimisticUserMessageKeyRef.current;
        if (optimisticKey) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "user" && userMessageKey(last) === optimisticKey
              ? prev.slice(0, -1)
              : prev;
          });
        }
        addNotice({ type: "error", message: e.message });
      }
      optimisticUserMessageKeyRef.current = null;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, isReadOnly, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, notifyAutoFollowSend]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    // 只读会话：bash 命令同样会写 session 文件，拦截。
    if (isReadOnly) return;
    if (agentRunningRef.current || bashRunningRef.current || branchBusyRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      // ensure 成功即 promote（写操作已创建 Pi session）。
      promoteNewSession(1, inputText);
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, isReadOnly, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    // 只读会话没有任何运行中的 agent，abort 无意义且不发送。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, [isReadOnly]);

  const handleFork = useCallback(async (entryId: string) => {
    // 只读会话：fork 会创建新 session 文件，拦截。
    if (isReadOnly) return;
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [isReadOnly, onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current || branchBusyRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (isReadOnly) {
      // 只读降级：分支切换只发纯 GET context，不发 navigate_tree 写命令。
      setActiveLeafId(entryId);
      await loadContext(sid, entryId);
      return;
    }
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [isReadOnly, loadContext]);

  const refreshRetracted = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isReadOnly) {
      setRetractedMessages([]);
      return;
    }
    try {
      const res = await sendAgentCommand<{ retracted?: RetractedRecord[] }>(sid, { type: "list_retracted" });
      setRetractedMessages(res?.retracted ?? []);
    } catch {
      // 未持久化会话等场景无此命令：静默保持空坞。
    }
  }, [isReadOnly]);

  useEffect(() => {
    void refreshRetracted();
  }, [session?.id, refreshRetracted]);

  /**
   * 撤回消息 M：navigate_tree(M.parentId)（Pi 原生分支语义，文件保留）。
   * 工作区还原由已安装扩展经 session_before_tree 被动完成，不绑定插件。
   */
  const handleRetractMessage = useCallback(async (entryId: string) => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: agentRunningRef.current || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<{ ok?: boolean; cancelled?: boolean; retracted?: RetractedRecord[] }>(
        sid,
        { type: "retract_message", entryId },
      );
      // cancelled（如插件 dirty 检查拒绝）：插件已 notify，静默保持现状。
      if (result?.cancelled) return;
      if (result?.retracted) setRetractedMessages(result.retracted);
      await loadSession(sid, false, false, true, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, loadSession]);

  /** 恢复消息 M：navigate_tree(M 链尾)，工作区由插件被动恢复。 */
  const handleRestoreMessage = useCallback(async (entryId: string) => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: agentRunningRef.current || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<{ ok?: boolean; cancelled?: boolean; retracted?: RetractedRecord[] }>(
        sid,
        { type: "restore_message", entryId },
      );
      if (result?.cancelled) return;
      if (result?.retracted) setRetractedMessages(result.retracted);
      await loadSession(sid, false, false, true, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, loadSession]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current || branchBusyRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    // 只读会话不持久化分支位置（navigate_tree 会写会话状态）。
    if (leafId && !isReadOnly) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [isReadOnly, loadContext]);

  /**
   * 带选项的分支切换（D3）：直接 / 默认摘要 / 自定义焦点。
   * 取消或中止保留当前 context；成功后整体重新 GET，让 tree/active leaf/context/
   * branch_summary 即时一致。SDK 导航到 user message 返回的 editorText 回填输入框，
   * 维持既有「从该处编辑」行为。
   */
  const navigateBranch = useCallback(async (targetId: string, choice: BranchSwitchChoice): Promise<BranchActionResult> => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: agentRunningRef.current || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return { kind: gate.reason === "busy" ? "busy" : "error" };
    const command = buildBranchSwitchCommand(targetId, choice);
    if (!command) return { kind: "error" };
    const sid = sessionIdRef.current;
    if (!sid) return { kind: "error" };
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<{
        cancelled?: boolean;
        aborted?: boolean;
        editorText?: string;
      }>(sid, command);
      // 取消/中止：用户主动行为，保留当前 context，静默返回。
      if (result?.cancelled || result?.aborted) return { kind: "cancelled" };
      if (typeof result?.editorText === "string" && result.editorText !== "") {
        opts.chatInputRef?.current?.insertIfEmpty(result.editorText);
      }
      const refreshed = await loadSession(sid, false, false, true, true);
      if (!refreshed) {
        const message = "Failed to refresh session after switching branches";
        addNotice({ type: "error", message });
        return { kind: "error", message };
      }
      return { kind: "ok" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
      return { kind: "error", message };
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, loadSession, opts.chatInputRef]);

  /**
   * 设置/清除分支书签（D3）：只经 set_branch_label 命令，不直接写会话文件；
   * 成功后整体刷新，让 tree 上的书签即时一致。rawLabel 传空串表示清除。
   */
  const setBranchLabel = useCallback(async (targetId: string, rawLabel: string): Promise<BranchActionResult> => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: agentRunningRef.current || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return { kind: gate.reason === "busy" ? "busy" : "error" };
    const command = buildSetBranchLabelCommand(targetId, rawLabel);
    if (!command) return { kind: "error" };
    const sid = sessionIdRef.current;
    if (!sid) return { kind: "error" };
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      await sendAgentCommand(sid, command);
      const refreshed = await loadSession(sid, false, false, true);
      if (!refreshed) {
        const message = "Failed to refresh session after saving the bookmark";
        addNotice({ type: "error", message });
        return { kind: "error", message };
      }
      return { kind: "ok" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
      return { kind: "error", message };
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, loadSession]);

  const branchActions = useMemo<BranchActions>(() => ({
    canWrite: capabilities.canSendSessionCommands,
    busy: branchBusy,
    navigate: navigateBranch,
    setLabel: setBranchLabel,
  }), [capabilities.canSendSessionCommands, branchBusy, navigateBranch, setBranchLabel]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    // 只读会话：set_model 会写会话状态，拦截。
    if (isReadOnly) return;
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, isReadOnly, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    // 只读会话：compact 会重写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, isReadOnly, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    // 只读会话：内置 slash 命令（compact/reload/name/session/copy）全部走 RPC，拦截。
    if (isReadOnly) return { handled: false };
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    // 内置 slash 是明确写命令：允许 ensure；读资源路径不得走这里。
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (sid && isNew) promoteNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, isNew, isReadOnly, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    // 只读会话：steer 会写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, [isReadOnly]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    // 只读会话：排队 prompt 同样写 session，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
    }
  }, [isReadOnly]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    // 只读会话：follow-up 会写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, [isReadOnly]);

  const handleAbortCompaction = useCallback(async () => {
    // 只读会话不存在进行中的 compact，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, [isReadOnly]);

  const handleRecallQueue = useCallback(async () => {
    // 只读会话没有队列（state 从不加载），拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, isReadOnly, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    // 只读会话：set_thinking_level 会写会话状态，拦截。
    if (isReadOnly) return;
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isReadOnly]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    // 只读会话：set_tools 会写会话状态，拦截。
    if (isReadOnly) return;
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [isReadOnly, setToolPresetState]);

  /**
   * Workspace History 命令：仅通过 type:prompt 派发 slash 到扩展，
   * 禁止本地 git checkout/reset 或 { command: "undo" } 形态。
   * isReadOnly / agentRunning / bashRunning / branchBusy 时直接 return（与 handleSend 门禁对齐）。
   */
  const dispatchWorkspaceHistoryPrompt = useCallback(async (message: string) => {
    if (isReadOnly) return;
    if (agentRunningRef.current || bashRunningRef.current || branchBusyRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "prompt", message });
      await loadSession(sid, false, true);
    } catch (e) {
      console.error("Workspace history prompt failed:", e);
      addNotice({ type: "error", message: String(e) });
    }
  }, [addNotice, isReadOnly, loadSession]);

  const handleWorkspaceUndo = useCallback(async () => {
    await dispatchWorkspaceHistoryPrompt("/undo");
  }, [dispatchWorkspaceHistoryPrompt]);

  const handleWorkspaceRedo = useCallback(async () => {
    await dispatchWorkspaceHistoryPrompt("/redo");
  }, [dispatchWorkspaceHistoryPrompt]);

  const handleWorkspaceCheckpoint = useCallback(async (label?: string) => {
    const trimmed = typeof label === "string" ? label.trim() : "";
    const message = trimmed ? `/checkpoint ${trimmed}` : "/checkpoint";
    await dispatchWorkspaceHistoryPrompt(message);
  }, [dispatchWorkspaceHistoryPrompt]);

  // 会话切换：清空阻塞队列与可见卡片；不发送 extension_ui_response。
  useEffect(() => {
    const current = extensionUiStateRef.current;
    commitExtensionUiState({
      ...clearAllExtensionUiBlocking(current),
      customUi: null,
    });
  }, [session?.id, newSessionCwd, commitExtensionUiState]);

  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      if (session.readOnly === true) {
        // 只读会话：只走 GET 详情读取路径。不拉 /state、不连 per-session SSE、
        // 不触发任何会启动 AgentSession 的调用；历史消息与分支树照常展示。
        void loadSession(session.id, true, false);
      } else {
        loadSession(session.id, true, true).then((agentState) => {
          // includeState=true 的运行时不会返回 true；该分支仅收窄 loadSession 的联合返回类型。
          if (agentState === true) return;
          if (agentState?.running) {
            loadTools(session.id);
            if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
              agentRunningRef.current = true;
              setAgentRunning(true);
              setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
              dispatch({ type: "start" });
              void connectEvents(session.id);
              if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
                void waitForPromptSettlement(session.id);
              }
            }
            if (agentState.state?.isBashRunning) {
              bashRunningRef.current = true;
              setBashRunning(true);
              void waitForBashSettlement(session.id);
            }
          }
          if (agentState?.state) {
            if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
            if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
            if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
            if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
            if (agentState.state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: agentState.state.extensionStatuses ?? [] });
            if (agentState.state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: agentState.state.extensionWidgets ?? [] });
            if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
          }
        });
      }
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      eventStreamManagerRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchActions);
  }, [data?.tree, activeLeafId, handleLeafChange, branchActions, onBranchDataChange]);

  // 同步稳定容器元素：loading 结束 / 空会话→有消息 时容器才挂载；仅元素身份变化才更新 state。
  useEffect(() => {
    const el = scrollContainerRef.current;
    setScrollContainerEl((prev) => (prev === el ? prev : el));
  }, [loading, messages.length, isNew]);

  // 向上意图监听：wheel deltaY<0、触摸下拉、ArrowUp/PageUp/Home 立即 release。
  // 发生在可自己向上滚的嵌套区时让嵌套区优先消费，不误 release。
  // 依赖 scrollContainerEl（非 messages.length），避免每条消息断开重绑。
  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;

    const releaseOnUpIntent = () => {
      applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "up-intent" }));
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      if (isInsideNestedUpScrollable(event.target, container)) return;
      releaseOnUpIntent();
    };

    let touchStartY: number | null = null;
    let touchTarget: EventTarget | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
      touchTarget = event.target;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchStartY === null) return;
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      // 手指向下滑动 = 内容向上走 = 向上阅读意图；超过 4px 阈值才判定一次
      if (y - touchStartY > 4) {
        if (!isInsideNestedUpScrollable(touchTarget, container)) releaseOnUpIntent();
        touchStartY = null;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!RELEASE_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      releaseOnUpIntent();
    };

    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [scrollContainerEl, applyAutoFollowMode]);

  // scroll 几何判定：程序化写入窗口（prepend 补偿、扩展卡片、smooth pin）内不判状态。
  // 其余规则：到真实底部恢复；向下进入末端区域恢复；following 中向上位移即 release。
  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    const onScroll = () => {
      const now = Date.now();
      const previousTop = lastScrollTopRef.current;
      const nextTop = container.scrollTop;
      lastScrollTopRef.current = nextTop;
      if (now < externalWriteUntilRef.current || now < programmaticSmoothUntilRef.current) {
        updateJumpButtonVisibility();
        return;
      }
      applyAutoFollowMode(
        reduceAutoFollow(autoFollowModeRef.current, {
          kind: "scroll",
          distance: getDistanceFromBottom(container.scrollHeight, nextTop, container.clientHeight),
          direction: getScrollDirection(previousTop, nextTop),
          zoneSize: getBottomZoneSize(container.clientHeight, isMobileRef.current),
        }),
      );
      updateJumpButtonVisibility();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerEl, applyAutoFollowMode, updateJumpButtonVisibility]);

  // agent/bash 结束后的 settle 窗口：覆盖高亮、图片等滞后重排。
  useEffect(() => {
    const busy = agentRunning || bashRunning;
    if (wasSessionBusyRef.current && !busy) {
      runSettleUntilRef.current = Date.now() + RUN_SETTLE_MS;
    }
    wasSessionBusyRef.current = busy;
  }, [agentRunning, bashRunning]);

  // 内容尺寸监听：仅 following 且（运行中 / settle 窗口 / entry-stick）时 instant 钉底。
  // ResizeObserver 回调在 paint 前触发，钉底不产生可见跳动；released 时只更新按钮。
  // 依赖 scrollContainerEl，不因 messages.length 断开重绑。
  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    const content = container.firstElementChild;
    const onResize = () => {
      const now = Date.now();
      if (entryStickArmedAtRef.current !== null) entryLastGrowthAtRef.current = now;
      if (autoFollowModeRef.current !== "following") {
        updateJumpButtonVisibility();
        return;
      }
      if (now < programmaticSmoothUntilRef.current) return;
      // prepend 等外部 scrollTop 写入窗口内：只刷新 jump 按钮，禁止钉底覆盖补偿。
      if (now < externalWriteUntilRef.current) {
        updateJumpButtonVisibility();
        return;
      }
      const busy = agentRunningRef.current || bashRunningRef.current;
      const settling = now < runSettleUntilRef.current;
      const entryActive = isEntryStickActive(now, entryStickArmedAtRef.current, entryLastGrowthAtRef.current);
      if (busy || settling || entryActive) pinToBottom("instant");
      updateJumpButtonVisibility();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scrollContainerEl, pinToBottom, updateJumpButtonVisibility]);

  // DOM 就绪后的 instant pin：发送消息 / 分支重置（pending*）与初次打开会话
  // （following + entry-stick）。following 期间的后续增长全部由 ResizeObserver 负责。
  // 依赖 messages（非仅 length）：分支切换条数不变时仍能消费 pendingResetPinRef。
  useEffect(() => {
    if (messages.length === 0) return;
    if (!scrollContainerRef.current) return;
    if (pendingSendPinRef.current || pendingResetPinRef.current) {
      pendingSendPinRef.current = false;
      pendingResetPinRef.current = false;
      initialScrollDoneRef.current = true;
      pinToBottom("instant");
    } else if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      const now = Date.now();
      entryStickArmedAtRef.current = now;
      entryLastGrowthAtRef.current = now;
      pinToBottom("instant");
    }
    updateJumpButtonVisibility();
  }, [messages, pinToBottom, updateJumpButtonVisibility]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      prefersReducedMotionRef.current = mql.matches;
    };
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, observationalMemory, workspaceHistory, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, extensionDialog, extensionInlineRequest, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, dismissExtensionUiRequest, sendExtensionCustomInput,
    todos,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, scrollContainerRef,
    // 自动跟随
    jumpButtonVisible, jumpToBottom, markExternalScrollWrite, notifyProgrammaticSmooth,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Workspace History（仅 type:prompt 派发到扩展）
    handleWorkspaceUndo, handleWorkspaceRedo, handleWorkspaceCheckpoint,
    retractedMessages, handleRetractMessage, handleRestoreMessage,
    // 分支书签与带选项切换（D3）
    branchBusy, branchActions, navigateBranch, setBranchLabel,
    // Subscriptions
    handleAgentEventRef,
  };
}
