"use client";

/**
 * 新会话引导选择器（OpenChamber draft-target-selectors 语义）：
 * 空态时在输入框上方提供 项目 + 分支 两个紧凑下拉。
 * - 只选择"目标目录"，不创建会话、不跳转（OpenChamber setNewSessionDraftTarget 语义）
 * - 发送第一条消息时新会话才在目标目录创建（Pidance 懒创建）
 * - 选择持久化到 localStorage（ChatWindow 管理），回到空态自动恢复
 * - 项目下拉：/api/sessions 聚合最近 cwd（去重、按最近使用排序）
 * - 分支下拉：选定项目后加载其 git 工作树（主工作树分组 + 工作树分组；/api/worktrees）
 * - 非 git 项目：无分支选择器，选项目即设为目标（OpenChamber 语义）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, GitBranch, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type WorktreeInfo = { path: string; branch?: string; isMain?: boolean };

type Props = {
  /** 当前新会话目标目录（项目根或工作树路径）；null = 未选择 */
  targetCwd: string | null;
  /** 选择目标（OpenChamber setNewSessionDraftTarget：仅记录，不创建/不跳转） */
  onTargetChange: (cwd: string | null) => void;
};

export function NewSessionGuide({ targetCwd, onTargetChange }: Props) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<
    Array<{ cwd: string; count: number; latest: number }>
  >([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  /** 项目级选择（驱动分支加载） */
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
        if (!cancelled) {
          setProjects(sorted);
          // 恢复持久化目标：targetCwd 匹配项目根 → 自动选中该项目并加载分支。
          // （工作树路径用最长项目前缀匹配其归属项目。）
          if (targetCwd) {
            const exact = sorted.find((p) => p.cwd === targetCwd);
            if (exact) {
              setSelectedCwd(exact.cwd);
              void loadWorktreesRef.current(exact.cwd);
            } else {
              const parent = sorted
                .filter((p) => targetCwd.startsWith(p.cwd + "/"))
                .sort((a, b) => b.cwd.length - a.cwd.length)[0];
              if (parent) {
                setSelectedCwd(parent.cwd);
                void loadWorktreesRef.current(parent.cwd);
              }
            }
          }
        }
      } catch {
        // 拉取失败：引导页保持空列表
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅 mount 时执行（targetCwd 的后续变化由分支选择链路处理）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      } catch {
        setWorktrees([]);
      } finally {
        setLoadingWorktrees(false);
      }
    },
    [],
  );
  const loadWorktreesRef = useRef(loadWorktrees);
  loadWorktreesRef.current = loadWorktrees;

  const main = worktrees?.find((w) => w.isMain) ?? null;
  const branches = worktrees?.filter((w) => !w.isMain) ?? [];
  const isGit = worktrees !== null && worktrees.length > 0;

  // 分支下拉受控值：targetCwd 在工作树列表内则显示它，否则占位。
  const branchValue =
    targetCwd && worktrees?.some((w) => w.path === targetCwd) ? targetCwd : "";

  // ── 新建工作树（OpenChamber createInstantWorktreeDraft 语义）──
  const [showWorktreeForm, setShowWorktreeForm] = useState(false);
  const [worktreeName, setWorktreeName] = useState("");
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const worktreeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showWorktreeForm) worktreeInputRef.current?.focus();
  }, [showWorktreeForm]);

  const createWorktree = useCallback(async () => {
    const branch = worktreeName.trim();
    if (!branch || !selectedCwd || creatingWorktree) return;
    setCreatingWorktree(true);
    setWorktreeError(null);
    try {
      // pending 期间分支下拉保持禁用（OpenChamber pendingWorktreeRequestId 锁定）
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: selectedCwd, branch }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) {
        setWorktreeError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      // 创建成功：目标直接指向新工作树（bootstrapPendingDirectory 语义），
      // 并刷新分支列表让新条目出现。
      onTargetChange(data.path);
      setShowWorktreeForm(false);
      setWorktreeName("");
      await loadWorktrees(selectedCwd);
    } catch (e) {
      setWorktreeError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingWorktree(false);
    }
  }, [worktreeName, selectedCwd, creatingWorktree, onTargetChange, loadWorktrees]);
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
            if (cwd) {
              // OpenChamber handleDraftProjectChange：选项目即把目标重置为项目根，
              // 清除旧的分支目标（随后可选分支覆盖）。
              onTargetChange(cwd);
              void loadWorktrees(cwd);
            }
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
            value={branchValue}
            disabled={!selectedCwd || loadingWorktrees || worktrees === null}
            onChange={(e) => {
              const path = e.target.value;
              if (path) onTargetChange(path);
            }}
            aria-label={t("guide_worktreeTitle")}
          >
            <option value="" disabled>
              {t("guide_branchPlaceholder")}
            </option>
            {main && (
              <optgroup label={t("guide_mainWorktree")}>
                <option value={main.path}>{main.branch ?? main.path}</option>
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
          {/* 新建工作树入口（OpenChamber worktreeNew：仅 git 项目可用） */}
          {!creatingWorktree && !showWorktreeForm && (
            <button
              type="button"
              className="guide-new-worktree-btn"
              title={t("guide_newWorktree")}
              aria-label={t("guide_newWorktree")}
              disabled={!selectedCwd || loadingWorktrees}
              onClick={() => {
                setWorktreeError(null);
                setShowWorktreeForm(true);
              }}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
      )}

      {/* 新建工作树表单（创建中锁定分支下拉，OpenChamber pending 语义） */}
      {isGit && showWorktreeForm && (
        <div className="guide-worktree-form">
          <input
            ref={worktreeInputRef}
            className="guide-worktree-input"
            value={worktreeName}
            placeholder={t("guide_newWorktreePlaceholder")}
            disabled={creatingWorktree}
            onChange={(e) => setWorktreeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void createWorktree();
              if (e.key === "Escape") {
                setShowWorktreeForm(false);
                setWorktreeName("");
                setWorktreeError(null);
              }
            }}
          />
          <button
            type="button"
            className="extension-card-btn"
            disabled={creatingWorktree || !worktreeName.trim()}
            onClick={() => void createWorktree()}
          >
            {creatingWorktree ? t("guide_creatingWorktree") : t("guide_createWorktree")}
          </button>
          <button
            type="button"
            className="extension-card-btn"
            disabled={creatingWorktree}
            onClick={() => {
              setShowWorktreeForm(false);
              setWorktreeName("");
              setWorktreeError(null);
            }}
          >
            {t("extension_cancel")}
          </button>
          {worktreeError && (
            <span className="guide-worktree-error">{worktreeError}</span>
          )}
        </div>
      )}
    </div>
  );
}
