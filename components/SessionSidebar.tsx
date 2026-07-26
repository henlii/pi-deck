"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { displayCwd, getRecentProjects, type WorktreeEntry, type WorktreeState } from "@/lib/project-context";
import {
  isSessionNodeEffectivelyCollapsed,
  normalizeSessionQuery,
  type SessionDisplayNode,
  type SessionRelationKind,
} from "./session-tree";
import {
  buildSidebarTree,
  collectAllCollapseIds,
  filterSidebarTree,
  locateSessionInSidebarTree,
  type SidebarProjectNode,
  type SidebarWorktreeGroup,
} from "./session-sidebar-model";
import {
  loadSidebarPreferences,
  saveSidebarPreferences,
  type SidebarDisplayMode,
  type SidebarPreferences,
} from "@/lib/ui-preferences";
import { getSessionCapabilities } from "./session-capabilities";
import { useProjectActions, useProjectIdentity } from "./ProjectProvider";

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
  onNewSession?: () => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Deck";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

// ── 统一图标按钮与图标 ─────────────────────────────────────────────────────

/**
 * 会话栏统一图标按钮：24×24 盒、6px 圆角、hover/active/focus-visible/disabled
 * 样式全部由 globals.css 的 .sidebar-icon-btn 系列类承载；
 * label 同时作为 title（tooltip）与 aria-label。
 */
function SidebarIconButton({
  label,
  onClick,
  disabled = false,
  active = false,
  danger = false,
  done = false,
  hoverReveal = false,
  expanded,
  pressed,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  /** toggle 开启态（搜索/菜单展开）。 */
  active?: boolean;
  /** 危险操作（hover 变红）。 */
  danger?: boolean;
  /** 刷新完成反馈态。 */
  done?: boolean;
  /** 行内操作渐进显露：细指针下行 hover/focus-within 才可见；
      hover:none / 粗指针设备上常显（globals.css 媒体查询），保证触屏可发现。 */
  hoverReveal?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  const classes = ["sidebar-icon-btn"];
  if (active) classes.push("sidebar-icon-btn--active");
  if (danger) classes.push("sidebar-icon-btn--danger");
  if (done) classes.push("sidebar-icon-btn--done");
  if (hoverReveal) classes.push("sidebar-icon-btn--hover");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={pressed}
      className={classes.join(" ")}
    >
      {children}
    </button>
  );
}

function iconProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
}

const FolderPlusIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6" />
    <path d="M9 13h6" />
  </svg>
);

const FolderIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const ChatPlusIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M12 7v6" />
    <path d="M9 10h6" />
  </svg>
);

const SearchIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const SlidersIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);

const RefreshIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const HomeIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const XIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const BranchIcon = ({ size = 12 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

const BranchPlusIcon = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
    <circle cx="18" cy="6" r="3" />
    <path d="M15.5 17.5h5" />
    <path d="M18 15v5" />
  </svg>
);

const TrashIcon = ({ size = 13 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

const PencilIcon = ({ size = 13 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

const LayersIcon = ({ size = 10 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

/** 折叠 chevron：20×20 透明小按钮，旋转表示折叠态。 */
function ChevronButton({ collapsed, label, onClick }: {
  collapsed: boolean;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 20, height: 20, padding: 0, flexShrink: 0,
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
  );
}

// ── 主组件 ─────────────────────────────────────────────────────────────────

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted }: Props) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { cwd: selectedCwd } = useProjectIdentity();
  const { setIdentity } = useProjectActions();
  const [homeDir, setHomeDir] = useState<string>("");
  // 添加项目（自定义路径第二行面板；桌面端优先原生目录选择）
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  // Worktree 管理状态（仅作用于当前选中项目）
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtNewForProject, setWtNewForProject] = useState<string | null>(null);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  // 搜索：查询与开关均为组件瞬时态，不写入偏好
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 显示模式菜单
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  // 跨刷新偏好：显示模式 + 项目/worktree 折叠集合（独立 seam）
  const [prefs, setPrefs] = useState<SidebarPreferences>(() => loadSidebarPreferences());
  // 会话级 child 折叠：保持瞬时（沿用原行为）
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(() => new Set());
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
      if (next !== prev) saveSidebarPreferences(next);
      return next;
    });
  }, []);

  const displayMode = prefs.displayMode;
  const collapsedProjectRoots = useMemo(() => new Set(prefs.collapsedProjectRoots), [prefs.collapsedProjectRoots]);
  const collapsedWorktreePaths = useMemo(() => new Set(prefs.collapsedWorktreePaths), [prefs.collapsedWorktreePaths]);

  const loadSessions = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

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

  /** 从最新本地数据乐观解析项目根；服务端响应仍是权威来源。 */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeState, allSessions]);
  const selectCwd = useCallback((cwd: string | null, explicitRoot?: string | null) => {
    const root = cwd === null ? null : explicitRoot ?? projectRootFor(cwd) ?? cwd;
    setIdentity({ cwd, projectRoot: root, status: cwd ? "ready" : "idle", error: null });
  }, [projectRootFor, setIdentity]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          worktrees: d.worktrees ?? [],
        });
        setIdentity({ cwd: selectedCwd, projectRoot: d.projectRoot, branch: d.worktrees?.find((worktree) => worktree.path === selectedCwd)?.branch ?? null, isGit: d.isGit ?? false, isTopLevel: d.isTopLevel ?? false, status: "ready", error: null });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey, setIdentity]);

  // 切换项目时收起未完成的 worktree 操作行，避免状态串到别的项目。
  useEffect(() => {
    setWtNewForProject(null);
    setWtNewBranch("");
    setWtError(null);
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
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) selectCwd(projects[0]);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, selectCwd]);

  const closeCustomPathPanel = useCallback(() => {
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCustomPathError(null);
  }, []);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
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
      selectCwd(data.cwd ?? path);
      closeCustomPathPanel();
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, selectCwd, closeCustomPathPanel]);

  const handleCustomPathClick = useCallback(async () => {
    const desktop = window.piDesktop;
    if (!desktop) {
      setCustomPathOpen(true);
      setCustomPathError(null);
      setTimeout(() => customPathInputRef.current?.focus(), 0);
      return;
    }

    try {
      setCustomPathError(null);
      const path = await desktop.selectDirectory();
      if (path === null) return;

      setCustomPathValue(path);
      setCustomPathOpen(true);
      await commitCustomPath(path);
    } catch (e) {
      setCustomPathOpen(true);
      setCustomPathError(e instanceof Error ? e.message : String(e));
      setTimeout(() => customPathInputRef.current?.focus(), 0);
    }
  }, [commitCustomPath]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        selectCwd(data.cwd);
        closeCustomPathPanel();
      }
    } catch {
      // ignore
    }
  }, [selectCwd, closeCustomPathPanel]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewForProject(null);
      setWtNewBranch("");
      // Optimistically register the new worktree so projectRootFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      selectCwd(data.path, worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState, selectCwd]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (selectedCwd === path) selectCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, selectedCwd, selectCwd]);

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

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    onNewSession?.();
  }, [selectedCwd, onNewSession]);

  // 搜索行开关：打开自动聚焦；关闭同时清空瞬时查询。
  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false);
      setSessionQuery("");
    } else {
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchOpen]);

  // 当前有效项目根（由 selectedCwd 乐观解析；服务端 worktree 数据仍是权威）
  const selectedProject = projectRootFor(selectedCwd);

  // 全项目树：分组/排序/空态补齐全部在纯模型内完成。
  const knownWorktrees = useMemo(
    () => (worktreeState && selectedProject === worktreeState.projectRoot ? worktreeState.worktrees : []),
    [worktreeState, selectedProject],
  );
  const sidebarTree = useMemo(
    () => buildSidebarTree(allSessions, { selectedCwd, selectedProjectRoot: selectedProject, knownWorktrees }),
    [allSessions, selectedCwd, selectedProject, knownWorktrees],
  );
  const normalizedSessionQuery = normalizeSessionQuery(sessionQuery);
  const searchActive = normalizedSessionQuery.length > 0;
  const visibleTree = useMemo(
    () => filterSidebarTree(sidebarTree, normalizedSessionQuery),
    [sidebarTree, normalizedSessionQuery],
  );

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
    setCollapsedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // 项目折叠：显式用户动作，写入偏好。行点击选中项目时顺带展开（见下行）。
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

  /** 点击项目标题：切换有效 cwd 到项目根；若项目处于折叠态则展开。 */
  const handleSelectProject = useCallback((root: string) => {
    selectCwd(root, root);
    updatePrefs((prev) => prev.collapsedProjectRoots.includes(root)
      ? { ...prev, collapsedProjectRoots: prev.collapsedProjectRoots.filter((item) => item !== root) }
      : prev);
  }, [selectCwd, updatePrefs]);

  /** 点击非主 worktree 标题：切换有效 cwd 到该检出；折叠态则展开。 */
  const handleSelectWorktree = useCallback((path: string, projectRoot: string) => {
    selectCwd(path, projectRoot);
    updatePrefs((prev) => prev.collapsedWorktreePaths.includes(path)
      ? { ...prev, collapsedWorktreePaths: prev.collapsedWorktreePaths.filter((item) => item !== path) }
      : prev);
  }, [selectCwd, updatePrefs]);

  const setDisplayMode = useCallback((mode: SidebarDisplayMode) => {
    updatePrefs((prev) => (prev.displayMode === mode ? prev : { ...prev, displayMode: mode }));
  }, [updatePrefs]);

  const collapseAll = useCallback(() => {
    const ids = collectAllCollapseIds(sidebarTree);
    updatePrefs((prev) => ({
      ...prev,
      collapsedProjectRoots: ids.projectRoots,
      collapsedWorktreePaths: ids.worktreePaths,
    }));
  }, [sidebarTree, updatePrefs]);

  const expandAll = useCallback(() => {
    updatePrefs((prev) => (prev.collapsedProjectRoots.length === 0 && prev.collapsedWorktreePaths.length === 0
      ? prev
      : { ...prev, collapsedProjectRoots: [], collapsedWorktreePaths: [] }));
  }, [updatePrefs]);

  // worktree 管理能力：仅当前选中项目、且已加载该项目的 git 顶层信息时可
  // 创建/删除；worktreeState 必须属于本项目，否则项目切换瞬间会用错仓库根。
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const worktreeActionsFor = useCallback((projectRoot: string): WorktreeActions | null => {
    if (projectRoot !== selectedProject || !selectedCwd) return null;
    const state = worktreeState && worktreeState.projectRoot === projectRoot ? worktreeState : null;
    const canManage = Boolean(state?.isGit && state.isTopLevel);
    const createHint = canManage
      ? "New worktree for this project"
      : worktreeLoading
        ? "Checking worktrees for this directory…"
        : state?.isGit
          ? "Open the repository root to manage worktrees."
          : "Worktrees are available in Git repository roots.";
    return { canManage, createHint, busy: wtBusy };
  }, [selectedProject, selectedCwd, worktreeState, worktreeLoading, wtBusy]);

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
              label="Add project directory…"
              onClick={() => void handleCustomPathClick()}
              active={customPathOpen}
            >
              <FolderPlusIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label={selectedCwd ? `New session in ${displayCwd(selectedCwd, homeDir)}` : "Select a project first"}
              disabled={!selectedCwd}
              onClick={handleNewSession}
            >
              <ChatPlusIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label="Search sessions"
              active={searchOpen}
              expanded={searchOpen}
              onClick={toggleSearch}
            >
              <SearchIcon size={18} />
            </SidebarIconButton>
            <div ref={displayMenuRef} style={{ position: "relative" }}>
              <SidebarIconButton
                label="Display options"
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
                    label="Standard"
                    checked={displayMode === "standard"}
                    onClick={() => { setDisplayMode("standard"); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label="Compact"
                    checked={displayMode === "compact"}
                    onClick={() => { setDisplayMode("compact"); setDisplayMenuOpen(false); }}
                  />
                  <div style={{ borderTop: "1px solid var(--border)", margin: "2px 0" }} />
                  <DisplayMenuItem
                    label="Collapse all"
                    onClick={() => { collapseAll(); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label="Expand all"
                    onClick={() => { expandAll(); setDisplayMenuOpen(false); }}
                  />
                </div>
              </AnimatedDropdown>
            </div>
            <SidebarIconButton
              label="Refresh session list"
              done={sessionRefreshDone}
              onClick={() => loadSessions(false)}
            >
              {sessionRefreshDone ? <CheckIcon size={16} /> : <RefreshIcon size={16} />}
            </SidebarIconButton>
          </div>
        </div>

        {/* 搜索行：第二行展示、自动聚焦、Esc 先清空再关闭；范围覆盖全部项目 */}
        {searchOpen && (
          <div style={{ marginTop: 8, position: "relative" }}>
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
                  if (sessionQuery) setSessionQuery("");
                  else {
                    setSearchOpen(false);
                    setSessionQuery("");
                  }
                }
              }}
              placeholder="Search all sessions…"
              aria-label="Search sessions"
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
                onClick={() => setSessionQuery("")}
                aria-label="Clear session search"
                title="Clear search"
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
        )}

        {/* 添加项目行：自定义路径（桌面端 handleCustomPathClick 直接弹原生目录选择） */}
        {customPathOpen && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                ref={customPathInputRef}
                value={customPathValue}
                onChange={(e) => {
                  setCustomPathValue(e.target.value);
                  setCustomPathError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitCustomPath();
                  }
                  if (e.key === "Escape") closeCustomPathPanel();
                }}
                placeholder="/path/to/project"
                aria-label="Project directory path"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 30,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "0 8px",
                  border: "1px solid var(--accent)",
                  borderRadius: 6,
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <SidebarIconButton label="Use default directory" onClick={() => void handleDefaultCwd()}>
                <HomeIcon size={15} />
              </SidebarIconButton>
              <SidebarIconButton
                label={customPathValidating ? "Checking…" : "Open path"}
                disabled={customPathValidating || !customPathValue.trim()}
                onClick={() => void commitCustomPath()}
              >
                <CheckIcon size={15} />
              </SidebarIconButton>
              <SidebarIconButton label="Cancel" onClick={closeCustomPathPanel}>
                <XIcon size={14} />
              </SidebarIconButton>
            </div>
            {customPathError && (
              <div style={{
                marginTop: 5,
                color: "#dc2626",
                fontSize: 11,
                lineHeight: 1.35,
                overflowWrap: "anywhere",
              }}>
                {customPathError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 项目树：Project → (非主 Worktree) → Session → child */}
      <div ref={sessionListRef} style={{ flex: "1 1 auto", overflowY: "auto", padding: "2px 0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            Loading...
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && visibleTree.length === 0 && (
          searchActive ? (
            <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
              No sessions match “{sessionQuery.trim()}”
            </div>
          ) : (
            <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>
              No projects yet.
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                Add a project directory with the folder button above.
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
            selectedCwd={selectedCwd}
            selectedProject={selectedProject}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            collapsedProjectRoots={collapsedProjectRoots}
            collapsedWorktreePaths={collapsedWorktreePaths}
            collapsedSessionIds={collapsedSessionIds}
            searchActive={searchActive}
            onToggleProject={toggleProjectCollapse}
            onToggleWorktree={toggleWorktreeCollapse}
            onSelectProject={handleSelectProject}
            onSelectWorktree={handleSelectWorktree}
            onSelectSession={handleSelectSessionFromList}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
            onToggleCollapse={toggleSessionCollapse}
            worktreeActions={worktreeActionsFor(project.root)}
            wtNewOpen={wtNewForProject === project.root}
            wtNewBranch={wtNewBranch}
            wtError={wtError}
            wtConfirmRemove={wtConfirmRemove}
            wtNewInputRef={wtNewInputRef}
            onStartCreateWorktree={() => {
              setWtNewForProject(project.root);
              setWtError(null);
              setTimeout(() => wtNewInputRef.current?.focus(), 0);
            }}
            onWtNewBranchChange={(value) => {
              setWtNewBranch(value);
              setWtError(null);
            }}
            onSubmitCreateWorktree={() => void handleCreateWorktree()}
            onCancelCreateWorktree={() => {
              setWtNewForProject(null);
              setWtNewBranch("");
              setWtError(null);
            }}
            onRequestRemoveWorktree={(path) => void handleRemoveWorktree(path, false)}
            onConfirmRemoveWorktree={(path) => void handleRemoveWorktree(path, true)}
            onCancelRemoveWorktree={() => setWtConfirmRemove(null)}
           />
         ))}
       </div>
     </div>
   );
 }

// ── 显示模式菜单项 ─────────────────────────────────────────────────────────

function DisplayMenuItem({ label, checked, onClick }: { label: string; checked?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "7px 10px",
        background: "var(--bg)",
        border: "none",
        color: checked ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 11.5,
      }}
    >
      {checked
        ? <span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}><CheckIcon size={11} /></span>
        : <span style={{ width: 11, flexShrink: 0 }} />}
      {label}
    </button>
  );
}

// ── 项目分区（项目行 + 主仓会话 + 非主 worktree 分组） ──────────────────────

interface WorktreeActions {
  /** 本项目 worktree 状态已加载且为 git 顶层检出：可创建/删除。 */
  canManage: boolean;
  createHint: string;
  busy: boolean;
}

function ProjectSection({
  project,
  homeDir,
  displayMode,
  selectedCwd,
  selectedProject,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  collapsedProjectRoots,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleProject,
  onToggleWorktree,
  onSelectProject,
  onSelectWorktree,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onToggleCollapse,
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
  selectedCwd: string | null;
  selectedProject: string | null;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedProjectRoots: ReadonlySet<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleProject: (root: string) => void;
  onToggleWorktree: (path: string) => void;
  onSelectProject: (root: string) => void;
  onSelectWorktree: (path: string, projectRoot: string) => void;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onToggleCollapse: (sessionId: string) => void;
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
  const isCurrentProject = selectedProject === project.root;
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedProjectRoots, project.root, searchActive);
  const hasSessions = project.mainTree.length > 0 || project.worktrees.some((group) => group.tree.length > 0);
  const projectName = displayCwd(project.root, homeDir);

  return (
    <div>
      {/* 项目行：点击切换有效 cwd；chevron 独立折叠 */}
      <div
        className="sidebar-row"
        onClick={() => onSelectProject(project.root)}
        title={project.root}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 30,
          paddingLeft: 6,
          paddingRight: 8,
          cursor: "pointer",
          background: isCurrentProject ? "var(--bg-selected)" : "transparent",
          color: isCurrentProject ? "var(--text)" : "var(--text-muted)",
        }}
      >
        <ChevronButton
          collapsed={collapsed}
          label={collapsed ? `Expand project ${projectName}` : `Collapse project ${projectName}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleProject(project.root);
          }}
        />
        <span style={{ display: "flex", flexShrink: 0, color: isCurrentProject ? "var(--accent)" : "var(--text-dim)" }}>
          <FolderIcon size={13} />
        </span>
        <PathLabel
          text={projectName}
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: isCurrentProject ? 600 : 500,
            fontFamily: "var(--font-mono)",
          }}
        />
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
      </div>

      {!collapsed && (
        <div>
          {/* 主仓会话：主 worktree 隐式，直接列在项目下 */}
          <div style={{ paddingLeft: 10 }}>
            {project.mainTree.map((node) => (
              <SessionTreeItem
                key={node.session.id}
                node={node}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
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
          </div>

          {/* 非主 worktree 分组 */}
          {project.worktrees.map((group) => (
            <WorktreeGroupSection
              key={group.path}
              group={group}
              homeDir={homeDir}
              displayMode={displayMode}
              selectedCwd={selectedCwd}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              collapsedWorktreePaths={collapsedWorktreePaths}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleWorktree={(path) => onToggleWorktree(path)}
              onSelectWorktree={(path) => onSelectWorktree(path, project.root)}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onToggleCollapse={onToggleCollapse}
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
                placeholder="branch name"
                aria-label="New worktree branch name"
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
                label={worktreeActions.busy ? "Creating…" : "Create worktree"}
                disabled={worktreeActions.busy || !wtNewBranch.trim()}
                onClick={onSubmitCreateWorktree}
              >
                <CheckIcon size={14} />
              </SidebarIconButton>
              <SidebarIconButton label="Cancel" onClick={onCancelCreateWorktree}>
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
              No sessions yet
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
  selectedCwd,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleWorktree,
  onSelectWorktree,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onToggleCollapse,
  worktreeActions,
  confirmRemove,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  group: SidebarWorktreeGroup;
  homeDir: string;
  displayMode: SidebarDisplayMode;
  selectedCwd: string | null;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleWorktree: (path: string) => void;
  onSelectWorktree: (path: string) => void;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onToggleCollapse: (sessionId: string) => void;
  worktreeActions: WorktreeActions | null;
  confirmRemove: boolean;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedWorktreePaths, group.path, searchActive);
  const isCurrent = selectedCwd === group.path;
  const label = group.branch ?? displayCwd(group.path, homeDir);

  return (
    <div>
      {/* 分组标题行：点击切换有效 cwd 到该检出；chevron 独立折叠 */}
      <div
        className="sidebar-row"
        onClick={() => onSelectWorktree(group.path)}
        title={group.path}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          paddingLeft: 22,
          paddingRight: 8,
          cursor: "pointer",
          background: isCurrent ? "var(--bg-hover)" : "transparent",
          color: isCurrent ? "var(--text)" : "var(--text-muted)",
        }}
      >
        <ChevronButton
          collapsed={collapsed}
          label={collapsed ? `Expand worktree ${label}` : `Collapse worktree ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleWorktree(group.path);
          }}
        />
        <span style={{ display: "flex", flexShrink: 0, color: isCurrent ? "var(--accent)" : "var(--text-dim)" }}>
          <BranchIcon size={11} />
        </span>
        <PathLabel
          text={label}
          style={{
            flex: 1,
            fontSize: 11.5,
            fontWeight: isCurrent ? 600 : 400,
            fontFamily: "var(--font-mono)",
          }}
        />
        {worktreeActions?.canManage && !confirmRemove && (
          <SidebarIconButton
            label={`Remove worktree checkout ${group.path}; the branch is kept`}
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
            Uncommitted changes. Force remove checkout?
          </span>
          <button
            type="button"
            onClick={onConfirmRemove}
            disabled={worktreeActions?.busy}
            style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
          >
            Force
          </button>
          <button
            type="button"
            onClick={onCancelRemove}
            style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
          >
            Cancel
          </button>
        </div>
      )}

      {!collapsed && (
        <div style={{ paddingLeft: 20 }}>
          {group.tree.map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
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
          {group.tree.length === 0 && (
            <div style={{ padding: "2px 10px 5px 28px", color: "var(--text-dim)", fontSize: 11 }}>
              No sessions
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
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
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

function RunningSessionIndicator({ size = 14 }: { size?: number }) {
  return (
    <span
      title="Agent running…"
      aria-label="Agent running"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator({ size = 14 }: { size?: number }) {
  return (
    <span
      title="New activity"
      aria-label="New session activity"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
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
    ? `${session.subagent.agent ? `${session.subagent.agent} · ` : ""}run ${session.subagent.runIndex}`
    : "";
  const title = session.name
    || subagentFallback
    || session.firstMessage.slice(0, 50)
    || session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
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

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
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
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
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
            Delete <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
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
              Delete
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
              Cancel
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
          aria-label="Rename session"
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
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
              {/* Compact：状态指示内联在标题后，次要元数据整体隐藏 */}
              {compact && isRunning && <RunningSessionIndicator size={12} />}
              {compact && !isRunning && isUnread && <UnreadSessionIndicator size={12} />}
              {compact && session.subagent && (
                <span
                  title={`Subagent session (read-only)${session.subagent.agent ? ` · agent: ${session.subagent.agent}` : ""} · run ${session.subagent.runIndex}`}
                  style={{ display: "flex", flexShrink: 0, color: "var(--text-muted)" }}
                >
                  <LayersIcon size={9} />
                </span>
              )}
            </div>
            {!compact && (
              <div style={{ marginTop: 1, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 10.5, minWidth: 0 }}>
                {isRunning ? (
                  <RunningSessionIndicator />
                ) : isUnread ? (
                  <UnreadSessionIndicator />
                ) : (
                  <span title={session.modified}>{formatRelativeTime(session.modified)}</span>
                )}
                <span>{session.messageCount} msgs</span>
                {/* subagent 徽章：agent 名 + run 次序 + 只读语义，克制但明确 */}
                {session.subagent && (
                  <span
                    title={`Subagent session (read-only)${session.subagent.agent ? ` · agent: ${session.subagent.agent}` : ""} · run ${session.subagent.runIndex} · started by this session's subagent tool call`}
                    style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-muted)", minWidth: 0, overflow: "hidden" }}
                  >
                    <LayersIcon size={9} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                      {session.subagent.agent ? `${session.subagent.agent} · ` : ""}run {session.subagent.runIndex}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 9, padding: "0 4px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-dim)", lineHeight: 1.5 }}>
                      read-only
                    </span>
                  </span>
                )}
                {session.worktreeBranch && (
                  <span
                    title={`Worktree: ${session.cwd}`}
                    style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                  >
                    <BranchIcon size={9} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "Expand child sessions" : "Collapse child sessions"}
              aria-label={collapsed ? "Expand child sessions" : "Collapse child sessions"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* 行内操作：恒渲染保证触屏可发现、键盘可 Tab 到达；
              细指针下由 .sidebar-row hover/focus-within 渐进显露，
              粗指针设备常显（globals.css 媒体查询）；只读会话不提供写操作入口 */}
          {(capabilities.canRename || capabilities.canDelete) && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {capabilities.canRename && (
                <SidebarIconButton label="Rename" hoverReveal onClick={startRename}>
                  <PencilIcon size={13} />
                </SidebarIconButton>
              )}
              {capabilities.canDelete && (
                <SidebarIconButton label="Delete" danger hoverReveal onClick={handleDeleteClick}>
                  <TrashIcon size={13} />
                </SidebarIconButton>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
