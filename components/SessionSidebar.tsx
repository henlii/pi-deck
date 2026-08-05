"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { displayCwd, getRecentProjects } from "@/lib/project-context";
import {
  isSessionNodeEffectivelyCollapsed,
  normalizeSessionQuery,
  type SessionDisplayNode,
  type SessionRelationKind,
} from "./session-tree";
import {
  buildSidebarTree,
  collectAllCollapseIds,
  collectSubagentParentIdsFromSidebarTree,
  filterClosedProjects,
  filterSidebarTree,
  locateSessionInSidebarTree,
  pickProjectRootAfterClose,
  type SidebarProjectNode,
  type SidebarWorktreeGroup,
} from "./session-sidebar-model";
import {
  loadSidebarPreferences,
  saveSidebarPreferences,
  type ProjectAliases,
  type SidebarDisplayMode,
  type SidebarPreferences,
} from "@/lib/ui-preferences";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import {
  bumpGroupVisibleCount,
  getGroupVisibleCount,
  getVisibleTopLevelNodes,
  mergeOptimisticSessions,
  reconcilePendingSessionIds,
  resetGroupVisibleCount,
  shouldApplySessionListResponse,
  upsertProjectWorktreeSnapshot,
} from "./session-sidebar-state";
import { getSessionCapabilities } from "./session-capabilities";
import { useProjectActions, useProjectIdentity } from "./ProjectProvider";
import { ViewportDialog } from "./ui/ViewportDialog";
import { ProjectTrustBadge, ProjectTrustDialog, useProjectTrust, type ProjectTrustEntry } from "./ProjectTrust";
import { useI18n } from "@/lib/i18n";
import { loadUnreadSessionIds, saveUnreadSessionIds } from "@/lib/unread-sessions-storage";
import {
  AnimatedDropdown,
  BranchIcon,
  BranchPlusIcon,
  ChatPlusIcon,
  CheckIcon,
  ChevronButton,
  DialogButton,
  DisplayMenuItem,
  FolderIcon,
  FolderPlusIcon,
  formatRelativeTime,
  GroupPagination,
  HomeIcon,
  LayersIcon,
  PathLabel,
  PiWebTitle,
  RefreshIcon,
  RunningSessionIndicator,
  SearchIcon,
  SidebarIconButton,
  SlidersIcon,
  TrashIcon,
  UnreadSessionIndicator,
  WorktreeActions,
  XIcon,
} from "@/components/session-sidebar/display";
import { ProjectRowMenu, SessionRowMenu } from "@/components/session-sidebar/menus";
import { useWorktreePreload } from "@/hooks/useWorktreePreload";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (cwd?: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  /**
   * 真实 id 已返回、列表尚未回流的乐观会话列表（多 id）。
   * 内部按 id upsert 进 pending map，与 server 列表 merge。
   */
  optimisticSessions?: readonly SessionInfo[];
}


// ── 主组件 ─────────────────────────────────────────────────────────────────

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, optimisticSessions }: Props) {
  const { t } = useI18n();
  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const serverSessionsRef = useRef<SessionInfo[]>([]);
  const [pendingById, setPendingById] = useState<Map<string, SessionInfo>>(() => new Map());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionListFetchGenRef = useRef(0);
  const { cwd: selectedCwd, projectRoot: selectedProjectRoot } = useProjectIdentity();
  const { setIdentity } = useProjectActions();
  const [homeDir, setHomeDir] = useState<string>("");
  // 添加项目弹窗（ViewportDialog；原生目录选择仅在弹窗内填充输入，不直接提交）
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  // 目录选择（对齐上游 pi-web 0.8.6 directory-picker：手动 Go/Enter 浏览、
  // Select 只选已浏览路径；保留 OpenChamber 式 git 状态徽标）
  const [browseEntries, setBrowseEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [browseGit, setBrowseGit] = useState<{ isRepo: boolean; branch: string | null } | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseMissing, setBrowseMissing] = useState(false);
  /** 已浏览确认的路径（服务器 browse 响应的 path）；Select 只允许提交它 */
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  /** 服务器返回的 parentPath（.. 导航目标；根目录为 null） */
  const [browseParentPath, setBrowseParentPath] = useState<string | null>(null);
  // 桌面端原生目录选择器可用性（仅客户端探测，避免 SSR 水合不一致）
  const [desktopPickerAvailable, setDesktopPickerAvailable] = useState(false);
  // 项目行三点菜单：同一时刻仅一个打开（root 标识）
  const [openProjectMenuRoot, setOpenProjectMenuRoot] = useState<string | null>(null);
  // 编辑项目弹窗：目标项目根 + 名称草稿（打开时由 alias/路径显示名初始化）
  const [editProjectRoot, setEditProjectRoot] = useState<string | null>(null);
  const [editProjectValue, setEditProjectValue] = useState("");
  const editProjectInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [wtNewForProject, setWtNewForProject] = useState<string | null>(null);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  // worktree 错误归属的项目根：避免同一条错误在每个项目行重复显示。
  const [wtErrorRoot, setWtErrorRoot] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  // 搜索：查询与开关均为组件瞬时态，不写入偏好
  // subagent 活跃运行（子会话 + 等待中的主会话）；由 /api/subagent-runs 推导。
  const [subagentRunningIds, setSubagentRunningIds] = useState<Set<string>>(() => new Set());
  const subagentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  /** meta = 名称/首消息；fulltext = 消息正文（服务端 FTS/JSONL）。 */
  const [searchMode, setSearchMode] = useState<"meta" | "fulltext">("meta");
  const [fulltextHits, setFulltextHits] = useState<Array<{
    sessionId: string;
    snippet: string;
    timestamp: string;
    role?: string;
  }>>([]);
  const [fulltextSessionIds, setFulltextSessionIds] = useState<string[]>([]);
  const [fulltextSource, setFulltextSource] = useState<"fts" | "jsonl" | "none" | null>(null);
  const [fulltextLoading, setFulltextLoading] = useState(false);
  const [fulltextError, setFulltextError] = useState<string | null>(null);
  const fulltextRequestSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 显示模式菜单
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  // 跨刷新偏好：显示模式 + 项目/worktree 折叠集合（独立 seam）
  const [prefs, setPrefs] = useState<SidebarPreferences>(() => loadSidebarPreferences());
  // 每个主仓/非主 worktree group 的展开条数均为瞬时态，不写偏好。
  const [groupVisibleCounts, setGroupVisibleCounts] = useState<Record<string, number>>({});
  // 会话级 child 折叠：保持瞬时（沿用原行为）
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(() => new Set());
  // 用户已手动展开/折叠过的会话 id：默认 subagent 收起不得覆盖这些显式选择
  const userTouchedSessionCollapseRef = useRef<Set<string>>(new Set());
  const sessionListRef = useRef<HTMLDivElement>(null);
  const initialSelectionScrollDoneRef = useRef(false);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 偏好更新唯一入口：内存态与 localStorage 同步写。 */
  const updatePrefs = useCallback((updater: (prev: SidebarPreferences) => SidebarPreferences) => {
    setPrefs((prev) => {
      const next = updater(prev);
      if (next !== prev) {
        // sidebarWidth 的唯一 owner 是 AppShell；保存其它偏好时保留存储中的
        // 当前宽度，避免侧栏内存里的过期副本回写覆盖最近一次拖拽结果。
        saveSidebarPreferences({ ...next, sidebarWidth: loadSidebarPreferences().sidebarWidth });
      }
      return next;
    });
  }, []);

  const displayMode = prefs.displayMode;
  const collapsedProjectRoots = useMemo(() => new Set(prefs.collapsedProjectRoots), [prefs.collapsedProjectRoots]);
  const collapsedWorktreePaths = useMemo(() => new Set(prefs.collapsedWorktreePaths), [prefs.collapsedWorktreePaths]);
  // 已关闭项目集合：仅影响侧栏可见性与自动选择，绝不触碰会话/目录/Git 数据
  const closedRoots = useMemo(() => new Set(prefs.closedProjectRoots), [prefs.closedProjectRoots]);

  useEffect(() => {
    setDesktopPickerAvailable(typeof window !== "undefined" && Boolean(window.piDesktop?.selectDirectory));
  }, []);

  const pendingIdsRef = useRef(pendingIds);
  pendingIdsRef.current = pendingIds;

  const loadSessions = useCallback(async (showLoading = false) => {
    const gen = ++sessionListFetchGenRef.current;
    // OpenChamber SWR：首次冷启动先用本地缓存秒渲染侧栏（stale-while-
    // revalidate），服务器刷新成功后覆盖；fetch 失败时缓存内容保持可见。
    if (showLoading && serverSessionsRef.current.length === 0) {
      const cached = loadCachedSessionList();
      if (cached && cached.length > 0) {
        if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
        setServerSessions(cached);
        serverSessionsRef.current = cached;
        setLoading(false);
      }
    }
    try {
      if (showLoading && serverSessionsRef.current.length === 0) setLoading(true);
      const res = await fetch("/api/sessions");
      // 仅最新代际可写 serverSessions / loading / error / refresh done / unread 清理。
      // 卸载后不得 setState。
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      setServerSessions(data.sessions);
      serverSessionsRef.current = data.sessions;
      saveCachedSessionList(data.sessions);
      setPendingIds((prev) => reconcilePendingSessionIds(prev, data.sessions));
      setPendingById((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        let changed = false;
        for (const s of data.sessions) {
          if (next.has(s.id)) {
            next.delete(s.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      // pending 仍在的 id 不得因 stale server 列表被清掉。
      const existingIds = new Set(data.sessions.map((s) => s.id));
      const pendingSnapshot = pendingIdsRef.current;
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(
          [...prev].filter((id) => existingIds.has(id) || pendingSnapshot.has(id)),
        );
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setSessionRefreshDone(false);
        }, 2000);
      }
    } catch (e) {
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      setError(String(e));
    } finally {
      if (
        mountedRef.current
        && shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)
        && showLoading
      ) {
        setLoading(false);
      }
    }
  }, []);
  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // 真实 id 乐观 upsert（多条）：立即进入 pending map，不等全量列表。
  // 父层以 id map/list 传入；单槽覆盖会丢尚未回流的其它真实 session。
  useEffect(() => {
    if (!optimisticSessions || optimisticSessions.length === 0) return;
    const batch = optimisticSessions.filter((s) => s?.id);
    if (batch.length === 0) return;
    setDeletedIds((prev) => {
      let next: Set<string> | null = null;
      for (const s of batch) {
        if (!prev.has(s.id)) continue;
        if (!next) next = new Set(prev);
        next.delete(s.id);
      }
      return next ?? prev;
    });
    setPendingIds((prev) => {
      let next: Set<string> | null = null;
      for (const s of batch) {
        if (prev.has(s.id)) continue;
        if (!next) next = new Set(prev);
        next.add(s.id);
      }
      return next ?? prev;
    });
    setPendingById((prev) => {
      let next: Map<string, SessionInfo> | null = null;
      for (const s of batch) {
        const existing = prev.get(s.id);
        if (existing === s) continue;
        if (!next) next = new Map(prev);
        next.set(s.id, s);
      }
      return next ?? prev;
    });
  }, [optimisticSessions]);

  const allSessions = useMemo(
    () => mergeOptimisticSessions({
      serverSessions,
      pendingSessions: [...pendingById.values()],
      pendingIds,
      deletedIds,
    }),
    [serverSessions, pendingById, pendingIds, deletedIds],
  );

  const {
    worktreeSnapshots,
    worktreeSnapshotsRef,
    worktreeMetadata,
    setWtRefreshKey,
    commitWorktreeSnapshots,
  } = useWorktreePreload({
    allSessions,
    selectedCwd,
    selectedProjectRoot,
    setIdentity,
    mountedRef,
  });

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    // Live running status via SSE — no polling. The server pushes the current
    // set of running session ids whenever any session starts/stops working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { type?: string; runningSessionIds?: string[] };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        }
      } catch {
        // ignore malformed frames
      }
    };

    // On error EventSource auto-reconnects; keep the last known state meanwhile.
    return () => source.close();
  }, []);

  // subagent 活跃运行轮询：异步子会话运行中 → 子会话 + 其主会话显示 running。
  // 数据源 /api/subagent-runs（read-only），30s 轮询 + 会话列表刷新时同步拉取。
  const refreshSubagentRunning = useCallback(async () => {
    try {
      const res = await fetch("/api/subagent-runs?limit=50");
      if (!res.ok) return;
      const data = await res.json() as { runs?: Array<{
        state?: string;
        steps?: Array<{ sessionId?: string }>;
      }> };
      const active = (data.runs ?? []).filter((r) =>
        r.state === "running" || r.state === "queued" || r.state === "paused",
      );
      const childIds = new Set<string>();
      for (const run of active) {
        for (const step of run.steps ?? []) {
          if (step.sessionId) childIds.add(step.sessionId);
        }
      }
      // 主会话等待中：子会话的 parent 也显示 running。
      // 经 ref 读取最新会话列表（不把 setState updater 当数据源用）。
      const parentIds = new Set<string>();
      if (childIds.size > 0) {
        for (const s of serverSessionsRef.current) {
          if (s.subagent?.parentSessionId && childIds.has(s.id)) {
            parentIds.add(s.subagent.parentSessionId);
          }
        }
      }
      setSubagentRunningIds(new Set([...childIds, ...parentIds]));
    } catch {
      // 轮询失败静默：保持上次状态。
    }
  }, []);

  useEffect(() => {
    void refreshSubagentRunning();
    subagentPollRef.current = setInterval(() => void refreshSubagentRunning(), 30_000);
    return () => {
      if (subagentPollRef.current) clearInterval(subagentPollRef.current);
    };
  }, [refreshSubagentRunning]);

  // 会话列表刷新后同步拉一次 subagent 状态（子会话刚被发现时）。
  useEffect(() => {
    if (sessionRefreshDone) void refreshSubagentRunning();
  }, [sessionRefreshDone, refreshSubagentRunning]);
  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds];

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  /** 从最新本地数据乐观解析项目根；服务端响应仍是权威来源。 */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (selectedCwd === cwd && selectedProjectRoot) return selectedProjectRoot;
    for (const [root, snapshot] of Object.entries(worktreeSnapshotsRef.current)) {
      if (snapshot.worktrees.some((worktree) => worktree.path === cwd)) return root;
    }
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [selectedCwd, selectedProjectRoot, allSessions]);
  const selectCwd = useCallback((cwd: string | null, explicitRoot?: string | null) => {
    const root = cwd === null ? null : explicitRoot ?? projectRootFor(cwd) ?? cwd;
    setIdentity({ cwd, projectRoot: root, status: cwd ? "ready" : "idle", error: null });
  }, [projectRootFor, setIdentity]);
  const selectedProject = selectedProjectRoot ?? projectRootFor(selectedCwd);

  // 切换项目时收起未完成的 worktree 操作行，避免状态串到别的项目。
  useEffect(() => {
    setWtNewForProject(null);
    setWtNewBranch("");
    setWtError(null);
    setWtErrorRoot(null);
    setWtConfirmRemove(null);
  }, [selectedCwd]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    // URL 恢复必须优先于 cwd 自动选择；requestedCwd 已先建立身份时，
    // selectedCwd 不再为空，但仍不能跳过目标会话恢复。
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        selectCwd(target.cwd, target.projectRoot ?? target.cwd);
        onSelectSession(target, true);
        return;
      }
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
    if (selectedCwd === null) {
      // 已关闭项目不参与自动选择：全部关闭时保持空工作区，而不是复活已关闭项目。
      const projects = getRecentProjects(allSessions);
      const next = projects.find((root) => !closedRoots.has(root));
      if (next) selectCwd(next);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, selectCwd, closedRoots]);

  const closeCustomPathPanel = useCallback(() => {
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCustomPathError(null);
  }, []);

  /** 重新打开已关闭项目：仅移除关闭标记，不触碰任何项目数据。 */
  const restoreClosedProject = useCallback((root: string) => {
    updatePrefs((prev) => prev.closedProjectRoots.includes(root)
      ? { ...prev, closedProjectRoots: prev.closedProjectRoots.filter((item) => item !== root) }
      : prev);
  }, [updatePrefs]);

  /** 手动浏览目录（对齐上游 directory-picker：Go/Enter/目录点击/.. 触发）。
   *  空路径 → 服务器默认 homedir（上游打开弹窗即浏览 home）。 */
  const browseDirectory = useCallback(async (rawPath: string) => {
    const cancelled = { current: false };
    setBrowseLoading(true);
    setBrowseMissing(false);
    setCustomPathError(null);
    try {
      const res = await fetch(`/api/cwd/browse?path=${encodeURIComponent(rawPath)}`);
      if (cancelled.current) return;
      if (!res.ok) {
        setBrowseEntries([]);
        setBrowseGit(null);
        setBrowseMissing(true);
        setBrowsePath(null);
        setBrowseParentPath(null);
        return;
      }
      const data = (await res.json()) as {
        path?: string;
        parentPath?: string | null;
        entries?: Array<{ name: string; path: string }>;
        git?: { isRepo: boolean; branch: string | null };
      };
      if (cancelled.current) return;
      setCustomPathValue(data.path ?? rawPath);
      setBrowsePath(data.path ?? rawPath);
      setBrowseParentPath(data.parentPath ?? null);
      setBrowseEntries(data.entries ?? []);
      setBrowseGit(data.git ?? null);
      setBrowseMissing(false);
    } catch {
      if (!cancelled.current) {
        setBrowseEntries([]);
        setBrowseGit(null);
        setBrowseMissing(true);
        setBrowsePath(null);
        setBrowseParentPath(null);
      }
    } finally {
      if (!cancelled.current) setBrowseLoading(false);
    }
    // 竞态防护：本次浏览完成后若已有更新的请求，不覆盖其状态。
    return () => {
      cancelled.current = true;
    };
  }, []);

  /** 上级目录（.. 导航）：直接取服务器返回的 parentPath（0.8.6 对齐） */
  const browseParent = browseParentPath;
  const commitCustomPath = useCallback(async (candidate?: string) => {
    // 上游语义：Select 提交"已浏览"的路径；候选为空时用已浏览路径
    const path = (candidate ?? browsePath ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const resolvedCwd = data.cwd ?? path;
      // 重复添加：已打开项目仅切换选中；已关闭项目移除关闭标记后恢复。
      const root = projectRootFor(resolvedCwd) ?? resolvedCwd;
      restoreClosedProject(root);
      selectCwd(resolvedCwd, root);
      closeCustomPathPanel();
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [browsePath, customPathValue, customPathValidating, projectRootFor, restoreClosedProject, selectCwd, closeCustomPathPanel]);

  /** 添加项目按钮：总是打开弹窗，不直接拉起原生目录选择器。 */
  const openAddProjectDialog = useCallback(() => {
    setCustomPathError(null);
    setCustomPathValue("");
    setBrowsePath(null);
    setBrowseParentPath(null);
    setBrowseEntries([]);
    setBrowseGit(null);
    setBrowseMissing(false);
    setCustomPathOpen(true);
    // 上游 directory-picker：打开即浏览默认（home）目录
    void browseDirectory("");
  }, [browseDirectory]);

  /** 弹窗内「选择目录」：仅调用原生选择器填充输入框，不直接提交。 */
  const handlePickDirectory = useCallback(async () => {
    const desktop = window.piDesktop;
    if (!desktop) return;
    try {
      setCustomPathError(null);
      const path = await desktop.selectDirectory();
      if (path !== null) {
        setCustomPathValue(path);
        void browseDirectory(path);
      }
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, [browseDirectory]);

  const handleDefaultCwd = useCallback(async () => {
    if (customPathValidating) return;
    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error || !data.cwd) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const root = projectRootFor(data.cwd) ?? data.cwd;
      restoreClosedProject(root);
      selectCwd(data.cwd, root);
      closeCustomPathPanel();
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValidating, projectRootFor, restoreClosedProject, selectCwd, closeCustomPathPanel]);

  const handleCreateWorktree = useCallback(async () => {
    // 目标项目以「打开输入行的项目」为准，而非当前选中项目：
    // 未选中项目的 worktree 管理入口同样可用。
    const projectRoot = wtNewForProject;
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !projectRoot) return;
    setWtBusy(true);
    setWtError(null);
    setWtErrorRoot(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtErrorRoot(projectRoot);
        return;
      }
      setWtNewForProject(null);
      setWtNewBranch("");
      // Optimistically register the new worktree so projectRootFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, {
        status: "ready",
        worktrees: [...(prev[projectRoot]?.worktrees ?? []), { path: data.path!, branch, isMain: false }],
      }));
      selectCwd(data.path, projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      setWtErrorRoot(projectRoot);
    } finally {
      setWtBusy(false);
    }
  }, [wtNewForProject, wtNewBranch, wtBusy, commitWorktreeSnapshots, selectCwd]);

  const handleRemoveWorktree = useCallback(async (projectRoot: string, path: string, force: boolean) => {
    // 与创建同理：以分组所属项目根为请求目标，不要求该项目处于选中态。
    if (wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    setWtErrorRoot(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtErrorRoot(projectRoot);
        return;
      }
      setWtConfirmRemove(null);
      if (selectedCwd === path) selectCwd(projectRoot, projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      setWtErrorRoot(projectRoot);
    } finally {
      setWtBusy(false);
    }
  }, [wtBusy, selectedCwd, selectCwd]);

  // 点击外部关闭显示模式菜单
  useEffect(() => {
    if (!displayMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (displayMenuRef.current && !displayMenuRef.current.contains(e.target as Node)) {
        setDisplayMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [displayMenuOpen]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) selectCwd(s.cwd, s.projectRoot ?? s.cwd);
    onSelectSession(s);
  }, [onSelectSession, selectCwd]);

  const handleNewSession = useCallback((targetCwd = selectedCwd) => {
    if (!targetCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    selectCwd(targetCwd, projectRootFor(targetCwd));
    onNewSession?.(targetCwd);
  }, [selectedCwd, onNewSession, selectCwd, projectRootFor]);

  // 搜索行开关：打开自动聚焦；关闭同时清空瞬时查询与全文结果。
  const clearSearchState = useCallback(() => {
    setSessionQuery("");
    setFulltextHits([]);
    setFulltextSessionIds([]);
    setFulltextSource(null);
    setFulltextError(null);
    setFulltextLoading(false);
    fulltextRequestSeqRef.current += 1;
  }, []);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false);
      clearSearchState();
    } else {
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchOpen, clearSearchState]);

  // 全文模式：debounce 调用只读 API；忽略过期响应。
  useEffect(() => {
    if (!searchOpen || searchMode !== "fulltext") {
      setFulltextLoading(false);
      return;
    }
    const q = sessionQuery.trim();
    if (!q) {
      setFulltextHits([]);
      setFulltextSessionIds([]);
      setFulltextSource(null);
      setFulltextError(null);
      setFulltextLoading(false);
      return;
    }
    const seq = ++fulltextRequestSeqRef.current;
    setFulltextLoading(true);
    setFulltextError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=40`);
          const data = await res.json().catch(() => ({})) as {
            error?: string;
            hits?: Array<{ sessionId: string; snippet: string; timestamp: string; role?: string }>;
            sessionIds?: string[];
            source?: "fts" | "jsonl" | "none";
          };
          if (seq !== fulltextRequestSeqRef.current) return;
          if (!res.ok || data.error) {
            setFulltextError(data.error ?? `HTTP ${res.status}`);
            setFulltextHits([]);
            setFulltextSessionIds([]);
            setFulltextSource(null);
            return;
          }
          setFulltextHits(data.hits ?? []);
          setFulltextSessionIds(data.sessionIds ?? []);
          setFulltextSource(data.source ?? null);
        } catch (e) {
          if (seq !== fulltextRequestSeqRef.current) return;
          setFulltextError(e instanceof Error ? e.message : String(e));
          setFulltextHits([]);
          setFulltextSessionIds([]);
          setFulltextSource(null);
        } finally {
          if (seq === fulltextRequestSeqRef.current) setFulltextLoading(false);
        }
      })();
    }, 280);
    return () => clearTimeout(timer);
  }, [searchOpen, searchMode, sessionQuery]);

  // 当前有效项目根（由 selectedCwd 乐观解析；服务端 worktree 数据仍是权威）
  // 全项目树：分组/排序/空态补齐全部在纯模型内完成。
  const knownWorktreesByProject = useMemo(
    () => Object.fromEntries(Object.entries(worktreeSnapshots).map(([root, snapshot]) => [root, snapshot.worktrees])),
    [worktreeSnapshots],
  );
  const sidebarTree = useMemo(
    () => buildSidebarTree(allSessions, { selectedCwd, selectedProjectRoot: selectedProject, knownWorktreesByProject }),
    [allSessions, selectedCwd, selectedProject, knownWorktreesByProject],
  );
  // 已关闭项目先从树中隐藏（纯 UI 过滤，不删数据），再进入搜索管线。
  const openTree = useMemo(
    () => filterClosedProjects(sidebarTree, closedRoots),
    [sidebarTree, closedRoots],
  );
  const normalizedSessionQuery = normalizeSessionQuery(sessionQuery);
  const fulltextModeActive = searchMode === "fulltext" && normalizedSessionQuery.length > 0;
  const fulltextMatchIds = useMemo(
    () => (fulltextModeActive ? new Set(fulltextSessionIds) : null),
    [fulltextModeActive, fulltextSessionIds],
  );
  const searchActive = fulltextModeActive
    ? fulltextSessionIds.length > 0 || fulltextLoading || Boolean(fulltextError)
    : normalizedSessionQuery.length > 0;
  // 项目 alias 参与元数据搜索；全文模式按命中 id 保留祖先链。
  const visibleTree = useMemo(
    () => filterSidebarTree(
      openTree,
      fulltextModeActive ? "" : normalizedSessionQuery,
      prefs.projectAliases,
      fulltextMatchIds,
    ),
    [openTree, normalizedSessionQuery, prefs.projectAliases, fulltextMatchIds, fulltextModeActive],
  );

  // 项目信任：按未经搜索过滤的项目根 + 非主 worktree 路径查询，
  // 避免输入搜索词时反复重取；决策后立即重取以刷新徽章。
  // 主项目与 worktree 各自对应自身 cwd，不混用。
  // 额外查询当前实际 selectedCwd：会话 cwd 可能是项目根子目录，
  // 需与 AgentSession / 自动提示使用同一信任目标（useProjectTrust 内部已去重）。
  const trustRoots = useMemo(() => {
    const roots: string[] = [];
    for (const project of openTree) {
      roots.push(project.root);
      for (const group of project.worktrees) {
        roots.push(group.path);
      }
    }
    if (selectedCwd) roots.push(selectedCwd);
    return roots;
  }, [openTree, selectedCwd]);
  const { entries: trustEntries, refresh: refreshTrust } = useProjectTrust(trustRoots);
  const [trustDialogRoot, setTrustDialogRoot] = useState<string | null>(null);
  // 「本次连续选择该 cwd 期间已手动关闭未决提示」的记录：只对当前 cwd 生效，
  // 切换 cwd 即清零（不持久化、不跨刷新）。避免 rerender/refresh 后反复自动弹窗。
  const trustAutoDismissedCwdRef = useRef<string | null>(null);
  const prevSelectedCwdRef = useRef<string | null>(selectedCwd);

  // 切换活动项目：关闭旧项目的信任对话框，并允许新 cwd（或之后切回）重新自动提示。
  // 必须声明在自动打开 effect 之前，保证同一批提交里先关旧、再开新。
  useEffect(() => {
    if (prevSelectedCwdRef.current === selectedCwd) return;
    prevSelectedCwdRef.current = selectedCwd;
    trustAutoDismissedCwdRef.current = null;
    setTrustDialogRoot(null);
  }, [selectedCwd]);

  // 自动提示仅针对当前活动 cwd：entry 已加载且仍未决时打开决策对话框。
  // 不扫描历史项目；函数式更新保证已打开（如徽章手动打开其它项目）的对话框不被抢占；
  // 异步响应只可能把对话框设为当前 selectedCwd，旧 cwd 不会复活。
  useEffect(() => {
    if (!selectedCwd) return;
    if (trustAutoDismissedCwdRef.current === selectedCwd) return;
    const entry = trustEntries.get(selectedCwd);
    if (!entry || !entry.status.needsDecision) return;
    setTrustDialogRoot((current) => current ?? selectedCwd);
  }, [selectedCwd, trustEntries]);

  // entry 消失（目录被删、决策已在别处完成）时安全关闭，避免残留 root 日后复活。
  useEffect(() => {
    if (trustDialogRoot !== null && !trustEntries.get(trustDialogRoot)) {
      setTrustDialogRoot(null);
    }
  }, [trustDialogRoot, trustEntries]);

  /** 全文命中深链：按 id 打开已加载会话；列表尚未包含时忽略（refresh 后可再点）。 */
  const openSessionById = useCallback((sessionId: string) => {
    const target = allSessions.find((s) => s.id === sessionId);
    if (!target) return;
    handleSelectSessionFromList(target);
  }, [allSessions, handleSelectSessionFromList]);

  // 默认收起「有 subagent 子节点」的父会话；不写 localStorage。
  // 用户手动展开/折叠过的 id 不覆盖；选中子会话时会展开祖先（见下）。
  useEffect(() => {
    const defaults = collectSubagentParentIdsFromSidebarTree(sidebarTree);
    if (defaults.length === 0) return;
    setCollapsedSessionIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of defaults) {
        if (userTouchedSessionCollapseRef.current.has(id)) continue;
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sidebarTree]);

  // 选中或 URL 恢复会话时自动展开 project/worktree/session 三级祖先，
  // 避免「已选中但列表里不可见」；这是显式选中驱动，与搜索强制展开无关。
  useEffect(() => {
    if (!selectedSessionId) return;
    const location = locateSessionInSidebarTree(sidebarTree, selectedSessionId);
    if (!location) return;
    updatePrefs((prev) => {
      const hasProject = prev.collapsedProjectRoots.includes(location.projectRoot);
      const hasWorktree = location.worktreePath !== null && prev.collapsedWorktreePaths.includes(location.worktreePath);
      if (!hasProject && !hasWorktree) return prev;
      return {
        ...prev,
        collapsedProjectRoots: hasProject ? prev.collapsedProjectRoots.filter((root) => root !== location.projectRoot) : prev.collapsedProjectRoots,
        collapsedWorktreePaths: hasWorktree ? prev.collapsedWorktreePaths.filter((path) => path !== location.worktreePath) : prev.collapsedWorktreePaths,
      };
    });
    if (location.ancestors.length > 0) {
      for (const id of location.ancestors) {
        userTouchedSessionCollapseRef.current.add(id);
      }
      setCollapsedSessionIds((current) => {
        if (!location.ancestors.some((id) => current.has(id))) return current;
        const next = new Set(current);
        location.ancestors.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [selectedSessionId, sidebarTree, updatePrefs]);

  // 仅首次 URL 恢复或目标确实超出可视区时滚动，不打断用户正常浏览位置。
  useLayoutEffect(() => {
    if (!selectedSessionId) return;
    const list = sessionListRef.current;
    if (!list) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-session-id]"))
      .find((element) => element.dataset.sessionId === selectedSessionId);
    if (!row) return;

    const isInitialRestore = !initialSelectionScrollDoneRef.current
      && initialSessionId === selectedSessionId;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const outsideViewport = rowRect.top < listRect.top || rowRect.bottom > listRect.bottom;
    if (isInitialRestore || outsideViewport) row.scrollIntoView({ block: "nearest" });
    if (isInitialRestore) initialSelectionScrollDoneRef.current = true;
  }, [selectedSessionId, initialSessionId, visibleTree, collapsedProjectRoots, collapsedWorktreePaths, collapsedSessionIds]);

  const toggleSessionCollapse = useCallback((sessionId: string) => {
    userTouchedSessionCollapseRef.current.add(sessionId);
    setCollapsedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // 项目折叠：显式用户动作，写入偏好。
  const toggleProjectCollapse = useCallback((root: string) => {
    updatePrefs((prev) => ({
      ...prev,
      collapsedProjectRoots: prev.collapsedProjectRoots.includes(root)
        ? prev.collapsedProjectRoots.filter((item) => item !== root)
        : [...prev.collapsedProjectRoots, root],
    }));
  }, [updatePrefs]);

  const toggleWorktreeCollapse = useCallback((path: string) => {
    updatePrefs((prev) => ({
      ...prev,
      collapsedWorktreePaths: prev.collapsedWorktreePaths.includes(path)
        ? prev.collapsedWorktreePaths.filter((item) => item !== path)
        : [...prev.collapsedWorktreePaths, path],
    }));
  }, [updatePrefs]);

  /**
   * 关闭项目：仅把 root 写入 UI 偏好并从侧栏隐藏——绝不删除目录、会话、
   * AgentSession、worktree 或 Git 数据；重新添加同路径项目即可恢复。
   */
  const handleCloseProject = useCallback((root: string) => {
    setOpenProjectMenuRoot(null);
    const nextClosedRoots = new Set(prefs.closedProjectRoots);
    nextClosedRoots.add(root);
    updatePrefs((prev) => (prev.closedProjectRoots.includes(root)
      ? prev
      : { ...prev, closedProjectRoots: [...prev.closedProjectRoots, root] }));
    // 关闭当前项目：切换到下一个未关闭项目；无剩余则置空 cwd 并回到
    // 新会话/空工作区，避免继续显示已关闭项目的当前会话。
    if (selectedProject === root) {
      const next = pickProjectRootAfterClose(sidebarTree, root, nextClosedRoots);
      if (next) {
        selectCwd(next, next);
      } else {
        selectCwd(null);
        onNewSession?.();
      }
    }
  }, [prefs.closedProjectRoots, selectedProject, sidebarTree, updatePrefs, selectCwd, onNewSession]);

  /** 打开编辑项目弹窗：名称初值为 alias 或路径显示名。 */
  const handleOpenEditProject = useCallback((root: string) => {
    setOpenProjectMenuRoot(null);
    setEditProjectValue(prefs.projectAliases[root] ?? displayCwd(root, homeDir));
    setEditProjectRoot(root);
  }, [prefs.projectAliases, homeDir]);

  /** 保存项目 alias：与路径显示名相同则清除 alias，回到默认显示。 */
  const handleSaveProjectAlias = useCallback(() => {
    if (!editProjectRoot) return;
    const name = editProjectValue.trim();
    if (!name) return;
    const root = editProjectRoot;
    setEditProjectRoot(null);
    updatePrefs((prev) => {
      const nextAliases = { ...prev.projectAliases };
      if (name === displayCwd(root, homeDir)) delete nextAliases[root];
      else nextAliases[root] = name;
      return { ...prev, projectAliases: nextAliases };
    });
  }, [editProjectRoot, editProjectValue, homeDir, updatePrefs]);

  const setDisplayMode = useCallback((mode: SidebarDisplayMode) => {
    updatePrefs((prev) => (prev.displayMode === mode ? prev : { ...prev, displayMode: mode }));
  }, [updatePrefs]);

  const collapseAll = useCallback(() => {
    const ids = collectAllCollapseIds(openTree);
    updatePrefs((prev) => ({
      ...prev,
      collapsedProjectRoots: ids.projectRoots,
      collapsedWorktreePaths: ids.worktreePaths,
    }));
  }, [openTree, updatePrefs]);

  const expandAll = useCallback(() => {
    updatePrefs((prev) => (prev.collapsedProjectRoots.length === 0 && prev.collapsedWorktreePaths.length === 0
      ? prev
      : { ...prev, collapsedProjectRoots: [], collapsedWorktreePaths: [] }));
  }, [updatePrefs]);

  // worktree 管理能力：所有已知项目均可显示/操作（快照缓存优先、后台预加载），
  // 不再要求项目处于选中态；可否创建/删除取决于该项目已加载的 git 顶层信息。
  const worktreeActionsFor = useCallback((projectRoot: string): WorktreeActions | null => {
    const snapshot = worktreeSnapshots[projectRoot];
    const metadata = worktreeMetadata[projectRoot];
    const canManage = Boolean(metadata?.isGit && metadata.isTopLevel);
    const createHint = canManage
      ? t("sidebar_createWorktree")
      : snapshot?.status === "loading" || !snapshot
        ? t("sidebar_checkingWorktree")
        : metadata?.isGit
          ? t("sidebar_worktreeOpenRoot")
          : t("sidebar_worktreeGitOnly");
    return { canManage, createHint, busy: wtBusy };
  }, [worktreeSnapshots, worktreeMetadata, wtBusy, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header：品牌 + 全图标工具栏（OpenChamber 规格 24×24 / 图标 18 / 6px 圆角） */}
      <div
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <PiWebTitle />
          <div className="sidebar-toolbar" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <SidebarIconButton
              label={t("sidebar_addProject")}
              onClick={openAddProjectDialog}
              active={customPathOpen}
            >
              <FolderPlusIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label={selectedCwd ? t("sidebar_newSessionIn", { project: displayCwd(selectedCwd, homeDir) }) : t("sidebar_selectProject")}
              disabled={!selectedCwd}
              onClick={() => handleNewSession()}
            >
              <ChatPlusIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label={t("sidebar_searchSessions")}
              active={searchOpen}
              expanded={searchOpen}
              onClick={toggleSearch}
            >
              <SearchIcon size={18} />
            </SidebarIconButton>
            <div ref={displayMenuRef} style={{ position: "relative" }}>
              <SidebarIconButton
                label={t("sidebar_displayOptions")}
                active={displayMenuOpen}
                expanded={displayMenuOpen}
                onClick={() => setDisplayMenuOpen((open) => !open)}
              >
                <SlidersIcon size={18} />
              </SidebarIconButton>
              <AnimatedDropdown
                open={displayMenuOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                  minWidth: 168,
                }}
              >
                <div onKeyDown={(e) => { if (e.key === "Escape") setDisplayMenuOpen(false); }}>
                  <DisplayMenuItem
                    label={t("sidebar_standard")}
                    checked={displayMode === "standard"}
                    onClick={() => { setDisplayMode("standard"); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_compact")}
                    checked={displayMode === "compact"}
                    onClick={() => { setDisplayMode("compact"); setDisplayMenuOpen(false); }}
                  />
                  <div style={{ borderTop: "1px solid var(--border)", margin: "2px 0" }} />
                  <DisplayMenuItem
                    label={t("sidebar_collapseAll")}
                    onClick={() => { collapseAll(); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_expandAll")}
                    onClick={() => { expandAll(); setDisplayMenuOpen(false); }}
                  />
                </div>
              </AnimatedDropdown>
            </div>
            <SidebarIconButton
              label={t("sidebar_refresh")}
              done={sessionRefreshDone}
              onClick={() => loadSessions(false)}
            >
              {sessionRefreshDone ? <CheckIcon size={16} /> : <RefreshIcon size={16} />}
            </SidebarIconButton>
          </div>
        </div>

        {/* 搜索行：第二行展示、自动聚焦、Esc 先清空再关闭；范围覆盖全部项目 */}
        {searchOpen && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              <button
                type="button"
                onClick={() => setSearchMode("meta")}
                aria-pressed={searchMode === "meta"}
                style={{
                  flex: 1, height: 24, borderRadius: 6, border: "1px solid var(--border)",
                  background: searchMode === "meta" ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: "var(--text)", fontSize: 11, cursor: "pointer",
                }}
              >
                {t("sidebar_searchModeMeta")}
              </button>
              <button
                type="button"
                onClick={() => setSearchMode("fulltext")}
                aria-pressed={searchMode === "fulltext"}
                style={{
                  flex: 1, height: 24, borderRadius: 6, border: "1px solid var(--border)",
                  background: searchMode === "fulltext" ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: "var(--text)", fontSize: 11, cursor: "pointer",
                }}
              >
                {t("sidebar_searchModeFulltext")}
              </button>
            </div>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none", display: "flex" }}>
                <SearchIcon size={13} />
              </span>
              <input
                ref={searchInputRef}
                type="search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    if (sessionQuery) clearSearchState();
                    else {
                      setSearchOpen(false);
                      clearSearchState();
                    }
                  }
                }}
                placeholder={searchMode === "fulltext" ? t("sidebar_searchPlaceholderFulltext") : t("sidebar_searchPlaceholder")}
                aria-label={t("sidebar_searchSessions")}
                style={{
                  width: "100%", height: 30, boxSizing: "border-box", padding: "0 28px 0 29px",
                  border: "1px solid var(--border)", borderRadius: 7,
                  background: "var(--bg-panel)", color: "var(--text)",
                  fontSize: 11.5, outline: "none",
                }}
              />
              {sessionQuery && (
                <button
                  type="button"
                  onClick={() => clearSearchState()}
                  aria-label={t("sidebar_clearSearch")}
                  title={t("sidebar_clearSearch")}
                  style={{
                    position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                    width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 0, border: "none", borderRadius: 5, background: "none",
                    color: "var(--text-dim)", cursor: "pointer",
                  }}
                >
                  <XIcon size={13} />
                </button>
              )}
            </div>
            {searchMode === "fulltext" && sessionQuery.trim() && (
              <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-dim)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {fulltextLoading && <span>{t("sidebar_searchFulltextLoading")}</span>}
                {!fulltextLoading && fulltextSource === "fts" && (
                  <span>{t("sidebar_searchFulltextSourceFts")} · {t("sidebar_searchFulltextHits", { count: fulltextHits.length })}</span>
                )}
                {!fulltextLoading && fulltextSource === "jsonl" && (
                  <span>{t("sidebar_searchFulltextSourceJsonl")} · {t("sidebar_searchFulltextHits", { count: fulltextHits.length })}</span>
                )}
                {fulltextError && <span style={{ color: "#f87171" }}>{fulltextError}</span>}
              </div>
            )}
          </div>
        )}

      </div>

      {/* 全文命中片段：点击深链打开对应会话 */}
      {searchOpen && searchMode === "fulltext" && fulltextHits.length > 0 && (
        <div style={{
          flex: "0 0 auto", maxHeight: 160, overflowY: "auto",
          borderBottom: "1px solid var(--border)", padding: "4px 0",
        }}>
          {fulltextHits.slice(0, 12).map((hit, index) => (
            <button
              key={`${hit.sessionId}-${hit.timestamp}-${index}`}
              type="button"
              onClick={() => openSessionById(hit.sessionId)}
              title={t("sidebar_searchFulltextSnippet")}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 12px", border: "none", background: "transparent",
                color: "var(--text)", cursor: "pointer", fontSize: 11, lineHeight: 1.4,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 2 }}>
                {(hit.role ?? "message")} · {hit.sessionId.slice(0, 8)}
              </div>
              <div style={{
                overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical", whiteSpace: "normal",
              }}>
                {hit.snippet}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 项目树：Project → (非主 Worktree) → Session → child */}
      <div ref={sessionListRef} style={{ flex: "1 1 auto", overflowY: "auto", padding: "2px 0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar_loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && visibleTree.length === 0 && (
          (searchMode === "meta" ? normalizedSessionQuery.length > 0 : fulltextModeActive && !fulltextLoading) ? (
            <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
              {t("sidebar_searchEmpty", { query: sessionQuery.trim() })}
            </div>
          ) : (
            <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>
              {t("sidebar_noProjects")}
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {t("sidebar_addProject")}
              </div>
            </div>
          )
        )}
        {visibleTree.map((project) => (
          <ProjectSection
            key={project.root}
            project={project}
            homeDir={homeDir}
            displayMode={displayMode}
            projectAliases={prefs.projectAliases}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            subagentRunningIds={subagentRunningIds}
            unreadSessionIds={unreadSessionIds}
            collapsedProjectRoots={collapsedProjectRoots}
            collapsedWorktreePaths={collapsedWorktreePaths}
            collapsedSessionIds={collapsedSessionIds}
            searchActive={searchActive}
            onToggleProject={toggleProjectCollapse}
            onToggleWorktree={toggleWorktreeCollapse}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSessionFromList}
            trustEntries={trustEntries}
            onOpenTrust={(cwd) => setTrustDialogRoot(cwd)}
            menuOpen={openProjectMenuRoot === project.root}
            onMenuOpenChange={(open) => setOpenProjectMenuRoot(open ? project.root : null)}
            onEditProject={() => handleOpenEditProject(project.root)}
            onCloseProject={() => handleCloseProject(project.root)}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              setDeletedIds((prev) => {
                const next = new Set(prev);
                next.add(id);
                return next;
              });
              setPendingIds((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              setPendingById((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Map(prev);
                next.delete(id);
                return next;
              });
              onSessionDeleted?.(id);
              loadSessions();
            }}
            onToggleCollapse={toggleSessionCollapse}
            groupVisibleCounts={groupVisibleCounts}
            onShowMore={(groupKey) => setGroupVisibleCounts((counts) => bumpGroupVisibleCount(counts, groupKey))}
            onShowFewer={(groupKey) => setGroupVisibleCounts((counts) => resetGroupVisibleCount(counts, groupKey))}
            worktreeActions={worktreeActionsFor(project.root)}
            wtNewOpen={wtNewForProject === project.root}
            wtNewBranch={wtNewBranch}
            wtError={wtErrorRoot === project.root ? wtError : null}
            wtConfirmRemove={wtConfirmRemove}
            wtNewInputRef={wtNewInputRef}
            onStartCreateWorktree={() => {
              setWtNewForProject(project.root);
              setWtError(null);
              setWtErrorRoot(null);
              setTimeout(() => wtNewInputRef.current?.focus(), 0);
            }}
            onWtNewBranchChange={(value) => {
              setWtNewBranch(value);
              setWtError(null);
              setWtErrorRoot(null);
            }}
            onSubmitCreateWorktree={() => void handleCreateWorktree()}
            onCancelCreateWorktree={() => {
              setWtNewForProject(null);
              setWtNewBranch("");
              setWtError(null);
              setWtErrorRoot(null);
            }}
            onRequestRemoveWorktree={(path) => void handleRemoveWorktree(project.root, path, false)}
            onConfirmRemoveWorktree={(path) => void handleRemoveWorktree(project.root, path, true)}
            onCancelRemoveWorktree={() => setWtConfirmRemove(null)}
           />
         ))}
       </div>

      {/* 项目信任决策：写入 ~/.pi/agent/trust.json，只影响此后新建的 AgentSession。 */}
      <ProjectTrustDialog
        open={trustDialogRoot !== null}
        entry={trustDialogRoot !== null ? trustEntries.get(trustDialogRoot) ?? null : null}
        onClose={() => {
          // 手动关闭未决提示后，本次连续选择该 cwd 期间不再自动弹；切换 cwd 即失效。
          if (trustDialogRoot !== null) trustAutoDismissedCwdRef.current = trustDialogRoot;
          setTrustDialogRoot(null);
        }}
        onDecided={refreshTrust}
      />

      {/* 添加项目弹窗：总是经 ViewportDialog，不直接拉起原生选择器；
          「选择目录」仅填充输入，提交仍走 /api/cwd/validate。 */}
      <ViewportDialog
        open={customPathOpen}
        onClose={closeCustomPathPanel}
        title={t("sidebar_addProjectDialog")}
        width={440}
        closeLabel={t("dialog_close")}
        initialFocusRef={customPathInputRef}
        description={t("sidebar_addProjectDescription")}
        actions={
          <>
            <DialogButton onClick={closeCustomPathPanel}>{t("sidebar_cancel")}</DialogButton>
            {/* 上游 directory-picker：Select 只允许已浏览的路径（输入与浏览
                不一致时 disabled，title 提示先打开/浏览） */}
            <span
              title={
                !browsePath || customPathValue.trim() !== browsePath
                  ? t("sidebar_browseOpenBeforeSelect")
                  : undefined
              }
            >
              <DialogButton
                primary
                disabled={customPathValidating || !browsePath || customPathValue.trim() !== browsePath}
                onClick={() => void commitCustomPath()}
              >
                {customPathValidating ? t("sidebar_validating") : t("sidebar_add")}
              </DialogButton>
            </span>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // 上游 directory-picker：Enter = 浏览输入路径；只有 Select 按钮提交
            const raw = customPathValue.trim();
            if (!raw || raw === browsePath) return;
            void browseDirectory(raw);
          }}
        >
          <label
            htmlFor="add-project-path"
            style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
          >
            {t("sidebar_projectPath")}
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="add-project-path"
              ref={customPathInputRef}
              value={customPathValue}
              onChange={(e) => {
                setCustomPathValue(e.target.value);
                setCustomPathError(null);
              }}
              onKeyDown={(e) => {
                // Enter 走 form onSubmit（浏览）；仅 Esc 快速关闭
                if (e.key === "Escape" && !customPathValidating) {
                  e.preventDefault();
                  closeCustomPathPanel();
                }
              }}
              placeholder="/path/to/project"
              aria-label={t("sidebar_projectPath")}
              autoComplete="off"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                height: 32,
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                outline: "none",
                background: "var(--bg-panel)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            <DialogButton
              disabled={browseLoading || !customPathValue.trim()}
              onClick={() => void browseDirectory(customPathValue.trim())}
            >
              {browseLoading ? t("sidebar_browseLoading") : t("sidebar_browseGo")}
            </DialogButton>
            {desktopPickerAvailable && (
              <DialogButton onClick={() => void handlePickDirectory()}>
                {t("sidebar_selectDirectory")}
              </DialogButton>
            )}
          </div>
          {/* 目录列表（上游 directory-picker：浏览结果区；git 徽标保留） */}
          {browsePath && (
            <div style={{ marginTop: 10 }}>
              {browseLoading && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseLoading")}</div>
              )}
              {!browseLoading && browseMissing && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseMissing")}</div>
              )}
              {!browseLoading && !browseMissing && browseGit && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    marginBottom: 6,
                    color: browseGit.isRepo ? "var(--text-muted)" : "var(--text-dim)",
                  }}
                >
                  {browseGit.isRepo ? (
                    <>
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("sidebar_browseGitRepo")}</span>
                      {browseGit.branch && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{browseGit.branch}</span>
                      )}
                    </>
                  ) : (
                    <span>{t("sidebar_browseNotGit")}</span>
                  )}
                </div>
              )}
              {!browseLoading && !browseMissing && (
                <div
                  style={{
                    maxHeight: 150,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    background: "var(--bg-panel)",
                    padding: 4,
                  }}
                >
                  {browseParent && (
                    <button
                      type="button"
                      disabled={browseLoading}
                      onClick={() => {
                        void browseDirectory(browseParent);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        width: "100%",
                        padding: "4px 8px",
                        border: "none",
                        background: "transparent",
                        color: "var(--text-muted)",
                        fontSize: 12,
                        cursor: "pointer",
                        borderRadius: 5,
                        fontFamily: "var(--font-mono)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      ..
                    </button>
                  )}
                  {browseEntries.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                      {t("sidebar_browseEmpty")}
                    </div>
                  ) : (
                    browseEntries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        disabled={browseLoading}
                        onClick={() => {
                          void browseDirectory(entry.path);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          width: "100%",
                          padding: "4px 8px",
                          border: "none",
                          background: "transparent",
                          color: "var(--text)",
                          fontSize: 12,
                          cursor: "pointer",
                          borderRadius: 5,
                          textAlign: "left",
                          fontFamily: "var(--font-mono)",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <span style={{ color: "var(--text-dim)", fontSize: 10.5 }}>▸</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {entry.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          {customPathError && (
            <div role="alert" style={{ marginTop: 8, color: "#dc2626", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
              {customPathError}
            </div>
          )}
          {/* 次级动作：创建默认目录（~/pi-cwd-YYYYMMDD），同样只在弹窗内发起 */}
          <div style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}>
            <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t("sidebar_noExistingDirectory")}</span>
            <DialogButton disabled={customPathValidating} onClick={() => void handleDefaultCwd()}>
              <HomeIcon size={13} />
              {t("sidebar_createDefaultDirectory")}
            </DialogButton>
          </div>
        </form>
      </ViewportDialog>

      {/* 编辑项目弹窗：仅修改 Pidance 显示名 alias，不动 Pi schema/目录/Git */}
      <ViewportDialog
        open={editProjectRoot !== null}
        onClose={() => setEditProjectRoot(null)}
        title={t("sidebar_editProject")}
        width={440}
        closeLabel={t("dialog_close")}
        initialFocusRef={editProjectInputRef}
        description={editProjectRoot
          ? t("sidebar_editProjectDescription", { path: editProjectRoot })
          : undefined}
        actions={
          <>
            <DialogButton onClick={() => setEditProjectRoot(null)}>{t("sidebar_cancel")}</DialogButton>
            <DialogButton
              primary
              disabled={!editProjectValue.trim()}
              onClick={handleSaveProjectAlias}
            >
              {t("sidebar_save")}
            </DialogButton>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveProjectAlias();
          }}
        >
          <label
            htmlFor="edit-project-name"
            style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
          >
            {t("sidebar_projectName")}
          </label>
          <input
            id="edit-project-name"
            ref={editProjectInputRef}
            value={editProjectValue}
            onChange={(e) => setEditProjectValue(e.target.value)}
            placeholder={t("sidebar_projectName")}
            aria-label={t("sidebar_projectName")}
            aria-invalid={!editProjectValue.trim()}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: "100%",
              height: 32,
              fontSize: 12.5,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              outline: "none",
              background: "var(--bg-panel)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
          {!editProjectValue.trim() && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: "#dc2626" }}>{t("sidebar_projectNameRequired")}</div>
          )}
        </form>
      </ViewportDialog>
      </div>
    );
  }


// ── 项目分区（项目行 + 主仓会话 + 非主 worktree 分组） ──────────────────────


function ProjectSection({
  project,
  homeDir,
  displayMode,
  projectAliases,
  selectedSessionId,
  runningSessionIds,
  subagentRunningIds,
  unreadSessionIds,
  collapsedProjectRoots,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleProject,
  onToggleWorktree,
  onNewSession,
  onSelectSession,
  menuOpen,
  onMenuOpenChange,
  onEditProject,
  onCloseProject,
  trustEntries,
  onOpenTrust,
  onRenamed,
  onSessionDeleted,
  onToggleCollapse,
  groupVisibleCounts,
  onShowMore,
  onShowFewer,
  worktreeActions,
  wtNewOpen,
  wtNewBranch,
  wtError,
  wtConfirmRemove,
  wtNewInputRef,
  onStartCreateWorktree,
  onWtNewBranchChange,
  onSubmitCreateWorktree,
  onCancelCreateWorktree,
  onRequestRemoveWorktree,
  onConfirmRemoveWorktree,
  onCancelRemoveWorktree,
}: {
  project: SidebarProjectNode;
  homeDir: string;
  displayMode: SidebarDisplayMode;
  projectAliases: ProjectAliases;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  subagentRunningIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedProjectRoots: ReadonlySet<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleProject: (root: string) => void;
  onToggleWorktree: (path: string) => void;
  onNewSession: (cwd: string) => void;
  onSelectSession: (s: SessionInfo) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onEditProject: () => void;
  onCloseProject: () => void;
  /** 项目根与各 worktree path → 信任状态；缺失则不显示徽章 */
  trustEntries: Map<string, ProjectTrustEntry>;
  onOpenTrust: (cwd: string) => void;
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onToggleCollapse: (sessionId: string) => void;
  groupVisibleCounts: Readonly<Record<string, number>>;
  onShowMore: (groupKey: string) => void;
  onShowFewer: (groupKey: string) => void;
  worktreeActions: WorktreeActions | null;
  wtNewOpen: boolean;
  wtNewBranch: string;
  wtError: string | null;
  wtConfirmRemove: string | null;
  wtNewInputRef: React.RefObject<HTMLInputElement | null>;
  onStartCreateWorktree: () => void;
  onWtNewBranchChange: (value: string) => void;
  onSubmitCreateWorktree: () => void;
  onCancelCreateWorktree: () => void;
  onRequestRemoveWorktree: (path: string) => void;
  onConfirmRemoveWorktree: (path: string) => void;
  onCancelRemoveWorktree: () => void;
}) {
  const { t } = useI18n();
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedProjectRoots, project.root, searchActive);
  const hasSessions = project.mainTree.length > 0 || project.worktrees.some((group) => group.tree.length > 0);
  // 显示名优先 alias；title 仍保留真实 root 路径（见行 title 属性）。
  const projectName = projectAliases[project.root] ?? displayCwd(project.root, homeDir);
  const trustEntry = trustEntries.get(project.root) ?? null;
  const collapseLabel = collapsed
    ? t("sidebar_expandProjectNamed", { project: projectName })
    : t("sidebar_collapseProjectNamed", { project: projectName });

  return (
    <div>
      {/* 项目行仅控制折叠；cwd 由会话行或新建会话入口切换。 */}
      <div
        className="sidebar-row"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapseLabel}
        onClick={() => onToggleProject(project.root)}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onToggleProject(project.root);
        }}
        title={project.root}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 30,
          paddingLeft: 6,
          paddingRight: 8,
          cursor: "pointer",
          background: "transparent",
          color: "var(--text-muted)",
        }}
      >
        <ChevronButton
          collapsed={collapsed}
          label={collapseLabel}
          onClick={(e) => {
            e.stopPropagation();
            onToggleProject(project.root);
          }}
        />
        <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }}>
          <FolderIcon size={13} />
        </span>
        <PathLabel
          text={projectName}
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 500,
            fontFamily: "var(--font-mono)",
          }}
        />
        {trustEntry && (
          <ProjectTrustBadge
            status={trustEntry.status}
            projectName={projectName}
            onClick={() => onOpenTrust(project.root)}
          />
        )}
        <SidebarIconButton
          label={t("sidebar_newSessionIn", { project: projectName })}
          hoverReveal
          onClick={(event) => {
            event.stopPropagation();
            onNewSession(project.root);
          }}
        >
          <ChatPlusIcon size={14} />
        </SidebarIconButton>
        {worktreeActions && (
          <SidebarIconButton
            label={worktreeActions.createHint}
            disabled={!worktreeActions.canManage || worktreeActions.busy}
            hoverReveal
            onClick={(e) => {
              e.stopPropagation();
              onStartCreateWorktree();
            }}
          >
            <BranchPlusIcon size={14} />
          </SidebarIconButton>
        )}
        {/* 三点菜单：worktree 按钮的 flex 邻居，互不遮挡 */}
        <ProjectRowMenu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          projectName={projectName}
          onEdit={onEditProject}
          onClose={onCloseProject}
        />
      </div>

      {!collapsed && (
        <div>
          {/* 主仓会话：主 worktree 隐式，直接列在项目下 */}
          <div style={{ paddingLeft: 10 }}>
            {getVisibleTopLevelNodes(
              project.mainTree,
              getGroupVisibleCount(groupVisibleCounts, `main:${project.root}`),
              searchActive,
            ).map((node) => (
              <SessionTreeItem
                key={node.session.id}
                node={node}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                subagentRunningIds={subagentRunningIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={onSelectSession}
                onRenamed={onRenamed}
                onSessionDeleted={onSessionDeleted}
                depth={0}
                collapsedSessionIds={collapsedSessionIds}
                searchActive={searchActive}
                onToggleCollapse={onToggleCollapse}
                displayMode={displayMode}
              />
            ))}
            <GroupPagination
              groupKey={`main:${project.root}`}
              total={project.mainTree.length}
              visibleCount={getGroupVisibleCount(groupVisibleCounts, `main:${project.root}`)}
              searchActive={searchActive}
              onShowMore={onShowMore}
              onShowFewer={onShowFewer}
            />
          </div>

          {/* 非主 worktree 分组 */}
          {project.worktrees.map((group) => (
            <WorktreeGroupSection
              key={group.path}
              group={group}
              homeDir={homeDir}
              displayMode={displayMode}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              subagentRunningIds={subagentRunningIds}
              unreadSessionIds={unreadSessionIds}
              collapsedWorktreePaths={collapsedWorktreePaths}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleWorktree={(path) => onToggleWorktree(path)}
              onNewSession={() => onNewSession(group.path)}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onToggleCollapse={onToggleCollapse}
              visibleCount={getGroupVisibleCount(groupVisibleCounts, `worktree:${group.path}`)}
              onShowMore={() => onShowMore(`worktree:${group.path}`)}
              onShowFewer={() => onShowFewer(`worktree:${group.path}`)}
              trustEntry={trustEntries.get(group.path) ?? null}
              onOpenTrust={() => onOpenTrust(group.path)}
              worktreeActions={worktreeActions}
              confirmRemove={wtConfirmRemove === group.path}
              onRequestRemove={() => onRequestRemoveWorktree(group.path)}
              onConfirmRemove={() => onConfirmRemoveWorktree(group.path)}
              onCancelRemove={onCancelRemoveWorktree}
            />
          ))}

          {/* 新建 worktree 输入行（仅当前项目可发起） */}
          {wtNewOpen && worktreeActions?.canManage && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px 4px 30px" }}>
              <span style={{ display: "flex", color: "var(--text-dim)", flexShrink: 0 }}><BranchIcon size={11} /></span>
              <input
                ref={wtNewInputRef}
                value={wtNewBranch}
                onChange={(e) => onWtNewBranchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSubmitCreateWorktree();
                  }
                  if (e.key === "Escape") onCancelCreateWorktree();
                }}
                placeholder={t("sidebar_branchName")}
                aria-label={t("sidebar_branchName")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 26,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "0 8px",
                  border: "1px solid var(--accent)",
                  borderRadius: 5,
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <SidebarIconButton
                label={worktreeActions.busy ? t("sidebar_creating") : t("sidebar_createWorktreeAction")}
                disabled={worktreeActions.busy || !wtNewBranch.trim()}
                onClick={onSubmitCreateWorktree}
              >
                <CheckIcon size={14} />
              </SidebarIconButton>
              <SidebarIconButton label={t("sidebar_cancel")} onClick={onCancelCreateWorktree}>
                <XIcon size={13} />
              </SidebarIconButton>
            </div>
          )}
          {wtError && worktreeActions && (
            <div style={{
              padding: "3px 10px 6px 30px",
              color: "#dc2626",
              fontSize: 11,
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}>
              {wtError}
            </div>
          )}

          {!hasSessions && project.worktrees.length === 0 && (
            <div style={{ padding: "2px 10px 6px 31px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("sidebar_noSessionsYet")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 非主 worktree 分组 ─────────────────────────────────────────────────────

function WorktreeGroupSection({
  group,
  homeDir,
  displayMode,
  selectedSessionId,
  runningSessionIds,
  subagentRunningIds,
  unreadSessionIds,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleWorktree,
  onNewSession,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onToggleCollapse,
  visibleCount,
  onShowMore,
  onShowFewer,
  trustEntry,
  onOpenTrust,
  worktreeActions,
  confirmRemove,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  group: SidebarWorktreeGroup;
  homeDir: string;
  displayMode: SidebarDisplayMode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  subagentRunningIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleWorktree: (path: string) => void;
  onNewSession: () => void;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onToggleCollapse: (sessionId: string) => void;
  visibleCount: number;
  onShowMore: () => void;
  onShowFewer: () => void;
  /** 该 worktree 检出的信任状态；读取失败或不适用时为 null（不显示徽章） */
  trustEntry: ProjectTrustEntry | null;
  onOpenTrust: () => void;
  worktreeActions: WorktreeActions | null;
  confirmRemove: boolean;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  const { t } = useI18n();
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedWorktreePaths, group.path, searchActive);
  const label = group.branch ?? displayCwd(group.path, homeDir);
  const collapseLabel = collapsed
    ? t("sidebar_expandWorktreeNamed", { name: label })
    : t("sidebar_collapseWorktreeNamed", { name: label });

  return (
    <div>
      {/* 工作树行仅控制折叠；cwd 由会话行或新建会话入口切换。 */}
      <div
        className="sidebar-row"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapseLabel}
        onClick={() => onToggleWorktree(group.path)}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onToggleWorktree(group.path);
        }}
        title={group.path}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          paddingLeft: 22,
          paddingRight: 8,
          cursor: "pointer",
          background: "transparent",
          color: "var(--text-muted)",
        }}
      >
        <ChevronButton
          collapsed={collapsed}
          label={collapseLabel}
          onClick={(e) => {
            e.stopPropagation();
            onToggleWorktree(group.path);
          }}
        />
        <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }}>
          <BranchIcon size={11} />
        </span>
        <PathLabel
          text={label}
          style={{
            flex: 1,
            fontSize: 11.5,
            fontWeight: 400,
            fontFamily: "var(--font-mono)",
          }}
        />
        {trustEntry && (
          <ProjectTrustBadge status={trustEntry.status} projectName={label} onClick={onOpenTrust} />
        )}
        <SidebarIconButton
          label={t("sidebar_newSessionIn", { project: label })}
          hoverReveal
          onClick={(event) => {
            event.stopPropagation();
            onNewSession();
          }}
        >
          <ChatPlusIcon size={13} />
        </SidebarIconButton>
        {worktreeActions?.canManage && !confirmRemove && (
          <SidebarIconButton
             label={t("sidebar_removeWorktreeAt", { path: group.path })}
            danger
            hoverReveal
            disabled={worktreeActions.busy}
            onClick={(e) => {
              e.stopPropagation();
              onRequestRemove();
            }}
          >
            <TrashIcon size={13} />
          </SidebarIconButton>
        )}
      </div>

      {/* 脏删除确认：行内展示，Force/Cancel 文字按钮保证破坏性操作明确 */}
      {confirmRemove && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 30px", background: "rgba(239,68,68,0.06)" }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar_dirtyWorktreeConfirm")}
          </span>
          <button
            type="button"
            onClick={onConfirmRemove}
            disabled={worktreeActions?.busy}
            style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
          >
            {t("sidebar_forceRemove")}
          </button>
          <button
            type="button"
            onClick={onCancelRemove}
            style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
          >
            {t("sidebar_cancel")}
          </button>
        </div>
      )}

      {!collapsed && (
        <div style={{ paddingLeft: 20 }}>
          {getVisibleTopLevelNodes(group.tree, visibleCount, searchActive).map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              subagentRunningIds={subagentRunningIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={0}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleCollapse={onToggleCollapse}
              displayMode={displayMode}
            />
          ))}
          <GroupPagination
            groupKey={group.path}
            total={group.tree.length}
            visibleCount={visibleCount}
            searchActive={searchActive}
            onShowMore={onShowMore}
            onShowFewer={onShowFewer}
          />
          {group.tree.length === 0 && (
            <div style={{ padding: "2px 10px 5px 28px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("sidebar_noSessions")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 会话树（fork/subagent child 递归，语义由 session-tree 保证） ─────────────

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  subagentRunningIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  collapsedSessionIds,
  searchActive,
  onToggleCollapse,
  displayMode,
}: {
  node: SessionDisplayNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  subagentRunningIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleCollapse: (sessionId: string) => void;
  displayMode: SidebarDisplayMode;
}) {
  const hasChildren = node.children.length > 0;
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedSessionIds, node.session.id, searchActive);

  return (
    <div>
      <div data-session-id={node.session.id} style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          relation={node.relation}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id) || subagentRunningIds.has(node.session.id)}
          // subagent 子会话不参与未读（用户需求：子会话无未读状态）
          isUnread={!node.session.subagent && unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => onToggleCollapse(node.session.id)}
          displayMode={displayMode}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              subagentRunningIds={subagentRunningIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleCollapse={onToggleCollapse}
              displayMode={displayMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}


function SessionItem({
  session,
  relation = null,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  displayMode,
}: {
  session: SessionInfo;
  /** 与父会话的关系；根项为 null。fork 与 subagent 图标/语义分开呈现。 */
  relation?: SessionRelationKind | null;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  displayMode: SidebarDisplayMode;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const capabilities = getSessionCapabilities(session);
  // 尚未展开索引的 subagent 会话首消息为占位符，才用 agent/run 兜底；
  // 已有真实首消息时沿用内容标题，agent/run 由下方徽章补充，避免信息重复。
  const firstMessage = session.firstMessage.trim();
  const subagentFallback = session.subagent && (!firstMessage || firstMessage === "(no messages)")
     ? `${session.subagent.agent ? `${session.subagent.agent} · ` : ""}${t("sidebar_runCount", { count: session.subagent.runIndex })}`
    : "";
  const firstMessageLabel = firstMessage === "(no messages)" ? t("sidebar_noMessages") : session.firstMessage;
  const title = session.name
    || subagentFallback
    || firstMessageLabel.slice(0, 50)
    || session.id.slice(0, 12);

  const startRename = useCallback(() => {
    // 只读会话不允许改名（UI 层 guard；后端仍是权威防线）。
    if (!capabilities.canRename) return;
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name, capabilities.canRename]);

  const commitRename = useCallback(async () => {
    // 即使输入框因竞态仍处于打开状态，只读会话也不能发 PATCH。
    if (!capabilities.canRename) {
      setRenaming(false);
      return;
    }
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, capabilities.canRename]);

  const handleDeleteClick = useCallback(() => {
    // 只读会话不允许删除（UI 层 guard；后端仍是权威防线）。
    if (!capabilities.canDelete) return;
    setConfirmDelete(true);
  }, [capabilities.canDelete]);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    // 确认态期间能力若变化，仍不得发 DELETE。
    if (!capabilities.canDelete) {
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted, capabilities.canDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const compact = displayMode === "compact";
  const ITEM_HEIGHT = compact ? 28 : 46;

  return (
    <div
      className="sidebar-row"
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "color-mix(in srgb, var(--accent) 9%, var(--bg-selected))" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: compact ? 11 : 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar_deleteSession")} <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: compact ? 22 : 26, padding: "0 10px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: compact ? 11 : 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <TrashIcon size={11} />
              {t("sidebar_deleteSession")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: compact ? 22 : 26, padding: "0 10px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: compact ? 11 : 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar_cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          aria-label={t("sidebar_renameSession")}
          style={{
            flex: 1,
            fontSize: compact ? 11 : 12,
            padding: "0 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: compact ? 20 : 28,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* 行首 gutter：child 折叠 chevron 位于 relation/状态/标题之前；
              槽位常驻（无 child 留空）保证各行标题对齐。搜索期由
              isSessionNodeEffectivelyCollapsed 强制展开；原生 button 支持
              Enter/Space；粗指针命中区由 globals.css 媒体查询扩大。 */}
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, flexShrink: 0 }}>
            {hasChildren && (
              <button
                type="button"
                className="sidebar-chevron-btn"
                onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
                title={collapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
                aria-label={collapsed ? t("sidebar_expandChild") : t("sidebar_collapseChild")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0, flexShrink: 0, position: "relative",
                  background: "none", border: "none", borderRadius: 5,
                  color: "var(--text-dim)", cursor: "pointer",
                  transform: collapsed ? "rotate(-90deg)" : "none",
                  transition: "transform 0.15s",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>
            )}
          </span>
          {/* 关系图标：fork 用分叉图标，subagent 用层叠图标，一眼可区分 */}
          {depth > 0 && relation === "subagent" && (
            <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true">
              <LayersIcon size={10} />
            </span>
          )}
          {depth > 0 && relation !== "subagent" && (
            <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true">
              <BranchIcon size={10} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: compact ? 11.5 : 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              {/* 状态指示置前：运行中 / 未读显示在标题之前（OpenChamber 风格） */}
              {isRunning && <RunningSessionIndicator size={10} />}
              {!isRunning && isUnread && <UnreadSessionIndicator size={10} />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
              {/* Compact：subagent 徽章内联在标题后 */}
              {compact && session.subagent && (
                <span
                  title={`${t("sidebar_subagentReadOnly")}${session.subagent.agent ? ` · ${session.subagent.agent}` : ""} · ${t("sidebar_runCount", { count: session.subagent.runIndex })}`}
                  style={{ display: "flex", flexShrink: 0, color: "var(--text-muted)" }}
                >
                  <LayersIcon size={9} />
                </span>
              )}
            </div>
            {!compact && (
              <div style={{ marginTop: 1, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 10.5, minWidth: 0 }}>
              <span title={session.modified}>{formatRelativeTime(session.modified, t)}</span>
              <span>{t("sidebar_messagesCount", { count: session.messageCount })}</span>
              {/* subagent 徽章：agent 名 + run 次序 + 只读语义，克制但明确 */}
              {session.subagent && (
                <span
                  title={`${t("sidebar_subagentReadOnly")}${session.subagent.agent ? ` · ${session.subagent.agent}` : ""} · ${t("sidebar_runCount", { count: session.subagent.runIndex })}`}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-muted)", minWidth: 0, overflow: "hidden" }}
                >
                  <LayersIcon size={9} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                    {session.subagent.agent ? `${session.subagent.agent} · ` : ""}{t("sidebar_runCount", { count: session.subagent.runIndex })}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 9, padding: "0 4px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-dim)", lineHeight: 1.5 }}>
                    {t("sidebar_readOnly")}
                  </span>
                </span>
              )}
              {session.worktreeBranch && (
                <span
                  title={t("sidebar_worktreeTooltip", { path: session.cwd })}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <BranchIcon size={9} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
                </span>
              )}
            </div>
          )}
        </div>

          {/* 写操作与导出统一收口；只读会话仍可复制 ID 和导出。 */}
          <SessionRowMenu session={session} title={title} canRename={capabilities.canRename} canDelete={capabilities.canDelete} onRename={startRename} onDelete={handleDeleteClick}/>
        </>
      )}
    </div>
  );
}
