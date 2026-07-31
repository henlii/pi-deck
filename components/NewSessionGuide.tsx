"use client";

/**
 * 新会话引导页（OpenChamber 风格）：空会话时展示项目与工作树选择。
 * - 项目列表：由 /api/sessions 聚合最近 cwd（去重、取最近 8 个）
 * - 选择项目后展示该项目的 git 工作树（含主工作树；/api/worktrees）
 * - 点击项目或工作树 → 在该目录创建新会话
 */
import { useCallback, useEffect, useState } from "react";
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
					.slice(0, 8);
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

	const loadWorktrees = useCallback(async (cwd: string) => {
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
			setWorktrees(data.worktrees ?? []);
		} catch {
			setWorktrees([]);
		} finally {
			setLoadingWorktrees(false);
		}
	}, []);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
			{/* ── 项目选择 ── */}
			<div>
				<div
					style={{
						fontSize: 12,
						fontWeight: 600,
						color: "var(--text)",
						marginBottom: 8,
					}}
				>
					{t("guide_projectTitle")}
				</div>
				{loadingProjects ? (
					<div style={{ fontSize: 12, color: "var(--text-dim)" }}>
						{t("guide_loading")}
					</div>
				) : projects.length === 0 ? (
					<div
						style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}
					>
						{t("guide_noProjects")}
					</div>
				) : (
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
							gap: 8,
						}}
					>
						{projects.map((project) => {
							const selected = selectedCwd === project.cwd;
							return (
								<button
									key={project.cwd}
									type="button"
									onClick={() => void loadWorktrees(project.cwd)}
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "flex-start",
										gap: 4,
										padding: "10px 12px",
										borderRadius: 9,
										border: selected
											? "1px solid var(--accent)"
											: "1px solid var(--border)",
										background: selected
											? "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))"
											: "var(--bg-panel)",
										color: "var(--text)",
										cursor: "pointer",
										textAlign: "left",
										minWidth: 0,
									}}
								>
									<span
										style={{
											fontSize: 12.5,
											fontWeight: 600,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											maxWidth: "100%",
										}}
									>
										{project.cwd}
									</span>
									<span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
										{t("guide_sessionCount", { count: project.count })}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* ── 工作树选择 ── */}
			{selectedCwd && (
				<div>
					<div
						style={{
							fontSize: 12,
							fontWeight: 600,
							color: "var(--text)",
							marginBottom: 8,
						}}
					>
						{t("guide_worktreeTitle")}
						<span
							style={{
								marginLeft: 6,
								fontFamily: "var(--font-mono)",
								fontSize: 10.5,
								color: "var(--text-dim)",
								fontWeight: 400,
							}}
						>
							{selectedCwd}
						</span>
					</div>
					{loadingWorktrees ? (
						<div style={{ fontSize: 12, color: "var(--text-dim)" }}>
							{t("guide_loading")}
						</div>
					) : worktrees === null ? (
						<div style={{ fontSize: 12, color: "var(--text-dim)" }}>
							{t("guide_worktreeUnavailable")}
						</div>
					) : worktrees.length === 0 ? (
						<div
							style={{
								fontSize: 12,
								color: "var(--text-dim)",
								lineHeight: 1.6,
							}}
						>
							{t("guide_noWorktrees")}
						</div>
					) : (
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
								gap: 8,
							}}
						>
							{worktrees.map((wt) => (
								<button
									key={wt.path}
									type="button"
									onClick={() => onPick(wt.path)}
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "flex-start",
										gap: 4,
										padding: "10px 12px",
										borderRadius: 9,
										border: "1px solid var(--border)",
										background: "var(--bg-panel)",
										color: "var(--text)",
										cursor: "pointer",
										textAlign: "left",
										minWidth: 0,
									}}
								>
									<span
										style={{
											fontSize: 12.5,
											fontWeight: 600,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											maxWidth: "100%",
										}}
									>
										{wt.isMain
											? t("guide_mainWorktree")
											: (wt.branch ?? t("guide_worktree"))}
									</span>
									<span
										style={{
											fontSize: 10.5,
											color: "var(--text-dim)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											maxWidth: "100%",
										}}
									>
										{wt.path}
									</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
