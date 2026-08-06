"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { affectedPathsInRepository, affectedPathsMatchFile } from "@/lib/git-refresh";
import type { GitFileDiffResponse, GitStatusResponse } from "@/lib/git-types";
import { useI18n } from "@/lib/i18n";
import { GitDiffView } from "./FileViewer";
import { GitPanel } from "./GitPanel";

interface Props {
  cwd: string | null;
  gitRefreshKey?: number;
  gitAffectedPaths?: string[] | null;
}

/** 独立 Git 变更工作区：上半部复用 GitPanel 列表，下半部复用 FileViewer diff 渲染。 */
export function ChangesPanel({ cwd, gitRefreshKey, gitAffectedPaths }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const statusRequestRef = useRef(0);
  const diffRequestRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current;
    if (!cwd) {
      setStatus(null);
      setStatusError(null);
      return;
    }
    setStatusLoading(true);
    try {
      const response = await fetch(`/api/git/status?${new URLSearchParams({ cwd }).toString()}`);
      const next = await response.json().catch(() => ({})) as GitStatusResponse & { error?: string };
      if (!response.ok) throw new Error(next.error ?? t("changes_statusError", { status: response.status }));
      if (requestId !== statusRequestRef.current) return;
      setStatus(next);
      setStatusError(null);
      setSelectedPath((current) => current && next.files.some((file) => file.filePath === current) ? current : next.files[0]?.filePath ?? null);
    } catch (error) {
      if (requestId !== statusRequestRef.current) return;
      setStatus(null);
      setSelectedPath(null);
      setDiff(null);
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === statusRequestRef.current) setStatusLoading(false);
    }
  }, [cwd, t]);

  const fetchDiff = useCallback(async (filePath: string) => {
    const requestId = ++diffRequestRef.current;
    if (!cwd) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const response = await fetch(`/api/git/diff?${new URLSearchParams({ cwd, path: filePath }).toString()}`);
      const next = await response.json().catch(() => ({})) as GitFileDiffResponse & { error?: string };
      if (!response.ok) throw new Error(next.error ?? t("changes_diffError", { status: response.status }));
      if (requestId !== diffRequestRef.current) return;
      setDiff(next.supported && typeof next.patch === "string" ? next : null);
    } catch (error) {
      if (requestId !== diffRequestRef.current) return;
      setDiff(null);
      setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === diffRequestRef.current) setDiffLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    setSelectedPath(null);
    setDiff(null);
    void fetchStatus();
  }, [fetchStatus, gitRefreshKey]);

  useEffect(() => {
    if (selectedPath) void fetchDiff(selectedPath);
    else setDiff(null);
  }, [fetchDiff, selectedPath]);

  useEffect(() => {
    if (!gitAffectedPaths || !status?.repositoryRoot || !affectedPathsInRepository(gitAffectedPaths, status.repositoryRoot)) return;
    void fetchStatus();
    if (selectedPath && affectedPathsMatchFile(gitAffectedPaths, selectedPath)) void fetchDiff(selectedPath);
  }, [fetchDiff, fetchStatus, gitAffectedPaths, selectedPath, status?.repositoryRoot]);

  return (
    <div className="changes-panel-content">
      <div className="changes-panel-list">
        <GitPanel cwd={cwd ?? ""} status={status} loading={statusLoading} error={statusError} selectedFilePath={selectedPath} onOpenFile={(filePath) => setSelectedPath(filePath)} />
      </div>
      <div className="changes-panel-diff" aria-live="polite">
        {!selectedPath ? (
          <div className="changes-panel-hint">{t("changes_selectFile")}</div>
        ) : diffLoading ? (
          <div className="changes-panel-hint">{t("changes_diffLoading")}</div>
        ) : diffError ? (
          <div className="changes-panel-hint is-error">{diffError}</div>
        ) : diff?.patch ? (
          <GitDiffView patch={diff.patch} />
        ) : (
          <div className="changes-panel-hint">{t("changes_diffUnavailable")}</div>
        )}
      </div>
    </div>
  );
}
