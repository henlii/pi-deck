"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitStatusResponse } from "@/lib/git-types";
import {
  RIGHT_PANEL_WIDTH_DEFAULT,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
} from "@/lib/ui-preferences";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitPanel } from "./GitPanel";
import { TabBar, type Tab } from "./TabBar";
import { useI18n } from "@/lib/i18n";

interface Props {
  /** 桌面：折叠/展开；移动：抽屉显隐。 */
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  cwd: string | null;
  isMobile: boolean;
  mobileReady: boolean;
  /** Tab 行：固定导航 tab（files/git/info）+ 文件预览 tab（可关）。 */
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** 文件 dirty 关闭确认条（仅文件 tab 待确认时出现）。 */
  pendingCloseTabLabel: string | null;
  onSaveAndClose: () => void;
  onDiscardAndClose: () => void;
  onCancelClose: () => void;
  /** 活跃文件 tab 的预览内容（FileViewer）；非文件 tab 活跃时为 null。 */
  fileViewerContent: ReactNode;
  /** 「会话信息」tab 内容（SessionInfoPanel）。 */
  sessionInfoContent: ReactNode;
  /** 外部文件刷新信号（agent_end 等），与本地手动刷新合并。 */
  fileRefreshKey?: number;
  /** 外部 Git 刷新信号；FileViewer 的 gitRefreshKey 同源。 */
  gitRefreshKey?: number;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}

/**
 * 右栏：左聊天固定主区右侧的可关 Tab 面板。
 * 固定导航 tab：Files / Git / 会话信息；文件（含 diff）预览以可关 tab 打开。
 * 桌面可调宽并持久化；移动端为全屏 overlay 抽屉（沿用 workspace-* CSS 机制）。
 */
export function RightPanel({
  open,
  width,
  onWidthChange,
  onClose,
  cwd,
  isMobile,
  mobileReady,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  pendingCloseTabLabel,
  onSaveAndClose,
  onDiscardAndClose,
  onCancelClose,
  fileViewerContent,
  sessionInfoContent,
  fileRefreshKey,
  gitRefreshKey,
  onOpenFile,
  onAtMention,
  onAtMentions,
}: Props) {
  const { t } = useI18n();
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [filesRefreshTick, setFilesRefreshTick] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // 初装右栏关闭：内容区延迟到首次打开再挂载，避免关闭态下的无谓文件/Git 拉取。
  const [everOpened, setEverOpened] = useState(open);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

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
      if (!res.ok) throw new Error(data.error ?? t("workspace_gitStatusLoadFailed", { status: res.status }));
      setGitStatus(data);
      setGitError(null);
    } catch (e) {
      setGitError(e instanceof Error ? e.message : String(e));
      setGitStatus(null);
    } finally {
      setGitLoading(false);
    }
  }, [cwd, t]);

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
    // 手柄在右栏左缘：向左拖增宽、向右拖收窄。
    const viewportMax = Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, window.innerWidth * 0.42));
    const next = Math.min(viewportMax, Math.max(RIGHT_PANEL_WIDTH_MIN, drag.startWidth + (drag.startX - e.clientX)));
    onWidthChange(next);
  }, [onWidthChange]);
  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const changeCount = gitStatus?.isGitRepository ? gitStatus.files.length : 0;
  // Git tab 标签内联变更数（替代原图标角标），保持可发现性。
  const tabsWithGitCount = changeCount > 0
    ? tabs.map((tab) => tab.kind === "git" ? { ...tab, label: `${tab.label} (${changeCount > 99 ? "99+" : changeCount})` } : tab)
    : tabs;

  const isFileTabActive = activeTabId.startsWith("file:");

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
      aria-label={t("panel_ariaLabel")}
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
          onDoubleClick={() => onWidthChange(RIGHT_PANEL_WIDTH_DEFAULT)}
          title={t("workspace_resizeHandle")}
          aria-hidden="true"
        />
      )}

      <div className="workspace-inner" style={{ width, minWidth: width, height: "100%", display: "flex", flexDirection: "column" }}>
        {/* Tab 行：固定导航 tab + 文件预览 tab + 右端面板开关 */}
        <div style={{ display: "flex", alignItems: "stretch", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <TabBar
              tabs={tabsWithGitCount}
              activeTabId={activeTabId}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 6px", flexShrink: 0, background: "var(--bg-panel)" }}>
            {activeTabId === "files" && (
              <>
                <button
                  type="button"
                  onClick={() => fileExplorerRef.current?.openUploadPicker()}
                  disabled={uploadBusy || !cwd}
                  title={t("workspace_upload")}
                  aria-label={t("workspace_upload")}
                  className="sidebar-icon-btn"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="m17 8-5-5-5 5" />
                    <path d="M12 3v12" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setFilesRefreshTick((tick) => tick + 1)}
                  title={t("workspace_refreshFiles")}
                  aria-label={t("workspace_refreshFiles")}
                  className="sidebar-icon-btn"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
              </>
            )}
            {activeTabId === "git" && (
              <button
                type="button"
                onClick={() => void fetchGitStatus()}
                disabled={!cwd}
                title={t("workspace_refreshGitStatus")}
                aria-label={t("workspace_refreshGitStatus")}
                className="sidebar-icon-btn"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title={t("workspace_close")}
              aria-label={t("workspace_close")}
              className="sidebar-icon-btn"
            >
              {isMobile ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="13 5 20 12 13 19" />
                  <polyline points="5 5 12 12 5 19" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* 文件 dirty 关闭确认条：保存并关闭 / 放弃更改 / 取消 */}
        {pendingCloseTabLabel !== null && (
          <div className="file-close-confirm" role="alert">
            <span className="file-close-confirm__message">{t("app_unsavedChangesIn", { name: pendingCloseTabLabel })}</span>
            <button type="button" className="file-close-confirm__button" onClick={onSaveAndClose} title={t("app_saveAndClose")} aria-label={t("app_saveAndClose")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              <span>{t("app_saveAndClose")}</span>
            </button>
            <button type="button" className="file-close-confirm__button is-danger" onClick={onDiscardAndClose} title={t("app_discardChanges")} aria-label={t("app_discardChanges")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="m19 6-1 14H6L5 6m3 0V4h8v2"/></svg>
              <span>{t("app_discardChanges")}</span>
            </button>
            <button type="button" className="file-close-confirm__button" onClick={onCancelClose} title={t("app_cancelClosing")} aria-label={t("app_cancelClosing")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              <span>{t("common_cancel")}</span>
            </button>
          </div>
        )}

        {/* 内容区：files/git 两面板保持挂载（切 tab 仅隐藏，保留展开/滚动状态）；
            文件预览与会话信息按活跃 tab 单实例渲染。 */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative", background: isFileTabActive ? "var(--bg)" : "var(--bg-panel)" }}>
          {!everOpened ? null : !cwd ? (
            <div style={{ padding: "16px 12px", fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
              {t("workspace_selectProject")}
            </div>
          ) : (
            <>
              <div style={{ display: activeTabId === "files" ? "block" : "none", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
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
              <div style={{ display: activeTabId === "git" ? "block" : "none", height: "100%", overflowY: "auto", overflowX: "hidden" }}>
                <GitPanel
                  cwd={cwd}
                  status={gitStatus}
                  loading={gitLoading}
                  error={gitError}
                  onOpenFile={onOpenFile}
                />
              </div>
              {activeTabId === "info" && (
                <div style={{ height: "100%", overflow: "hidden" }}>
                  {sessionInfoContent}
                </div>
              )}
              {isFileTabActive && fileViewerContent}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
