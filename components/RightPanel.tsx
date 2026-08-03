"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitStatusResponse } from "@/lib/git-types";
import { RIGHT_PANEL_WIDTH_DEFAULT, RIGHT_PANEL_WIDTH_MAX, RIGHT_PANEL_WIDTH_MIN } from "@/lib/ui-preferences";
import { useI18n } from "@/lib/i18n";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitPanel } from "./GitPanel";
import { TabBar, type Tab } from "./TabBar";

interface Props {
  /** 桌面控制内容面板显隐；移动端控制整组抽屉显隐。 */
  open: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  cwd: string | null;
  isMobile: boolean;
  mobileReady: boolean;
  /** 图标导航（branch/info/files/git）+ 文件预览 tab（可关）。 */
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  pendingCloseTabLabel: string | null;
  onSaveAndClose: () => void;
  onDiscardAndClose: () => void;
  onCancelClose: () => void;
  fileViewerContent: ReactNode;
  sessionInfoContent: ReactNode;
  branchContent: ReactNode;
  fileRefreshKey?: number;
  gitRefreshKey?: number;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}

function NavigationIcon({ kind }: { kind: Tab["kind"] }) {
  const props = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "info") return <svg {...props}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
  if (kind === "files") return <svg {...props}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>;
  if (kind === "git") return <svg {...props}><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h3a3 3 0 0 1 3 3v6"/><path d="M6 8v8"/></svg>;
  return <svg {...props}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>;
}

const NAVIGATION_RAIL_WIDTH = 44;

/** OpenChamber 式右栏：内容面板在左，固定图标轨道常驻窗口最右缘。 */
export function RightPanel({ open, width, onWidthChange, onClose, cwd, isMobile, mobileReady, tabs, activeTabId, onSelectTab, onCloseTab, pendingCloseTabLabel, onSaveAndClose, onDiscardAndClose, onCancelClose, fileViewerContent, sessionInfoContent, branchContent, fileRefreshKey, gitRefreshKey, onOpenFile, onAtMention, onAtMentions }: Props) {
  const { t } = useI18n();
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [filesRefreshTick, setFilesRefreshTick] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [everOpened, setEverOpened] = useState(open);
  useEffect(() => { if (open) setEverOpened(true); }, [open]);

  const fetchGitStatus = useCallback(async () => {
    if (!cwd) { setGitStatus(null); setGitError(null); return; }
    setGitLoading(true);
    try {
      const res = await fetch(`/api/git/status?${new URLSearchParams({ cwd }).toString()}`);
      const data = await res.json().catch(() => ({})) as GitStatusResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("workspace_gitStatusLoadFailed", { status: res.status }));
      setGitStatus(data); setGitError(null);
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error)); setGitStatus(null);
    } finally { setGitLoading(false); }
  }, [cwd, t]);

  useEffect(() => { if (open) void fetchGitStatus(); }, [open, fetchGitStatus, gitRefreshKey]);
  const previousUploadBusy = useRef(false);
  useEffect(() => {
    const wasBusy = previousUploadBusy.current;
    previousUploadBusy.current = uploadBusy;
    if (wasBusy && !uploadBusy) void fetchGitStatus();
  }, [uploadBusy, fetchGitStatus]);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [isMobile, width]);
  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const viewportMax = Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, window.innerWidth * 0.42));
    onWidthChange(Math.min(viewportMax, Math.max(RIGHT_PANEL_WIDTH_MIN, drag.startWidth + drag.startX - event.clientX)));
  }, [onWidthChange]);
  const handleResizeEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const isFileTabActive = activeTabId.startsWith("file:");
  const navigationTabs = tabs.filter((tab) => tab.kind && tab.kind !== "file" && tab.kind !== "chat");
  const fileTabs = tabs.filter((tab) => !tab.kind || tab.kind === "file");
  const activeNavigationId = isFileTabActive ? "files" : activeTabId;
  const contentTitle = fileTabs.find((tab) => tab.id === activeTabId)?.label ?? navigationTabs.find((tab) => tab.id === activeNavigationId)?.label ?? t("panel_ariaLabel");
  const changeCount = gitStatus?.isGitRepository ? gitStatus.files.length : 0;
  const desktopTotalWidth = NAVIGATION_RAIL_WIDTH + (open ? width : 0);
  const contentWidth = isMobile ? `calc(100% - ${NAVIGATION_RAIL_WIDTH}px)` : open ? width : 0;

  return (
    <div className={`workspace-container${open ? " workspace-open" : " workspace-closed"}${dragging ? " workspace-dragging" : ""}${mobileReady ? "" : " workspace-mobile-pending"}`} style={{ width: desktopTotalWidth, minWidth: desktopTotalWidth, display: "flex", borderLeft: open ? "1px solid var(--border)" : "none", background: "var(--bg-panel)", position: "relative", flexShrink: 0, zIndex: 200 }} role="complementary" aria-label={t("panel_ariaLabel")} onKeyDownCapture={(event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      {open && <div className={`workspace-resize-handle${dragging ? " dragging" : ""}`} onPointerDown={handleResizeStart} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} onDoubleClick={() => onWidthChange(RIGHT_PANEL_WIDTH_DEFAULT)} title={t("workspace_resizeHandle")} aria-hidden="true" />}
      <div className="workspace-inner" style={{ width: desktopTotalWidth, minWidth: desktopTotalWidth, height: "100%", display: "flex" }}>
        <div aria-hidden={!open} inert={!open} style={{ width: contentWidth, minWidth: contentWidth, overflow: "hidden", height: "100%", display: "flex", flexDirection: "column", opacity: open ? 1 : 0, transition: dragging ? "none" : "width 0.2s ease, min-width 0.2s ease, opacity 0.12s ease" }}>
          <div style={{ height: 40, display: "flex", alignItems: "center", gap: 4, padding: "0 8px 0 12px", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
            <strong title={contentTitle} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5, fontWeight: 650 }}>{contentTitle}</strong>
            {activeTabId === "files" && <><button type="button" onClick={() => fileExplorerRef.current?.openUploadPicker()} disabled={uploadBusy || !cwd} title={t("workspace_upload")} aria-label={t("workspace_upload")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg></button><button type="button" onClick={() => setFilesRefreshTick((tick) => tick + 1)} title={t("workspace_refreshFiles")} aria-label={t("workspace_refreshFiles")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button></>}
            {activeTabId === "git" && <button type="button" onClick={() => void fetchGitStatus()} disabled={!cwd} title={t("workspace_refreshGitStatus")} aria-label={t("workspace_refreshGitStatus")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>}
            <button type="button" onClick={onClose} title={t("workspace_close")} aria-label={t("workspace_close")} className="sidebar-icon-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          {fileTabs.length > 0 && <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", overflow: "hidden" }}><TabBar tabs={fileTabs} activeTabId={activeTabId} onSelectTab={onSelectTab} onCloseTab={onCloseTab}/></div>}
          {pendingCloseTabLabel !== null && <div className="file-close-confirm" role="alert"><span className="file-close-confirm__message">{t("app_unsavedChangesIn", { name: pendingCloseTabLabel })}</span><button type="button" className="file-close-confirm__button" onClick={onSaveAndClose}>{t("app_saveAndClose")}</button><button type="button" className="file-close-confirm__button is-danger" onClick={onDiscardAndClose}>{t("app_discardChanges")}</button><button type="button" className="file-close-confirm__button" onClick={onCancelClose}>{t("common_cancel")}</button></div>}
          <div style={{ flex: 1, overflow: "hidden", position: "relative", background: isFileTabActive ? "var(--bg)" : "var(--bg-panel)" }}>
            {!everOpened ? null : !cwd ? <div style={{ padding: "16px 12px", fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>{t("workspace_selectProject")}</div> : <>
              <div style={{ display: activeTabId === "files" ? "block" : "none", height: "100%", overflowY: "auto", overflowX: "hidden" }}><FileExplorer ref={fileExplorerRef} cwd={cwd} onOpenFile={onOpenFile} refreshKey={(fileRefreshKey ?? 0) + filesRefreshTick} onAtMention={onAtMention} onAtMentions={onAtMentions} onUploadBusyChange={setUploadBusy}/></div>
              <div style={{ display: activeTabId === "git" ? "block" : "none", height: "100%", overflowY: "auto", overflowX: "hidden" }}><GitPanel cwd={cwd} status={gitStatus} loading={gitLoading} error={gitError} onOpenFile={onOpenFile}/></div>
              {activeTabId === "branch" && <div style={{ height: "100%", overflow: "hidden" }}>{branchContent}</div>}
              {activeTabId === "info" && <div style={{ height: "100%", overflow: "hidden" }}>{sessionInfoContent}</div>}
              {isFileTabActive && fileViewerContent}
            </>}
          </div>
        </div>
        <nav aria-label={t("panel_ariaLabel")} style={{ width: NAVIGATION_RAIL_WIDTH, flex: `0 0 ${NAVIGATION_RAIL_WIDTH}px`, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 0", borderLeft: "1px solid var(--border)", background: "var(--bg)" }}>
          {navigationTabs.map((tab) => {
            const active = open && tab.id === activeNavigationId;
            const label = tab.kind === "git" && changeCount > 0 ? `${tab.label} (${changeCount > 99 ? "99+" : changeCount})` : tab.label;
            return <button key={tab.id} type="button" className="sidebar-icon-btn" aria-label={label} title={label} aria-pressed={active} onClick={() => onSelectTab(tab.id)} style={{ width: 34, height: 34, color: active ? "var(--accent)" : "var(--text-muted)", background: active ? "var(--bg-selected)" : "transparent", border: active ? "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))" : "1px solid transparent", position: "relative" }}><NavigationIcon kind={tab.kind}/>{tab.kind === "git" && changeCount > 0 && <span aria-hidden="true" style={{ position: "absolute", right: 3, top: 3, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 2px var(--bg)" }}/>}</button>;
          })}
        </nav>
      </div>
    </div>
  );
}
