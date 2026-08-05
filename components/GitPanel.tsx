"use client";

import { useMemo } from "react";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/locales/en";
import { GIT_STATUS_COLORS, GIT_STATUS_LABELS } from "./FileExplorer";

interface Props {
  cwd: string;
  status: GitStatusResponse | null;
  loading: boolean;
  error: string | null;
  onOpenFile: (filePath: string, fileName: string) => void;
}

/** 展示排序：冲突优先，其次修改/新增/删除/重命名，未跟踪垫底。 */
const STATUS_RANK: Record<GitFileStatusKind, number> = {
  conflict: 0,
  modified: 1,
  added: 2,
  deleted: 3,
  renamed: 4,
  untracked: 5,
};

/**
 * 只读 Git 工作区变更面板：复用 /api/git/status 数据（由 RightPanel 抓取），
 * 点击文件行打开现有文件预览（FileViewer 自带 Diff 模式），不提供 stage/commit。
 */
export function GitPanel({ cwd, status, loading, error, onOpenFile }: Props) {
  const { t } = useI18n();
  const sortedFiles = useMemo(() => {
    if (!status) return [];
    return [...status.files].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      return rank !== 0 ? rank : a.filePath.localeCompare(b.filePath);
    });
  }, [status]);

  if (loading && !status) {
    return <PanelHint>{t("git_loading")}</PanelHint>;
  }
  if (error) {
    return <PanelHint tone="error">{error}</PanelHint>;
  }
  if (!status || !status.isGitRepository) {
    return <PanelHint>{t("git_notRepo")}</PanelHint>;
  }
  if (sortedFiles.length === 0) {
    return (
      <div style={{ padding: "18px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, color: "var(--text-dim)" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--status-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span style={{ fontSize: 12 }}>{t("git_clean")}</span>
      </div>
    );
  }

  return (
    <div style={{ padding: "4px 0" }}>
      {/* 摘要行：变更数 + 仓库根（只读信息） */}
      <div
        style={{ padding: "4px 10px 6px", fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}
        title={status.repositoryRoot ?? cwd}
      >
        {t(sortedFiles.length === 1 ? "git_changesCount_one" : "git_changesCount", { count: sortedFiles.length })} · {status.repositoryRoot ?? cwd}
      </div>
      {sortedFiles.map((file) => (
        <GitFileRow key={file.filePath} file={file} cwd={cwd} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function GitFileRow({ file, cwd, onOpenFile }: {
  file: GitFileStatus;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
}) {
  const { t } = useI18n();
  const name = getFileName(file.filePath) || file.filePath;
  const relative = getRelativeFilePath(file.filePath, cwd);
  const statusLabel = t(GIT_STATUS_LABELS[file.status] as TranslationKey);
  return (
    <button
      type="button"
      className="git-file-row"
      onClick={() => onOpenFile(file.filePath, name)}
      title={`${file.filePath} — ${statusLabel}`}
      aria-label={t("git_openFile" as TranslationKey, { path: relative, status: statusLabel })}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          flexShrink: 0,
          color: GIT_STATUS_COLORS[file.status],
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 700,
          textAlign: "center",
        }}
      >
        {file.code}
      </span>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
        {getFileIcon(name, 13)}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {relative}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
        {statusLabel}
      </span>
    </button>
  );
}

function PanelHint({ children, tone = "dim" }: { children: React.ReactNode; tone?: "dim" | "error" }) {
  return (
    <div style={{ padding: "14px 12px", fontSize: 11.5, lineHeight: 1.5, color: tone === "error" ? "var(--status-danger)" : "var(--text-dim)" }}>
      {children}
    </div>
  );
}
