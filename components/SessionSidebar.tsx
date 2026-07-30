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
import {
  GROUP_VISIBLE_PAGE_SIZE,
  bumpGroupVisibleCount,
  canShowFewerTopLevel,
  canShowMoreTopLevel,
  getGroupVisibleCount,
  getVisibleTopLevelNodes,
  buildWorktreePreloadGeneration,
  mergeOptimisticSessions,
  reconcilePendingSessionIds,
  resetGroupVisibleCount,
  shouldApplySessionListResponse,
  upsertProjectWorktreeSnapshot,
  type ProjectWorktreeSnapshots,
} from "./session-sidebar-state";
import { getSessionCapabilities } from "./session-capabilities";
import { useProjectActions, useProjectIdentity } from "./ProjectProvider";
import { ViewportDialog } from "./ui/ViewportDialog";
import { ProjectTrustBadge, ProjectTrustDialog, useProjectTrust, type ProjectTrustEntry } from "./ProjectTrust";
import { useI18n } from "@/lib/i18n";
import { loadUnreadSessionIds, saveUnreadSessionIds } from "@/lib/unread-sessions-storage";

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

function formatRelativeTime(dateStr: string, t: ReturnType<typeof useI18n>["t"]): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return t("sidebar_justNow");
  if (mins < 60) return t("sidebar_minutesAgo", { count: mins });
  if (hours < 24) return t("sidebar_hoursAgo", { count: hours });
  if (days < 7) return t("sidebar_daysAgo", { count: days });
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

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pidance";
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
  haspopup,
  buttonRef,
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
  /** 弹出菜单语义（aria-haspopup），项目行三点菜单使用。 */
  haspopup?: "menu" | boolean;
  /** 触发按钮 ref：菜单关闭后焦点恢复用。 */
  buttonRef?: React.Ref<HTMLButtonElement>;
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
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={pressed}
      aria-haspopup={haspopup}
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

/** 竖向三点（⋮）：项目行菜单触发图标。 */
const MoreVerticalIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
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

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, optimisticSessions }: Props) {
  const { t } = useI18n();
  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
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
  // 桌面端原生目录选择器可用性（仅客户端探测，避免 SSR 水合不一致）
  const [desktopPickerAvailable, setDesktopPickerAvailable] = useState(false);
  // 项目行三点菜单：同一时刻仅一个打开（root 标识）
  const [openProjectMenuRoot, setOpenProjectMenuRoot] = useState<string | null>(null);
  // 编辑项目弹窗：目标项目根 + 名称草稿（打开时由 alias/路径显示名初始化）
  const [editProjectRoot, setEditProjectRoot] = useState<string | null>(null);
  const [editProjectValue, setEditProjectValue] = useState("");
  const editProjectInputRef = useRef<HTMLInputElement>(null);
  // 每个项目独立的 worktree 快照：缓存优先，后台限流预加载。
  const [worktreeSnapshots, setWorktreeSnapshots] = useState<ProjectWorktreeSnapshots>({});
  const worktreeSnapshotsRef = useRef<ProjectWorktreeSnapshots>({});
  const [worktreeMetadata, setWorktreeMetadata] = useState<Readonly<Record<string, Pick<WorktreeState, "isGit" | "isTopLevel">>>>({});
  const worktreeRequestsRef = useRef(new Set<string>());
  const worktreeRequestTokenRef = useRef(new Map<string, string>());
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
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions");
      // 仅最新代际可写 serverSessions / loading / error / refresh done / unread 清理。
      // 卸载后不得 setState。
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      setServerSessions(data.sessions);
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

  const commitWorktreeSnapshots = useCallback((updater: (prev: ProjectWorktreeSnapshots) => ProjectWorktreeSnapshots) => {
    setWorktreeSnapshots((prev) => {
      const next = updater(prev);
      worktreeSnapshotsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    worktreeRequestTokenRef.current.clear();
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

  // 每个项目 root 独立拉取；请求中去重，结果只写自身 key，旧请求不能覆盖别的项目。
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  const fetchProjectWorktrees = useCallback(async (projectRoot: string) => {
    if (worktreeRequestsRef.current.has(projectRoot)) return;
    const token = `${Date.now()}:${Math.random()}`;
    worktreeRequestsRef.current.add(projectRoot);
    worktreeRequestTokenRef.current.set(projectRoot, token);
    commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, { status: "loading" }));
    try {
      const response = await fetch(`/api/worktrees?cwd=${encodeURIComponent(projectRoot)}`);
      const data = await response.json().catch(() => ({})) as {
        projectRoot?: string;
        isGit?: boolean;
        isTopLevel?: boolean;
        worktrees?: WorktreeEntry[];
        error?: string;
      };
      if (!response.ok || data.error || !data.projectRoot) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (!mountedRef.current || worktreeRequestTokenRef.current.get(projectRoot) !== token) return;
      const canonicalRoot = data.projectRoot;
      const worktrees = data.worktrees ?? [];
      commitWorktreeSnapshots((prev) => {
        let next = upsertProjectWorktreeSnapshot(prev, projectRoot, { status: "ready", worktrees });
        if (canonicalRoot !== projectRoot) {
          next = upsertProjectWorktreeSnapshot(next, canonicalRoot, { status: "ready", worktrees });
        }
        return next;
      });
      setWorktreeMetadata((prev) => {
        const metadata = { isGit: data.isGit ?? false, isTopLevel: data.isTopLevel ?? false };
        return { ...prev, [projectRoot]: metadata, [canonicalRoot]: metadata };
      });
      if (selectedCwd && (selectedProjectRoot === projectRoot || selectedCwd === projectRoot)) {
        setIdentity({
          cwd: selectedCwd,
          projectRoot: canonicalRoot,
          branch: worktrees.find((worktree) => worktree.path === selectedCwd)?.branch ?? null,
          isGit: data.isGit ?? false,
          isTopLevel: data.isTopLevel ?? false,
          status: "ready",
          error: null,
        });
      }
    } catch (error) {
      if (!mountedRef.current || worktreeRequestTokenRef.current.get(projectRoot) !== token) return;
      commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (worktreeRequestTokenRef.current.get(projectRoot) === token) {
        worktreeRequestTokenRef.current.delete(projectRoot);
        worktreeRequestsRef.current.delete(projectRoot);
      }
    }
  }, [commitWorktreeSnapshots, selectedCwd, selectedProjectRoot, setIdentity]);

  const knownProjectRoots = useMemo(() => {
    const roots = getRecentProjects(allSessions);
    if (selectedProjectRoot && !roots.includes(selectedProjectRoot)) roots.unshift(selectedProjectRoot);
    else if (selectedCwd && !roots.includes(selectedCwd)) roots.unshift(selectedCwd);
    return roots;
  }, [allSessions, selectedCwd, selectedProjectRoot]);
  // worktree 预加载只跟 wtRefreshKey + known roots；session list refresh 不得重抓 worktree。
  // generation 不含 refreshKey（见 buildWorktreePreloadGeneration）。
  const worktreePreloadGenerationRef = useRef(new Map<string, string>());
  useEffect(() => {
    const generation = buildWorktreePreloadGeneration(wtRefreshKey);
    const queue = knownProjectRoots.filter((root) => worktreePreloadGenerationRef.current.get(root) !== generation);
    for (const root of queue) worktreePreloadGenerationRef.current.set(root, generation);
    let cancelled = false;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (!cancelled) {
        const root = queue.shift();
        if (!root) return;
        await fetchProjectWorktrees(root);
      }
    });
    void Promise.all(workers);
    return () => { cancelled = true; };
  }, [knownProjectRoots, wtRefreshKey, fetchProjectWorktrees]);

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
  }, [customPathValue, customPathValidating, projectRootFor, restoreClosedProject, selectCwd, closeCustomPathPanel]);

  /** 添加项目按钮：总是打开弹窗，不直接拉起原生目录选择器。 */
  const openAddProjectDialog = useCallback(() => {
    setCustomPathError(null);
    setCustomPathOpen(true);
  }, []);

  /** 弹窗内「选择目录」：仅调用原生选择器填充输入框，不直接提交。 */
  const handlePickDirectory = useCallback(async () => {
    const desktop = window.piDesktop;
    if (!desktop) return;
    try {
      setCustomPathError(null);
      const path = await desktop.selectDirectory();
      if (path !== null) setCustomPathValue(path);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
            <DialogButton
              primary
              disabled={customPathValidating || !customPathValue.trim()}
              onClick={() => void commitCustomPath()}
            >
              {customPathValidating ? t("sidebar_validating") : t("sidebar_add")}
            </DialogButton>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void commitCustomPath();
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
            {desktopPickerAvailable && (
              <DialogButton onClick={() => void handlePickDirectory()}>
                {t("sidebar_selectDirectory")}
              </DialogButton>
            )}
          </div>
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

// ── 弹窗按钮 ──────────────────────────────────────────────────────────────

/** 弹窗按钮：primary 为主操作（accent 填充白字），其余为次级（描边）。 */
function DialogButton({ primary = false, disabled = false, onClick, children }: {
  primary?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 30,
        padding: "0 14px",
        flexShrink: 0,
        background: primary ? "var(--accent)" : "var(--bg)",
        border: primary ? "none" : "1px solid var(--border)",
        borderRadius: 7,
        color: primary ? "#fff" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12,
        fontWeight: primary ? 600 : 500,
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
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

// ── 项目行三点菜单 ─────────────────────────────────────────────────────────

/**
 * 项目行竖向三点菜单：仅「编辑项目」「关闭项目」两项，均带图标。
 * 同一时刻仅一个菜单打开（父组件以 root 标识控制）；Escape 与点击外部关闭，
 * 关闭后焦点恢复触发按钮；桌面行 hover/focus-within 渐进显露，粗指针常显。
 * 本轮不提供右键菜单。
 */
function ProjectRowMenu({ open, onOpenChange, projectName, onEdit, onClose }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前显示名（alias 或路径显示名），仅用于 aria 文案。 */
  projectName: string;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    onOpenChange(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, [onOpenChange]);

  // 点击外部关闭（不抢焦点：点击目标自然获得焦点）
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  // 打开后焦点移入第一个菜单项（菜单键盘可达；Esc 由 wrapper onKeyDown 拦截）
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", flexShrink: 0, display: "flex" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          e.preventDefault();
          closeMenu(true);
        }
      }}
    >
      <SidebarIconButton
        label={t("sidebar_projectMenuLabel", { project: projectName })}
        active={open}
        expanded={open}
        haspopup="menu"
        hoverReveal
        buttonRef={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
      >
        <MoreVerticalIcon size={14} />
      </SidebarIconButton>
      <AnimatedDropdown
        open={open}
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
          minWidth: 148,
        }}
      >
        <div ref={menuRef} role="menu" aria-label={t("sidebar_projectMenuLabel", { project: projectName })}>
          <ProjectMenuItem
            icon={<PencilIcon size={13} />}
            label={t("sidebar_editProject")}
            onClick={() => { closeMenu(true); onEdit(); }}
          />
          <ProjectMenuItem
            icon={<XIcon size={13} />}
            label={t("sidebar_closeProject")}
            onClick={() => { closeMenu(true); onClose(); }}
          />
        </div>
      </AnimatedDropdown>
    </div>
  );
}

function ProjectMenuItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 12px",
        background: "var(--bg)",
        border: "none",
        color: "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--bg)";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
      onFocus={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.background = "var(--bg)";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true">{icon}</span>
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

function GroupPagination({ groupKey, total, visibleCount, searchActive, onShowMore, onShowFewer }: {
  groupKey: string;
  total: number;
  visibleCount: number;
  searchActive: boolean;
  onShowMore: (groupKey: string) => void;
  onShowFewer: (groupKey: string) => void;
}) {
  const { t } = useI18n();
  const showMore = canShowMoreTopLevel(total, visibleCount, searchActive);
  const showFewer = canShowFewerTopLevel(visibleCount, searchActive);
  if (!showMore && !showFewer) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 5px 28px" }}>
      {showMore && (
        <button type="button" className="sidebar-pagination-btn" onClick={() => onShowMore(groupKey)}>
          {t("sidebar_showMore")}
          <span aria-hidden="true">+{GROUP_VISIBLE_PAGE_SIZE}</span>
        </button>
      )}
      {showFewer && (
        <button type="button" className="sidebar-pagination-btn" onClick={() => onShowFewer(groupKey)}>
          {t("sidebar_showFewer")}
        </button>
      )}
    </div>
  );
}

function ProjectSection({
  project,
  homeDir,
  displayMode,
  projectAliases,
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
  const isCurrentProject = selectedProject === project.root;
  const collapsed = isSessionNodeEffectivelyCollapsed(collapsedProjectRoots, project.root, searchActive);
  const hasSessions = project.mainTree.length > 0 || project.worktrees.some((group) => group.tree.length > 0);
  // 显示名优先 alias；title 仍保留真实 root 路径（见行 title 属性）。
  const projectName = projectAliases[project.root] ?? displayCwd(project.root, homeDir);
  const trustEntry = trustEntries.get(project.root) ?? null;

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
           label={collapsed ? t("sidebar_expandProjectNamed", { project: projectName }) : t("sidebar_collapseProjectNamed", { project: projectName })}
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
              selectedCwd={selectedCwd}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              collapsedWorktreePaths={collapsedWorktreePaths}
              collapsedSessionIds={collapsedSessionIds}
              searchActive={searchActive}
              onToggleWorktree={(path) => onToggleWorktree(path)}
              onSelectWorktree={(path) => onSelectWorktree(path, project.root)}
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
  selectedCwd,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  collapsedWorktreePaths,
  collapsedSessionIds,
  searchActive,
  onToggleWorktree,
  onSelectWorktree,
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
  selectedCwd: string | null;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  collapsedWorktreePaths: ReadonlySet<string>;
  collapsedSessionIds: ReadonlySet<string>;
  searchActive: boolean;
  onToggleWorktree: (path: string) => void;
  onSelectWorktree: (path: string) => void;
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
           label={collapsed ? t("sidebar_expandWorktreeNamed", { name: label }) : t("sidebar_collapseWorktreeNamed", { name: label })}
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
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar_running")}
      aria-label={t("sidebar_running")}
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
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar_activity")}
      aria-label={t("sidebar_activity")}
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
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
              {/* Compact：状态指示内联在标题后，次要元数据整体隐藏 */}
              {compact && isRunning && <RunningSessionIndicator size={12} />}
              {compact && !isRunning && isUnread && <UnreadSessionIndicator size={12} />}
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
                {isRunning ? (
                  <RunningSessionIndicator />
                ) : isUnread ? (
                  <UnreadSessionIndicator />
                ) : (
                  <span title={session.modified}>{formatRelativeTime(session.modified, t)}</span>
                )}
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

          {/* 行内操作：恒渲染保证触屏可发现、键盘可 Tab 到达；
              细指针下由 .sidebar-row hover/focus-within 渐进显露，
              粗指针设备常显（globals.css 媒体查询）；只读会话不提供写操作入口 */}
          {(capabilities.canRename || capabilities.canDelete) && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {capabilities.canRename && (
                <SidebarIconButton label={t("sidebar_renameSession")} hoverReveal onClick={startRename}>
                  <PencilIcon size={13} />
                </SidebarIconButton>
              )}
              {capabilities.canDelete && (
                <SidebarIconButton label={t("sidebar_deleteSession")} danger hoverReveal onClick={handleDeleteClick}>
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
