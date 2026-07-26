"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatusResponse } from "@/lib/git-types";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitPanel } from "./GitPanel";

interface Props {
  /** 桌面：折叠/展开；移动：抽屉显隐。 */
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  cwd: string | null;
  isMobile: boolean;
  mobileReady: boolean;
  onOpenFile: (filePath: string, fileName: string) => void;
  /** 外部文件刷新信号（agent_end 等），与本地手动刷新合并。 */
  fileRefreshKey?: number;
  /** 外部 Git 刷新信号；FileViewer 的 gitRefreshKey 同源。 */
  gitRefreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}

type WorkspaceTab = "files" | "git";

/** 桌面调宽边界：窄到不挤压会话，宽到可读长路径。 */
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;

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

const FolderIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const BranchIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

const UploadIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </svg>
);

const RefreshIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const CollapseIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps(size)}>
    <polyline points="13 5 20 12 13 19" />
    <polyline points="5 5 12 12 5 19" />
  </svg>
);

/** 工作区统一小图标按钮（复用 globals.css 的 .sidebar-icon-btn 规格）。 */
function WorkspaceIconButton({ label, onClick, active = false, pressed, disabled = false, badge, children }: {
  label: string;
  onClick: () => void;
  active?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  /** 变更数等小徽标；>0 才显示。 */
  badge?: number;
  children: React.ReactNode;
}) {
  const classes = ["sidebar-icon-btn"];
  if (active) classes.push("sidebar-icon-btn--active");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={classes.join(" ")}
      style={{ position: "relative" }}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -3,
            right: -4,
            minWidth: 12,
            height: 12,
            padding: "0 3px",
            borderRadius: 999,
            background: "var(--accent)",
            color: "#fff",
            fontSize: 8.5,
            fontWeight: 700,
            lineHeight: "12px",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

/**
 * 最右侧工作区：顶部 Files/Git 图标 tab，FileExplorer 与只读 GitPanel。
 * 文件预览不在此处——点击文件经 onOpenFile 进入左侧独立主工作区（中央 tab）。
 */
export function RightWorkspace({
  open,
  width,
  onWidthChange,
  onClose,
  cwd,
  isMobile,
  mobileReady,
  onOpenFile,
  fileRefreshKey,
  gitRefreshKey,
  onAtMention,
  onAtMentions,
}: Props) {
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [filesRefreshTick, setFilesRefreshTick] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const fetchGitStatus = useCallback(async () => {
    if (!cwd) {
      setGitStatus(null);
      setGitError(null);
      return;
    }
    setGitLoading(true);
    try {
      const params = new URLSearchParams({ cwd });
      const res = await fetch(`/api/git/status?${params.toString()}`);
      const data = await res.json().catch(() => ({})) as GitStatusResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Failed to load Git status (HTTP ${res.status})`);
      setGitStatus(data);
      setGitError(null);
    } catch (e) {
      setGitError(e instanceof Error ? e.message : String(e));
      setGitStatus(null);
    } finally {
      setGitLoading(false);
    }
  }, [cwd]);

  // 仅打开时拉取；cwd / 外部刷新信号变化时重拉。
  useEffect(() => {
    if (!open) return;
    void fetchGitStatus();
  }, [open, fetchGitStatus, gitRefreshKey]);

  // 上传完成后工作区内容已变化：同步刷新 Git 状态（untracked 等）。
  const prevUploadBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevUploadBusyRef.current;
    prevUploadBusyRef.current = uploadBusy;
    if (wasBusy && !uploadBusy) void fetchGitStatus();
  }, [uploadBusy, fetchGitStatus]);

  // ── 桌面拖拽调宽 ──
  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [isMobile, width]);
  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 手柄在工作区左缘：向左拖增宽、向右拖收窄。
    const viewportMax = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth * 0.42));
    const next = Math.min(viewportMax, Math.max(MIN_WIDTH, drag.startWidth + (drag.startX - e.clientX)));
    onWidthChange(next);
  }, [onWidthChange]);
  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const changeCount = gitStatus?.isGitRepository ? gitStatus.files.length : 0;

  return (
    <div
      className={`workspace-container${open ? " workspace-open" : " workspace-closed"}${dragging ? " workspace-dragging" : ""}${mobileReady ? "" : " workspace-mobile-pending"}`}
      style={{
        width: open ? width : 0,
        minWidth: open ? width : 0,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        position: "relative",
        flexShrink: 0,
        zIndex: 200,
      }}
      role="complementary"
      aria-label="Files and Git workspace"
      aria-hidden={!open}
      inert={!open}
    >
      {/* 拖拽调宽手柄（桌面；移动端 CSS 隐藏） */}
      {open && (
        <div
          className={`workspace-resize-handle${dragging ? " dragging" : ""}`}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => onWidthChange(288)}
          title="Drag to resize workspace"
          aria-hidden="true"
        />
      )}

      <div className="workspace-inner" style={{ width, minWidth: width, height: "100%", display: "flex", flexDirection: "column" }}>
        {/* 顶部图标 tab 行（24×24 规格；tooltip/aria-label/focus-visible 由类承载） */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, height: 36, padding: "0 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <WorkspaceIconButton
            label="Files"
            active={tab === "files"}
            pressed={tab === "files"}
            onClick={() => setTab("files")}
          >
            <FolderIcon size={16} />
          </WorkspaceIconButton>
          <WorkspaceIconButton
            label="Git changes"
            active={tab === "git"}
            pressed={tab === "git"}
            onClick={() => setTab("git")}
            badge={changeCount}
          >
            <BranchIcon size={16} />
          </WorkspaceIconButton>
          <div style={{ flex: 1 }} />
          {tab === "files" && (
            <>
              <WorkspaceIconButton
                label="Upload files to project root"
                disabled={uploadBusy || !cwd}
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
              >
                <UploadIcon size={15} />
              </WorkspaceIconButton>
              <WorkspaceIconButton
                label="Refresh files"
                onClick={() => setFilesRefreshTick((tick) => tick + 1)}
              >
                <RefreshIcon size={15} />
              </WorkspaceIconButton>
            </>
          )}
          {tab === "git" && (
            <WorkspaceIconButton
              label="Refresh Git status"
              disabled={!cwd}
              onClick={() => void fetchGitStatus()}
            >
              <RefreshIcon size={15} />
            </WorkspaceIconButton>
          )}
          <WorkspaceIconButton
            label={isMobile ? "Close workspace" : "Hide workspace"}
            onClick={onClose}
          >
            <CollapseIcon size={15} />
          </WorkspaceIconButton>
        </div>

        {/* 内容区：两个面板保持挂载，切 tab 仅隐藏，保留展开/滚动状态 */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {!cwd ? (
            <div style={{ padding: "16px 12px", fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
              Select a project to browse files and Git changes.
            </div>
          ) : (
            <>
              <div style={{ display: tab === "files" ? "block" : "none", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
                <FileExplorer
                  ref={fileExplorerRef}
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                  refreshKey={(fileRefreshKey ?? 0) + filesRefreshTick}
                  onAtMention={onAtMention}
                  onAtMentions={onAtMentions}
                  onUploadBusyChange={setUploadBusy}
                />
              </div>
              <div style={{ display: tab === "git" ? "block" : "none", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
                <GitPanel
                  cwd={cwd}
                  status={gitStatus}
                  loading={gitLoading}
                  error={gitError}
                  onOpenFile={onOpenFile}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
