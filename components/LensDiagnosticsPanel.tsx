"use client";

/**
 * 第三阶段 D10：pi-lens 诊断只读面板。
 * 入口为 TopBar Diagnostics 按钮，渲染在 AppShell 共享 top panel 浮层内。
 * 只读：不写盘、不启动 LSP、不提供修复/忽略控制。
 * 轮询仅在面板打开时：有 error 2s，否则 8s；document.hidden 暂停。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type {
  LensDiagnosticItem,
  LensDiagnosticsFileGroup,
  LensDiagnosticsSnapshot,
  LensQualityWarning,
  LensSeverity,
} from "@/lib/lens-diagnostics";

const SEVERITY_COLORS: Record<LensSeverity, string> = {
  error: "#dc2626",
  warning: "#d97706",
  info: "var(--text-dim)",
  hint: "var(--text-dim)",
};

export function resolveDiagPollDelayMs(hasErrors: boolean, hidden: boolean): number | null {
  if (hidden) return null;
  return hasErrors ? 2000 : 8000;
}

export function formatDiagClock(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function SeverityBadge({ severity, count }: { severity: LensSeverity; count: number }) {
  if (count <= 0) return null;
  return (
    <span
      style={{
        padding: "0 6px",
        borderRadius: 999,
        border: `1px solid ${SEVERITY_COLORS[severity]}55`,
        color: SEVERITY_COLORS[severity],
        fontSize: 10,
        lineHeight: 1.6,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {count}
    </span>
  );
}

function DiagnosticRow({ item }: { item: LensDiagnosticItem }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "4px 0",
        fontSize: 11.5,
        lineHeight: 1.45,
        borderBottom: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 52,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: SEVERITY_COLORS[item.severity],
          textTransform: "uppercase",
        }}
      >
        {item.severity}
      </span>
      <span
        style={{
          flexShrink: 0,
          width: 48,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: "var(--text-dim)",
          textAlign: "right",
        }}
      >
        L{item.line}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: "var(--text)", wordBreak: "break-word" }}>
        {item.message}
        {(item.source || item.code) && (
          <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 10.5 }}>
            {[item.source, item.code].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
    </div>
  );
}

function FileGroupCard({ group }: { group: LensDiagnosticsFileGroup }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(
    (group.bySeverity.error ?? 0) > 0 || group.count <= 5,
  );
  return (
    <li style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "8px 16px 6px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text)",
          font: "inherit",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        {expanded ? (
          <ChevronDown size={12} aria-hidden style={{ color: "var(--text-dim)", flexShrink: 0 }} />
        ) : (
          <ChevronRight size={12} aria-hidden style={{ color: "var(--text-dim)", flexShrink: 0 }} />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={group.filePath}
        >
          {group.displayPath}
        </span>
        <SeverityBadge severity="error" count={group.bySeverity.error ?? 0} />
        <SeverityBadge severity="warning" count={group.bySeverity.warning ?? 0} />
        <SeverityBadge severity="info" count={group.bySeverity.info ?? 0} />
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0 }}>
          {t("lens_itemCount", { count: group.count })}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 16px 8px 35px" }}>
          {group.items.map((item, i) => (
            <DiagnosticRow key={`${item.line}-${item.message.slice(0, 24)}-${i}`} item={item} />
          ))}
        </div>
      )}
    </li>
  );
}

function QualityRow({ item }: { item: LensQualityWarning }) {
  return (
    <div
      style={{
        padding: "7px 16px",
        borderBottom: "1px solid var(--border)",
        fontSize: 11.5,
        lineHeight: 1.45,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: SEVERITY_COLORS[item.severity],
            textTransform: "uppercase",
          }}
        >
          {item.severity}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text)",
            fontWeight: 600,
          }}
          title={item.filePath}
        >
          {item.displayPath}
          {item.line != null ? `:${item.line}` : ""}
        </span>
        {(item.tool || item.rule) && (
          <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
            {[item.tool, item.rule].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      <div style={{ marginTop: 3, color: "var(--text-muted)", wordBreak: "break-word" }}>
        {item.message}
      </div>
    </div>
  );
}

export interface LensDiagnosticsPanelProps {
  cwd: string | null;
  onIssueCountChange?: (count: number) => void;
}

export function LensDiagnosticsPanel({ cwd, onIssueCountChange }: LensDiagnosticsPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<LensDiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const onCountRef = useRef(onIssueCountChange);
  onCountRef.current = onIssueCountChange;

  const load = useCallback(async () => {
    if (!cwd) {
      setData(null);
      setError(null);
      onCountRef.current?.(0);
      return;
    }
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await fetch(`/api/lens-diagnostics?cwd=${encodeURIComponent(cwd)}`, {
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as LensDiagnosticsSnapshot;
      if (seq !== seqRef.current) return;
      setData(body);
      setError(null);
      setUpdatedAt(Date.now());
      onCountRef.current?.(body.counts.total);
    } catch (e) {
      if (ac.signal.aborted || seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  // 自适应轮询
  useEffect(() => {
    if (!cwd) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const hasErrors = (data?.counts.bySeverity.error ?? 0) > 0;
      const delay = resolveDiagPollDelayMs(hasErrors, document.hidden);
      if (delay == null) return;
      timer = setTimeout(() => {
        void load().finally(schedule);
      }, delay);
    };
    schedule();
    const onVis = () => {
      if (timer) clearTimeout(timer);
      if (!document.hidden) void load().finally(schedule);
      else schedule();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [cwd, data?.counts.bySeverity.error, load]);

  if (!cwd) {
    return (
      <div style={{ padding: "16px 16px", fontSize: 12, color: "var(--text-muted)" }}>
        {t("lens_selectProject")}
      </div>
    );
  }

  const errors = data?.counts.bySeverity.error ?? 0;
  const warnings = data?.counts.bySeverity.warning ?? 0;
  const infos = (data?.counts.bySeverity.info ?? 0) + (data?.counts.bySeverity.hint ?? 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", maxHeight: "min(70vh, 560px)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("lens_title")}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>
          {data
            ? t("lens_summary", {
                total: data.counts.total,
                files: data.counts.files,
                errors,
                warnings,
              })
            : t("lens_readOnlyHint")}
        </div>
        {updatedAt != null && (
          <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
            {t("lens_updatedAt", { time: formatDiagClock(updatedAt) })}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title={t("lens_refresh")}
          aria-label={t("lens_refresh")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} aria-hidden />
        </button>
      </div>

      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {loading && !data ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>{t("lens_loading")}</div>
        ) : error && !data ? (
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 8 }}>
              {t("lens_loadFailed")}: {error}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              style={{
                minHeight: 28,
                padding: "0 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {t("lens_retry")}
            </button>
          </div>
        ) : data ? (
          <>
            {error && (
              <div style={{ padding: "8px 16px", fontSize: 11, color: "#dc2626" }}>
                {t("lens_loadFailed")}: {error}
              </div>
            )}
            {!data.cacheAvailable ? (
              <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>
                {t("lens_cacheMissing")}
              </div>
            ) : data.files.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>
                {t("lens_empty")}
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data.files.map((group) => (
                  <FileGroupCard key={group.filePath} group={group} />
                ))}
              </ul>
            )}

            {data.qualityAvailable && data.qualityWarnings.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 4 }}>
                <div
                  style={{
                    padding: "10px 16px 6px",
                    fontSize: 11,
                    fontWeight: 650,
                    color: "var(--text)",
                  }}
                >
                  {t("lens_qualityTitle")}
                  <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--text-dim)" }}>
                    {data.qualityWarnings.length}
                  </span>
                </div>
                {data.qualityWarnings.map((w, i) => (
                  <QualityRow key={`${w.filePath}-${w.message.slice(0, 20)}-${i}`} item={w} />
                ))}
              </div>
            )}

            <div
              style={{
                padding: "8px 16px 12px",
                fontSize: 10.5,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                wordBreak: "break-all",
              }}
            >
              {data.cachePath}
              {infos > 0 ? ` · info/hint ${infos}` : ""}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
