"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { RightWorkspace } from "./RightWorkspace";
import { SettingsView } from "./SettingsView";
import { BranchNavigator } from "./BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/clipboard";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import {
  EMPTY_FILE_EDITOR_STATE,
  fileEditorReducer,
  getBuffer,
  hasDirtyBuffers,
  makeFileBufferKey,
} from "@/lib/file-editor-state";
import { buildAtMentionText, buildFileAtMentionsText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { ProjectProvider, useProjectActions, useProjectIdentity } from "./ProjectProvider";
import { useI18n } from "@/lib/i18n";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export function AppShell() {
  return <ProjectProvider><AppShellInner /></ProjectProvider>;
}

function AppShellInner() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { isDark, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [workspaceWidth, setWorkspaceWidth] = useState(288);
  const [mobileWorkspaceReady, setMobileWorkspaceReady] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setWorkspaceOpen(false);
    }
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
    setMobileWorkspaceReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session") => {
    if (isMobile) {
      setSidebarOpen(false);
      setWorkspaceOpen(false);
    }
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setWorkspaceOpen(false);
    }
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      setWorkspaceOpen(false);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const handleWorkspaceToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
    }
    setWorkspaceOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // 中央工作区文件 tabs：Chat 固定首 tab，文件预览不进入最右窄栏。
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [fileEditorState, dispatchFileEditor] = useReducer(fileEditorReducer, EMPTY_FILE_EDITOR_STATE);
  const fileEditorStateRef = useRef(fileEditorState);
  fileEditorStateRef.current = fileEditorState;
  const dispatchFileEditorAction = useCallback((action: Parameters<typeof fileEditorReducer>[1]) => {
    // 同步镜像让异步保存回调能看到尚未经过 React render 的最新键入 revision。
    fileEditorStateRef.current = fileEditorReducer(fileEditorStateRef.current, action);
    dispatchFileEditor(action);
  }, []);

  useEffect(() => {
    if (!hasDirtyBuffers(fileEditorState)) return;
    const protectDirtyBuffers = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDirtyBuffers);
    return () => window.removeEventListener("beforeunload", protectDirtyBuffers);
  }, [fileEditorState]);

  const saveFileBuffer = useCallback(async (key: string): Promise<boolean> => {
    const buffer = getBuffer(fileEditorStateRef.current, key);
    if (!buffer || !buffer.sourceSessionId || !buffer.dirty || buffer.saveState === "saving") return false;
    const requestId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const requestRevision = buffer.revision;
    const requestedContent = buffer.content;
    dispatchFileEditorAction({ type: "markSaving", key, requestId, requestRevision });
    try {
      const encoded = encodeFilePathForApi(buffer.filePath);
      const params = new URLSearchParams({ type: "save", sessionId: buffer.sourceSessionId });
      const response = await fetch(`/api/files/${encoded}?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: requestedContent, baseline: buffer.baseline }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        size?: number;
        mtimeMs?: number;
        baseline?: { size: number; mtimeMs: number };
      };
      if (response.status === 409) {
        dispatchFileEditorAction({
          type: "saveConflict",
          key,
          requestId,
          baseline: body.baseline,
          message: body.error ?? t("viewer_externalChange"),
        });
        return false;
      }
      if (!response.ok || typeof body.size !== "number" || typeof body.mtimeMs !== "number") {
        throw new Error(body.error ?? t("app_saveFailed", { status: response.status }));
      }
      dispatchFileEditorAction({
        type: "saveSuccess",
        key,
        requestId,
        requestRevision,
        savedContent: requestedContent,
        baseline: { size: body.size, mtimeMs: body.mtimeMs },
      });
      setExplorerRefreshKey((value) => value + 1);
      // 若保存过程中继续输入，服务器保存成功但 tab 仍有新草稿，不能用于“保存并关闭”。
      const latest = getBuffer(fileEditorStateRef.current, key);
      return Boolean(latest && latest.revision === requestRevision && !latest.dirty);
    } catch (error) {
      dispatchFileEditorAction({
        type: "saveError",
        key,
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [dispatchFileEditorAction, t]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const identity = useProjectIdentity();
  const { setIdentity } = useProjectActions();
  const activeCwd = identity.cwd;
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // URL 恢复和首次身份建立不应清理当前聊天。
  const suppressSessionResetRef = useRef(false);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressSessionResetRef.current = true;
        setIdentity({ cwd: data.cwd, projectRoot: data.cwd, status: "ready", error: null });
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation, setIdentity]);

  const previousProjectIdentityRef = useRef({ cwd: identity.cwd, projectRoot: identity.projectRoot });
  useEffect(() => {
    const previous = previousProjectIdentityRef.current;
    const current = { cwd: identity.cwd, projectRoot: identity.projectRoot };
    previousProjectIdentityRef.current = current;
    const cwdChanged = previous.cwd !== current.cwd;
    const projectChanged = previous.projectRoot !== current.projectRoot;
    if (!cwdChanged && !projectChanged) return;
    if (suppressSessionResetRef.current) {
      suppressSessionResetRef.current = false;
      return;
    }
    if (previous.cwd === null && previous.projectRoot === null) return;
    if (selectedSession && (selectedSession.projectRoot ?? selectedSession.cwd) === current.projectRoot) return;
    if (selectedSession) setSelectedSession(null);
    if (!selectedSession && !cwdChanged) return;
    setSessionKey((key) => key + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [identity.cwd, identity.projectRoot, router, selectedSession]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // URL session 恢复会同时建立项目身份；跳过紧随其后的身份 watcher。
      suppressSessionResetRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile]);

  const handleNewSession = useCallback(() => {
    setSelectedSession(null);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: () => handleNewSession(),
    activeCwd,
    disabled: settingsOpen,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // subagent 结果卡片按会话文件路径跳转到侧栏已发现的只读子会话。
  // 子会话由 /api/sessions 的嵌套发现返回，这里只做路径匹配与选中，
  // 不创建 AgentSession，也不改变子会话的只读能力门禁。
  const handleOpenSubagentSession = useCallback((sessionFile: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const match = d?.sessions.find((s) => s.path === sessionFile);
        if (match) handleSelectSession(match);
      })
      .catch(() => {});
  }, [handleSelectSession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    // 只读会话：auto-name 会改名（写操作），UI 层先拦（后端仍是权威防线）。
    if (!sessionId || selectedSession?.readOnly === true || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id, selectedSession?.readOnly]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      setSelectedSession(null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null, writable = false) => {
    const bufferKey = makeFileBufferKey(filePath, sourceSessionId);
    const tabId = `file:${bufferKey}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId, bufferKey, writable, readOnly: !writable }];
      return prev;
    });
    setPendingCloseTabId(null);
    setActiveFileTabId(tabId);
    // 移动端文件预览在中央主工作区显示：关闭左右抽屉，避免三层覆盖。
    if (isMobile) {
      setSidebarOpen(false);
      setWorkspaceOpen(false);
    }
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null, Boolean(selectedSession?.id && selectedSession.readOnly !== true));
  }, [handleOpenFile, selectedSession?.id, selectedSession?.readOnly]);

  const closeFileTabNow = useCallback((tabId: string, removeBuffer = true) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    if (removeBuffer && tab?.bufferKey) dispatchFileEditorAction({ type: "remove", key: tab.bufferKey });
    setFileTabs((prev) => {
      return prev.filter((t) => t.id !== tabId);
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
    setPendingCloseTabId((current) => current === tabId ? null : current);
  }, [dispatchFileEditorAction, fileTabs]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    const buffer = tab?.bufferKey ? getBuffer(fileEditorStateRef.current, tab.bufferKey) : undefined;
    if (buffer?.dirty) {
      setActiveFileTabId(tabId);
      setPendingCloseTabId(tabId);
      return;
    }
    closeFileTabNow(tabId);
  }, [closeFileTabNow, fileTabs]);

  const handleSaveAndClose = useCallback(async () => {
    const tab = fileTabs.find((item) => item.id === pendingCloseTabId);
    if (!tab?.bufferKey) return;
    if (await saveFileBuffer(tab.bufferKey)) closeFileTabNow(tab.id);
  }, [closeFileTabNow, fileTabs, pendingCloseTabId, saveFileBuffer]);

  const handleDiscardAndClose = useCallback(() => {
    const tab = fileTabs.find((item) => item.id === pendingCloseTabId);
    if (!tab) return;
    if (tab.bufferKey) {
      dispatchFileEditorAction({ type: "discard", key: tab.bufferKey });
      dispatchFileEditorAction({ type: "remove", key: tab.bufferKey });
    }
    closeFileTabNow(tab.id, false);
  }, [closeFileTabNow, dispatchFileEditorAction, fileTabs, pendingCloseTabId]);

  const centerTabs = useMemo<Tab[]>(() => [
    { id: "chat", label: t("app_chat"), filePath: "", kind: "chat" },
    ...fileTabs.map((tab) => {
      const buffer = tab.bufferKey ? getBuffer(fileEditorState, tab.bufferKey) : undefined;
      return { ...tab, dirty: buffer?.dirty, saving: buffer?.saveState === "saving" };
    }),
  ], [fileEditorState, fileTabs, t]);

  const handleSelectCenterTab = useCallback((tabId: string) => {
    setPendingCloseTabId(null);
    setActiveFileTabId(tabId === "chat" ? null : tabId);
  }, []);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = selectedSession === null ? activeCwd : null;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Deck` : "Pi Deck";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
      />
      {/* 底部 Settings：同规格图标按钮（24×24），不显示永久文字标签 */}
      <div style={{ padding: "6px 8px", flexShrink: 0, display: "flex", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={t("app_settings")}
          aria-label={t("app_settings")}
          className="sidebar-icon-btn"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.95 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.95a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.95 4.6 1.7 1.7 0 0 0 9.97 3.04V3h4v.08A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.42.52.98 1.56 1.03H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
        </button>
      </div>
    </>
  );

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
        .workspace-overlay-backdrop.workspace-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .workspace-container.workspace-mobile-pending.workspace-open {
          transform: translateX(100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        }}
      >
        {sidebarContent}
      </div>

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
          <button
            onClick={handleSidebarToggle}
            title={sidebarOpen ? t("app_hideSidebar") : t("app_showSidebar")}
            aria-label={sidebarOpen ? t("app_hideSidebar") : t("app_showSidebar")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
            title={isDark ? t("app_lightMode") : t("app_darkMode")}
            aria-label={isDark ? t("app_lightMode") : t("app_darkMode")}
            aria-pressed={isDark}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          {showChat && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              {(() => {
                const isReadOnly = selectedSession?.readOnly === true;
                const hasMessages = Boolean(
                  selectedSession
                  && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
                );
                const disabled = !selectedSession || isReadOnly || !hasMessages || autoNameStatus.kind === "naming";
                const isSuccess = autoNameStatus.kind === "success";
                const isError = autoNameStatus.kind === "error";
                const label = autoNameStatus.kind === "naming"
                  ? t("app_titleGenerating")
                  : isSuccess
                    ? t("app_titleGenerated")
                    : isError
                      ? t("app_titleGenerationFailed")
                      : t("app_generateTitle");
                const title = !selectedSession
                  ? t("app_titleGenerationDisabledReason")
                  : isReadOnly
                    ? t("app_titleGenerationDisabled")
                    : !hasMessages
                      ? t("app_titleGenerationDisabledReason")
                      : isError
                        ? autoNameStatus.message
                        : t("app_generateTitle");

                return (
                  <button
                    type="button"
                    onClick={() => void handleAutoName()}
                    disabled={disabled}
                    title={title}
                    aria-label={label}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      height: "100%", padding: "0 12px",
                      background: "none", border: "none",
                      borderTop: "2px solid transparent",
                      borderRight: "1px solid var(--border)",
                      color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                      flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                      transition: "color 0.1s, background 0.1s, opacity 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (disabled) return;
                      e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                      e.currentTarget.style.background = "none";
                    }}
                  >
                    {autoNameStatus.kind === "naming" ? (
                      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isSuccess ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 4 5 5L7 22l-5-5Z" />
                        <path d="m14 5 5 5" />
                        <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                      </svg>
                    )}
                    {!isMobile && <span>{label}</span>}
                  </button>
                );
              })()}
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                compact={isMobile}
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                onClick={() => toggleTopPanel("system")}
                title={t("app_systemPrompt")}
                aria-label={t("app_systemPrompt")}
                aria-pressed={activeTopPanel === "system"}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                {!isMobile && <span>{t("app_system")}</span>}
              </button>
            </div>
          )}
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
            const tokenStats = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
            if (tokenStats) {
              tooltipParts.push(`${t("app_input")}: ${tokenStats.input.toLocaleString()}`);
              tooltipParts.push(`${t("app_output")}: ${tokenStats.output.toLocaleString()}`);
              tooltipParts.push(`${t("app_cacheRead")}: ${tokenStats.cacheRead.toLocaleString()}`);
              tooltipParts.push(`${t("app_cacheWrite")}: ${tokenStats.cacheWrite.toLocaleString()}`);
              if (c > 0) tooltipParts.push(`${t("app_cost")}: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(t("app_contextTooltip", { pct: pct !== null ? pct.toFixed(1) + "%" : t("app_unknown"), total: contextUsage.contextWindow.toLocaleString() }));
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => toggleTopPanel("session")}
                title={tooltip || t("app_sessionInfo")}
                aria-label={t("app_sessionInfo")}
                aria-pressed={activeTopPanel === "session"}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {isMobile && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                )}
                {!isMobile && tokenStats && tokenStats.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                    {fmt(tokenStats.input)}
                  </span>
                )}
                {!isMobile && tokenStats && tokenStats.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {fmt(tokenStats.output)}
                  </span>
                )}
                {!isMobile && tokenStats && tokenStats.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                    {fmt(tokenStats.cacheRead)}
                  </span>
                )}
                {!isMobile && costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* 最右侧 Files/Git 工作区开关：在顶栏内占位，不再固定覆盖内容 */}
          <button
            type="button"
            onClick={handleWorkspaceToggle}
            title={workspaceOpen ? t("app_hideFiles") : t("app_showFiles")}
            aria-label={workspaceOpen ? t("app_hideFiles") : t("app_showFiles")}
            aria-pressed={workspaceOpen}
            style={{
              marginLeft: showChat && (sessionStats || contextUsage) ? 0 : "auto",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: workspaceOpen ? "var(--bg-selected)" : "none",
              border: "none", borderLeft: "1px solid var(--border)",
              color: workspaceOpen ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
              transition: "background 0.12s, color 0.12s",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {selectedSession?.readOnly === true ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("app_systemPromptReadOnlyHint")}
                    </div>
                  ) : systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("app_systemPromptEmptyHint")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("app_systemPromptAfterMessageHint")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const sessionRows = [
                      ...(sessionStats.sessionName ? [{ label: t("app_name"), value: sessionStats.sessionName, copyField: null }] : []),
                      { label: t("app_file"), value: sessionStats.sessionFile ?? t("app_inMemory"), copyField: "file" as const },
                      { label: t("app_id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                      [t("app_user"), sessionStats.userMessages.toLocaleString()],
                      [t("app_assistant"), sessionStats.assistantMessages.toLocaleString()],
                      [t("app_toolCalls"), sessionStats.toolCalls.toLocaleString()],
                      [t("app_toolResults"), sessionStats.toolResults.toLocaleString()],
                      [t("app_total"), sessionStats.totalMessages.toLocaleString()],
                    ];
                    const tokenRows = [
                      [t("app_input"), sessionStats.tokens.input.toLocaleString()],
                      [t("app_output"), sessionStats.tokens.output.toLocaleString()],
                      ...(sessionStats.tokens.cacheRead > 0 ? [[t("app_cacheRead"), sessionStats.tokens.cacheRead.toLocaleString()]] : []),
                      ...(sessionStats.tokens.cacheWrite > 0 ? [[t("app_cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString()]] : []),
                      [t("app_total"), sessionStats.tokens.total.toLocaleString()],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                      ...(sessionStats.cost > 0 ? [[t("app_cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                      ...(ctx?.contextWindow ? [[t("app_context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? t("app_copied") : field === "file" ? t("app_copyFilePath") : t("app_copySessionId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{t("app_sessionInfo")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                        {section(t("app_messages"), messageRows)}
                        {section(t("app_tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("app_sessionInfoAfterMessageHint")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* 中央主工作区 tab：只有打开文件时出现，Chat 固定首项 */}
        {fileTabs.length > 0 && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
            <TabBar
              tabs={centerTabs}
              activeTabId={activeFileTabId ?? "chat"}
              onSelectTab={handleSelectCenterTab}
              onCloseTab={handleCloseFileTab}
            />
            {pendingCloseTabId && fileTabs.some((tab) => tab.id === pendingCloseTabId) && (
              <div className="file-close-confirm" role="alert">
                <span className="file-close-confirm__message">{t("app_unsavedChangesIn", { name: fileTabs.find((tab) => tab.id === pendingCloseTabId)?.label ?? "" })}</span>
                <button type="button" className="file-close-confirm__button" onClick={() => void handleSaveAndClose()} title={t("app_saveAndClose")} aria-label={t("app_saveAndClose")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  <span>{t("app_saveAndClose")}</span>
                </button>
                <button type="button" className="file-close-confirm__button is-danger" onClick={handleDiscardAndClose} title={t("app_discardChanges")} aria-label={t("app_discardChanges")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="m19 6-1 14H6L5 6m3 0V4h8v2"/></svg>
                  <span>{t("app_discardChanges")}</span>
                </button>
                <button type="button" className="file-close-confirm__button" onClick={() => setPendingCloseTabId(null)} title={t("app_cancelClosing")} aria-label={t("app_cancelClosing")}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  <span>{t("common_cancel")}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chat 保持挂载：切到文件 tab 只视觉隐藏，SSE/流式状态与滚动不丢失 */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div style={{ display: activeFileTab ? "none" : "block", height: "100%", overflow: "hidden", position: "relative" }}>
            {showChat ? (
              <ChatWindow
                key={sessionKey}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onBranchDataChange={handleBranchDataChange}
                onSystemPromptChange={handleSystemPromptChange}
                onSessionStatsChange={handleSessionStatsChange}
                onSessionStatsPanelOpen={openSessionStatsPanel}
                onContextUsageChange={handleContextUsageChange}
                onOpenFile={handleOpenLinkedFile}
                onOpenSubagentSession={handleOpenSubagentSession}
              />
            ) : initialCwdStatus === "validating" ? (
              <div role="status" style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
                <div style={{ fontSize: 14, color: "var(--text)" }}>{t("app_openWorkspace")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>{initialNavigation.requestedCwd}</div>
              </div>
            ) : initialCwdStatus === "error" ? (
              <div role="alert" style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
                <div style={{ fontSize: 14, color: "#dc2626" }}>{t("app_workspaceUnavailable")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>{initialNavigation.requestedCwd}</div>
                <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
              </div>
            ) : showPlaceholder ? (
              activeCwd ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>{t("app_selectSessionFromSidebar")}</div>
              ) : (
                <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                    <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                  </svg>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("app_getStarted")}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("app_setupSelectProject")}<br />
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("app_setupAddModel")}
                    </div>
                  </div>
                </div>
              )
            ) : null}
          </div>

          {activeFileTab?.filePath && (
            <div style={{ height: "100%", overflow: "hidden" }}>
              <FileViewer
                filePath={activeFileTab.filePath}
                cwd={activeCwd ?? undefined}
                sourceSessionId={activeFileTab.sourceSessionId}
                writable={activeFileTab.writable === true}
                buffer={activeFileTab.bufferKey ? getBuffer(fileEditorState, activeFileTab.bufferKey) : undefined}
                dispatchBuffer={dispatchFileEditorAction}
                onSave={activeFileTab.bufferKey ? () => saveFileBuffer(activeFileTab.bufferKey!) : undefined}
                gitRefreshKey={explorerRefreshKey}
                onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath), activeFileTab.sourceSessionId, activeFileTab.writable === true)}
              />
            </div>
          )}
        </div>
      </div>

      {/* 移动端遮罩：点击关闭最右工作区 */}
      <div
        className={`sidebar-overlay-backdrop workspace-overlay-backdrop${mobileWorkspaceReady ? "" : " workspace-mobile-pending"}`}
        onClick={() => setWorkspaceOpen(false)}
        style={{
          position: "fixed", inset: 0, zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: workspaceOpen ? 1 : 0,
          pointerEvents: workspaceOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      <RightWorkspace
        open={workspaceOpen}
        width={workspaceWidth}
        onWidthChange={setWorkspaceWidth}
        onClose={() => setWorkspaceOpen(false)}
        cwd={activeCwd}
        isMobile={isMobile}
        mobileReady={mobileWorkspaceReady}
        onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName, selectedSession?.id ?? null, Boolean(selectedSession?.id && selectedSession.readOnly !== true))}
        fileRefreshKey={explorerRefreshKey}
        gitRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
      />
    </div>
    {settingsOpen && (
      <SettingsView
        cwd={activeCwd ?? selectedSession?.cwd ?? null}
        sessionId={selectedSession?.id ?? null}
        onClose={() => {
          setSettingsOpen(false);
          setModelsRefreshKey((key) => key + 1);
        }}
        onModelsChanged={() => {
          setSettingsOpen(false);
          setModelsRefreshKey((key) => key + 1);
        }}
        onPluginsReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    </>
  );
}
