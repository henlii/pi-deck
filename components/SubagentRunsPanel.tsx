"use client";

/**
 * 第三阶段 D1：异步 subagent 运行的用户可见观测面板（只读）。
 * 入口为 TopBar 的 Activity 按钮，渲染在 AppShell 共享 top panel 浮层内。
 *
 * 轮询只存在于面板打开（组件挂载）期间：有 queued/running 时 2s，空闲 8s；
 * document.hidden 时不排程，visibility 恢复立即拉取；
 * AbortController + 单调序号防止旧响应覆盖新响应；unmount 时 abort。
 *
 * 只读约束：不提供 stop / steer / resume / repair 任何控制入口；
 * 「打开会话」仅调用 AppShell 的只读子会话解析（映射失败由调用方静默处理）。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/locales/en";
import { getFileName } from "@/lib/file-paths";
import type {
  SubagentRunMode,
  SubagentRunState,
  SubagentRunStepView,
  SubagentRunView,
  SubagentRunsResponse,
} from "@/lib/subagent-run-types";

/* ------------------------------------------------------------------ */
/* 纯逻辑（导出供单元测试）                                             */
/* ------------------------------------------------------------------ */

/** 活跃（排队/运行中）run 判定：驱动轮询频率、badge 计数与默认展开。 */
export function isActiveSubagentRun(run: Pick<SubagentRunView, "state">): boolean {
  return run.state === "queued" || run.state === "running";
}

/** 活动 run 计数（TopBar badge 与面板摘要共用）。 */
export function countActiveSubagentRuns(runs: ReadonlyArray<Pick<SubagentRunView, "state">>): number {
  let count = 0;
  for (const run of runs) if (isActiveSubagentRun(run)) count += 1;
  return count;
}

/** 轮询间隔：页面隐藏返回 null（不排程，等 visibility 恢复）；活跃 2s，空闲 8s。 */
export function resolveRunPollDelayMs(hasActive: boolean, hidden: boolean): number | null {
  if (hidden) return null;
  return hasActive ? 2000 : 8000;
}

/** 持续时间紧凑格式：59s / 3m 12s / 2h 5m（语言中立，无需 i18n）。 */
export function formatRunDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** run / step 的持续时间（进行中用 now 补齐）；无 startedAt 返回 null。 */
export function runDurationMs(run: { startedAt?: number; endedAt?: number }, now: number): number | null {
  if (typeof run.startedAt !== "number") return null;
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

/** HH:MM:SS 本地时钟时间（更新时间 / 事件时间用，语言中立）。 */
export function formatClockTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** run 卡片标题用的 agent 列表：按 steps 顺序去重。 */
export function runAgentNames(run: Pick<SubagentRunView, "steps">): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const step of run.steps) {
    if (!step.agent || seen.has(step.agent)) continue;
    seen.add(step.agent);
    names.push(step.agent);
  }
  return names;
}

/** step.status 是开放字符串：已知值映射到 i18n 键，未知返回 null（UI 原样显示原文）。 */
export function stepStatusKey(status: string): TranslationKey | null {
  return STEP_STATUS_KEYS[status.trim().toLowerCase()] ?? null;
}

/** step.status 对应的状态点颜色。 */
export function stepStatusColor(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "running":
      return "var(--accent)";
    case "complete":
    case "completed":
    case "ok":
    case "done":
      return "#16a34a";
    case "failed":
    case "error":
      return "#f87171";
    case "paused":
      return "#d97706";
    default:
      return "var(--text-dim)";
  }
}

/* ------------------------------------------------------------------ */
/* 常量映射                                                            */
/* ------------------------------------------------------------------ */

const RUN_STATE_KEYS: Record<SubagentRunState, TranslationKey> = {
  queued: "runs_stateQueued",
  running: "runs_stateRunning",
  complete: "runs_stateComplete",
  failed: "runs_stateFailed",
  paused: "runs_statePaused",
  stopped: "runs_stateStopped",
};

const RUN_STATE_COLORS: Record<SubagentRunState, string> = {
  queued: "var(--text-dim)",
  running: "var(--accent)",
  complete: "#16a34a",
  failed: "#f87171",
  paused: "#d97706",
  stopped: "var(--text-dim)",
};

const STEP_STATUS_KEYS: Record<string, TranslationKey> = {
  queued: "runs_stateQueued",
  pending: "runs_stateQueued",
  running: "runs_stateRunning",
  complete: "runs_stateComplete",
  completed: "runs_stateComplete",
  ok: "runs_stateComplete",
  done: "runs_stateComplete",
  failed: "runs_stateFailed",
  error: "runs_stateFailed",
  paused: "runs_statePaused",
  stopped: "runs_stateStopped",
  skipped: "runs_stateSkipped",
};

const MODE_KEYS: Record<SubagentRunMode, TranslationKey> = {
  single: "runs_modeSingle",
  parallel: "runs_modeParallel",
  chain: "runs_modeChain",
};

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/* ------------------------------------------------------------------ */
/* 主面板                                                              */
/* ------------------------------------------------------------------ */

interface SubagentRunsPanelProps {
  /** 打开步骤关联的只读子会话（按会话文件路径解析，失败由调用方静默）。 */
  onOpenSubagentSession: (sessionFile: string) => void;
  /** 成功拉取后上报活动 run 数，供 TopBar badge 显示。 */
  onActiveCountChange?: (count: number) => void;
}

export function SubagentRunsPanel({ onOpenSubagentSession, onActiveCountChange }: SubagentRunsPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<SubagentRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  // 用户显式展开/收起的覆盖；未覆盖时活动 run 默认展开、终态默认收起。
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let hasActive = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      if (!mounted) return;
      clearTimer();
      const delay = resolveRunPollDelayMs(hasActive, document.hidden);
      if (delay === null) return; // 隐藏时交给 visibilitychange 唤醒
      timer = setTimeout(() => { void run(); }, delay);
    };

    const run = async () => {
      const mySeq = ++seq;
      controller?.abort();
      const ac = new AbortController();
      controller = ac;
      if (mounted) setFetching(true);
      try {
        const res = await fetch("/api/subagent-runs?limit=20", { signal: ac.signal, cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (Partial<SubagentRunsResponse> & { error?: string }) | null;
        if (!mounted || mySeq !== seq) return;
        if (!res.ok || !body || !Array.isArray(body.runs)) {
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const okBody = body as SubagentRunsResponse;
        hasActive = okBody.runs.some(isActiveSubagentRun);
        setData(okBody);
        setError(null);
        setLoading(false);
        onActiveCountChange?.(countActiveSubagentRuns(okBody.runs));
      } catch (err) {
        if (!mounted || mySeq !== seq || ac.signal.aborted) return;
        // 错误时保留上次成功列表，仅记录错误信息。
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      } finally {
        if (mounted && mySeq === seq) {
          setFetching(false);
          schedule();
        }
      }
    };

    refreshRef.current = () => { void run(); };
    const onVisibility = () => { if (!document.hidden) void run(); };

    void run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted = false;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      refreshRef.current = () => {};
    };
  }, [onActiveCountChange]);

  const runs = data?.runs ?? [];
  const activeCount = countActiveSubagentRuns(runs);
  const now = Date.now();

  const toggleRun = (runId: string, defaultExpanded: boolean) => {
    setExpandOverrides((prev) => ({ ...prev, [runId]: !(prev[runId] ?? defaultExpanded) }));
  };

  const placeholder = (content: React.ReactNode, role?: "status" | "alert") => (
    <div role={role} style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-muted)" }}>
      {content}
    </div>
  );

  return (
    <div style={{ fontSize: 12, color: "var(--text)" }}>
      <style>{`
        @keyframes runs-pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .runs-pulse-dot { animation: runs-pulse-dot 1.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .runs-pulse-dot { animation: none; }
        }
      `}</style>

      {/* Header：标题 + 活动/总数摘要 + 更新时间 + 手动刷新 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>{t("runs_title")}</span>
        {data && (
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {t("runs_summary", { active: activeCount, total: runs.length })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {data && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {t("runs_updatedAt", { time: formatClockTime(data.generatedAt) })}
          </span>
        )}
        <button
          type="button"
          onClick={() => refreshRef.current()}
          title={t("runs_refresh")}
          aria-label={t("runs_refresh")}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0,
            background: "none", border: "1px solid var(--border)", borderRadius: 4,
            color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
            transition: "color 0.12s, border-color 0.12s, background 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--accent)";
            e.currentTarget.style.borderColor = "var(--accent)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-muted)";
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.background = "none";
          }}
        >
          <RefreshCw size={12} aria-hidden="true" className={fetching ? "animate-spin" : undefined} />
        </button>
      </div>

      {/* 错误条：刷新失败但保留上次成功列表 */}
      {error && data && (
        <div role="alert" style={{
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          padding: "6px 16px", borderBottom: "1px solid var(--border)",
          fontSize: 11, color: "#dc2626",
        }}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{t("runs_loadFailed")}: {error}</span>
          <button
            type="button"
            onClick={() => refreshRef.current()}
            style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", font: "inherit", fontSize: 10.5 }}
          >
            {t("runs_retry")}
          </button>
        </div>
      )}

      {/* 主体：加载 / 错误（无数据）/ 空根 / 空列表 / run 列表 */}
      {loading && !data ? (
        placeholder(
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <RefreshCw size={12} aria-hidden="true" className="animate-spin" />
            {t("runs_loading")}
          </span>,
          "status",
        )
      ) : error && !data ? (
        placeholder(
          <span style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
            <span style={{ color: "#dc2626" }}>{t("runs_loadFailed")}</span>
            <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{error}</span>
            <button
              type="button"
              onClick={() => refreshRef.current()}
              style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", font: "inherit", fontSize: 10.5 }}
            >
              {t("runs_retry")}
            </button>
          </span>,
          "alert",
        )
      ) : data && !data.rootAvailable ? (
        placeholder(<span style={{ fontStyle: "italic" }}>{t("runs_rootUnavailable")}</span>)
      ) : data && runs.length === 0 ? (
        placeholder(<span style={{ fontStyle: "italic" }}>{t("runs_empty")}</span>)
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {runs.map((run) => {
            const defaultExpanded = isActiveSubagentRun(run);
            const expanded = expandOverrides[run.id] ?? defaultExpanded;
            return (
              <RunCard
                key={run.id}
                run={run}
                expanded={expanded}
                now={now}
                onToggle={() => toggleRun(run.id, defaultExpanded)}
                onOpenSubagentSession={onOpenSubagentSession}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* run 卡片                                                            */
/* ------------------------------------------------------------------ */

function RunCard({ run, expanded, now, onToggle, onOpenSubagentSession }: {
  run: SubagentRunView;
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onOpenSubagentSession: (sessionFile: string) => void;
}) {
  const { t } = useI18n();
  const stateColor = RUN_STATE_COLORS[run.state];
  const agents = runAgentNames(run);
  const name = agents.length > 0
    ? agents.join(run.mode === "chain" ? " → " : ", ")
    : run.id.slice(0, 8) || t("common_unknown");
  const duration = runDurationMs(run, now);
  const tokens = run.totalTokens;
  const attention = run.activityState === "needs_attention";
  const longRunning = run.activityState === "active_long_running";
  const showProgress = run.mode === "chain" && run.currentStep !== undefined && run.chainStepCount !== undefined;
  const cwdName = run.cwd ? getFileName(run.cwd) || run.cwd : null;

  return (
    <li style={{ borderBottom: "1px solid var(--border)" }}>
      {/* 摘要头：整行可点展开/收起 */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? t("runs_collapse") : t("runs_expand")}
        style={{
          display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
          width: "100%", padding: "7px 16px 3px",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--text)", font: "inherit", fontSize: 12, textAlign: "left",
        }}
      >
        {expanded
          ? <ChevronDown size={12} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />
          : <ChevronRight size={12} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
        <span
          aria-hidden="true"
          className={run.state === "running" ? "runs-pulse-dot" : undefined}
          style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor, flexShrink: 0 }}
        />
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 600,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          maxWidth: "100%", minWidth: 0,
        }}>
          {name}
        </span>
        <span style={{
          padding: "0 5px", borderRadius: 999,
          border: "1px solid var(--border)", color: "var(--text-dim)",
          fontSize: 9.5, lineHeight: 1.6, textTransform: "uppercase", flexShrink: 0,
        }}>
          {t(MODE_KEYS[run.mode])}
        </span>
        {attention && (
          <span style={{
            padding: "0 5px", borderRadius: 999,
            border: "1px solid #d97706", color: "#d97706",
            fontSize: 9.5, lineHeight: 1.6, textTransform: "uppercase", flexShrink: 0,
          }}>
            {t("runs_needsAttention")}
          </span>
        )}
        {longRunning && !attention && (
          <span style={{
            padding: "0 5px", borderRadius: 999,
            border: "1px solid var(--border)", color: "var(--text-dim)",
            fontSize: 9.5, lineHeight: 1.6, textTransform: "uppercase", flexShrink: 0,
          }}>
            {t("runs_longRunning")}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: stateColor, flexShrink: 0 }}>{t(RUN_STATE_KEYS[run.state])}</span>
        {duration !== null && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {formatRunDurationMs(duration)}
          </span>
        )}
      </button>

      {/* 摘要行：tokens / cost / 链式进度 / cwd（未展开也可见） */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 10px",
        padding: "0 16px 7px 42px",
        color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10,
      }}>
        {tokens && (tokens.input > 0 || tokens.output > 0) && (
          <span>{t("subagent_tokensInOut", { input: formatTokenCount(tokens.input), output: formatTokenCount(tokens.output) })}</span>
        )}
        {run.totalCostUsd !== undefined && run.totalCostUsd > 0 && <span>{formatCost(run.totalCostUsd)}</span>}
        {showProgress && <span>{t("runs_stepProgress", { current: run.currentStep, total: run.chainStepCount })}</span>}
        {run.steps.length > 1 && <span>{t("runs_stepCount", { count: run.steps.length })}</span>}
        {cwdName && (
          <span title={run.cwd} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
            {cwdName}
          </span>
        )}
      </div>

      {expanded && <RunDetails run={run} now={now} onOpenSubagentSession={onOpenSubagentSession} />}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* 展开详情：错误 / 步骤 / 近期事件 / 输出尾部                            */
/* ------------------------------------------------------------------ */

function RunDetails({ run, now, onOpenSubagentSession }: {
  run: SubagentRunView;
  now: number;
  onOpenSubagentSession: (sessionFile: string) => void;
}) {
  const { t } = useI18n();
  const sectionTitle = (label: string, extra?: React.ReactNode) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
      {label}
      {extra}
    </div>
  );

  return (
    <div style={{ padding: "2px 16px 10px 42px", display: "flex", flexDirection: "column", gap: 10 }}>
      {run.error && (
        <div style={{ fontSize: 11, color: "#f87171", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {run.error}
        </div>
      )}

      {run.steps.length > 0 && (
        <section>
          {sectionTitle(t("runs_steps"))}
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {run.steps.map((step, idx) => (
              <StepRow
                key={`${step.index}:${step.agent}`}
                step={step}
                first={idx === 0}
                now={now}
                onOpenSubagentSession={onOpenSubagentSession}
              />
            ))}
          </ul>
        </section>
      )}

      {run.recentEvents.length > 0 && (
        <section>
          {sectionTitle(t("runs_events"))}
          <ul style={{
            margin: 0, padding: 0, listStyle: "none",
            color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.6,
          }}>
            {run.recentEvents.map((event, idx) => (
              <li key={idx} style={{ overflowWrap: "anywhere" }}>
                {event.timestamp !== undefined && <span>{formatClockTime(event.timestamp)} </span>}
                <span style={{ color: "var(--text-muted)" }}>{event.type}</span>
                {event.message && <span> — {event.message}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.outputTail && (
        <section>
          {sectionTitle(
            t("runs_output"),
            run.outputTruncated
              ? <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--text-dim)", fontSize: 10 }}>({t("runs_truncated")})</span>
              : undefined,
          )}
          <pre style={{
            margin: 0, padding: "6px 8px", maxHeight: 180, overflow: "auto",
            borderRadius: 5, background: "var(--bg-subtle)",
            color: "var(--text-muted)", fontFamily: "var(--font-mono)",
            fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
          }}>
            {run.outputTail}
          </pre>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 单步行                                                              */
/* ------------------------------------------------------------------ */

function StepRow({ step, first, now, onOpenSubagentSession }: {
  step: SubagentRunStepView;
  first: boolean;
  now: number;
  onOpenSubagentSession: (sessionFile: string) => void;
}) {
  const { t } = useI18n();
  const color = stepStatusColor(step.status);
  const statusKey = stepStatusKey(step.status);
  const running = step.status.trim().toLowerCase() === "running";
  const attention = step.activityState === "needs_attention";
  const duration = runDurationMs(step, now);
  const recentOutput = step.recentOutput && step.recentOutput.length > 0 ? step.recentOutput.slice(-3) : null;

  return (
    <li style={{ padding: "5px 0", borderTop: first ? "none" : "1px dashed var(--border)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "3px 8px", minWidth: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
          #{step.index}
        </span>
        <span
          aria-hidden="true"
          className={running ? "runs-pulse-dot" : undefined}
          style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }}
        />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
          {step.agent}
        </span>
        {step.label && (
          <span style={{ fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
            {step.label}
          </span>
        )}
        <span style={{
          padding: "0 5px", borderRadius: 999,
          border: `1px solid ${color}`, color,
          fontSize: 9.5, lineHeight: 1.6, textTransform: "uppercase", flexShrink: 0,
        }}>
          {statusKey ? t(statusKey) : step.status}
        </span>
        {attention && (
          <span style={{
            padding: "0 5px", borderRadius: 999,
            border: "1px solid #d97706", color: "#d97706",
            fontSize: 9.5, lineHeight: 1.6, textTransform: "uppercase", flexShrink: 0,
          }}>
            {t("runs_needsAttention")}
          </span>
        )}
        {step.model && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
            {step.model}
          </span>
        )}
        {duration !== null && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {formatRunDurationMs(duration)}
          </span>
        )}
        {step.tokens && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
            {t("subagent_tokensInOut", { input: formatTokenCount(step.tokens.input), output: formatTokenCount(step.tokens.output) })}
          </span>
        )}
        {step.costUsd !== undefined && step.costUsd > 0 && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
            {formatCost(step.costUsd)}
          </span>
        )}
        {step.currentTool && (
          <span style={{ fontSize: 10, color: "#d97706" }}>{t("chat_runningNamed", { name: step.currentTool })}</span>
        )}
      </div>

      {step.error && (
        <div style={{ marginTop: 3, fontSize: 11, color: "#f87171", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {step.error}
        </div>
      )}

      {recentOutput && (
        <pre style={{
          margin: "4px 0 0", padding: "5px 8px", maxHeight: 96, overflow: "auto",
          borderRadius: 5, background: "var(--bg-subtle)",
          color: "var(--text-dim)", fontFamily: "var(--font-mono)",
          fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
        }}>
          {recentOutput.join("\n")}
        </pre>
      )}

      {/* 仅当后端已发现只读 child（sessionId）时显示，避免假 affordance */}
      {step.sessionFile && step.sessionId && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={() => onOpenSubagentSession(step.sessionFile as string)}
            title={step.sessionFile}
            style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--accent)", cursor: "pointer", font: "inherit", fontSize: 10.5 }}
          >
            {t("subagent_openSession")}
          </button>
        </div>
      )}
    </li>
  );
}
