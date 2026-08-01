"use client";

/**
 * 新会话引导（OpenChamber draft-target-selectors 风格）：
 * 输入框上方一行两个紧凑下拉 —— 项目 + 分支（工作树）。
 * - 项目下拉：/api/sessions 聚合最近 cwd（去重、按最近使用排序）
 * - 分支下拉：选定项目后加载其 git 工作树（主工作树分组 + 工作树分组；/api/worktrees）
 * - 选中分支 → onPick(path)（进入该目录新会话）；非 git 项目 → 选项目即进入
 */
import { useCallback, useEffect, useState } from "react";
import { Folder, GitBranch } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type WorktreeInfo = { path: string; branch?: string; isMain?: boolean };

type Props = {
  onPick: (cwd: string) => void;
};

export function NewSessionGuide({ onPick }: Props) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<
    Array<{ cwd: string; count: number; latest: number }>
  >([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [loadingWorktrees, setLoadingWorktrees] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/sessions");
        const data = (await res.json()) as {
          sessions?: Array<{
            cwd?: string;
            created?: string;
            modified?: string;
          }>;
        };
        const byCwd = new Map<string, { count: number; latest: number }>();
        for (const s of data.sessions ?? []) {
          if (!s.cwd) continue;
          const ts = s.modified
            ? Date.parse(s.modified)
            : s.created
              ? Date.parse(s.created)
              : 0;
          const entry = byCwd.get(s.cwd) ?? { count: 0, latest: 0 };
          entry.count += 1;
          if (ts > entry.latest) entry.latest = ts;
          byCwd.set(s.cwd, entry);
        }
        const sorted = [...byCwd.entries()]
          .map(([cwd, v]) => ({ cwd, count: v.count, latest: v.latest }))
          .sort((a, b) => b.latest - a.latest)
          .slice(0, 12);
        if (!cancelled) setProjects(sorted);
      } catch {
        // 拉取失败：引导页保持空列表
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadWorktrees = useCallback(
    async (cwd: string) => {
      setSelectedCwd(cwd);
      setLoadingWorktrees(true);
      setWorktrees(null);
      try {
        const params = new URLSearchParams({ cwd });
        const res = await fetch(`/api/worktrees?${params.toString()}`);
        const data = (await res.json()) as {
          worktrees?: WorktreeInfo[];
          isGit?: boolean;
        };
        const wts = data.worktrees ?? [];
        setWorktrees(wts);
        // OpenChamber 语义：非 git 项目没有分支选择器，选项目即进入该目录。
        if (wts.length === 0 && !data.isGit) {
          onPick(cwd);
        }
      } catch {
        setWorktrees([]);
        onPick(cwd);
      } finally {
        setLoadingWorktrees(false);
      }
    },
    [onPick],
  );

  const main = worktrees?.find((w) => w.isMain) ?? null;
  const branches = worktrees?.filter((w) => !w.isMain) ?? [];
  const isGit = worktrees !== null && worktrees.length > 0;

  return (
    <div className="guide-selectors">
      {/* ── 项目下拉 ── */}
      <div className="guide-selector">
        <Folder size={12} className="guide-selector-icon" aria-hidden />
        <select
          className="guide-select"
          value={selectedCwd ?? ""}
          disabled={loadingProjects || projects.length === 0}
          onChange={(e) => {
            const cwd = e.target.value;
            if (cwd) void loadWorktrees(cwd);
          }}
          aria-label={t("guide_projectTitle")}
        >
          <option value="" disabled>
            {loadingProjects
              ? t("guide_loading")
              : projects.length === 0
                ? t("guide_noProjects")
                : t("guide_projectPlaceholder")}
          </option>
          {projects.map((project) => (
            <option key={project.cwd} value={project.cwd}>
              {project.cwd}
            </option>
          ))}
        </select>
      </div>

      {/* ── 分支下拉（非 git 项目隐藏，OpenChamber 语义）── */}
      {isGit && (
        <div className="guide-selector">
          <GitBranch size={12} className="guide-selector-icon" aria-hidden />
          <select
            className="guide-select"
            value=""
            disabled={!selectedCwd || loadingWorktrees || worktrees === null}
            onChange={(e) => {
              const path = e.target.value;
              if (path) onPick(path);
            }}
            aria-label={t("guide_worktreeTitle")}
          >
            <option value="" disabled>
              {t("guide_branchPlaceholder")}
            </option>
            {main && (
              <optgroup label={t("guide_mainWorktree")}>
                <option value={main.path}>
                  {main.branch ?? main.path}
                </option>
              </optgroup>
            )}
            {branches.length > 0 && (
              <optgroup label={t("guide_worktree")}>
                {branches.map((wt) => (
                  <option key={wt.path} value={wt.path}>
                    {wt.branch ?? wt.path} · {wt.path}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      )}
    </div>
  );
}
