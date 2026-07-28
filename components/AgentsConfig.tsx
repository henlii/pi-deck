"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type {
  AgentRosterEntry,
  AgentRosterSnapshot,
  AgentSource,
  RunHistoryEntry,
} from "@/lib/agent-roster";

interface AgentsConfigProps {
  /** 活动项目目录；可空，仍展示全局/user/builtin */
  cwd: string | null;
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: 8,
};

const monoStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  wordBreak: "break-all",
};

const SOURCE_ORDER: AgentSource[] = ["builtin", "package", "user", "project"];

function sourceLabelKey(source: AgentSource): "agents_sourceBuiltin" | "agents_sourcePackage" | "agents_sourceUser" | "agents_sourceProject" {
  switch (source) {
    case "builtin":
      return "agents_sourceBuiltin";
    case "package":
      return "agents_sourcePackage";
    case "user":
      return "agents_sourceUser";
    case "project":
      return "agents_sourceProject";
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTs(ts: number, locale: string): string {
  // pi-subagents 写入秒级 unix
  const ms = ts > 1e12 ? ts : ts * 1000;
  try {
    return new Date(ms).toLocaleString(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function AgentCard({ agent }: { agent: AgentRosterEntry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 650, color: "var(--text)" }}>{agent.name}</span>
            {agent.disabled && (
              <span
                style={{
                  fontSize: 10.5,
                  padding: "1px 7px",
                  borderRadius: 999,
                  border: "1px solid #dc262655",
                  color: "#dc2626",
                }}
              >
                {t("agents_disabled")}
              </span>
            )}
            {agent.model && (
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                {agent.model}
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
              overflow: expanded ? "visible" : "hidden",
              display: expanded ? "block" : "-webkit-box",
              WebkitLineClamp: expanded ? undefined : 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {agent.description}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            flexShrink: 0,
            border: "none",
            background: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 4px",
          }}
        >
          {expanded ? t("agents_collapse") : t("agents_expand")}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {agent.tools && agent.tools.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ fontWeight: 600 }}>{t("agents_tools")}: </span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{agent.tools.join(", ")}</span>
            </div>
          )}
          {agent.fallbackModels && agent.fallbackModels.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ fontWeight: 600 }}>{t("agents_fallback")}: </span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{agent.fallbackModels.join(", ")}</span>
            </div>
          )}
          {agent.thinking !== undefined && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ fontWeight: 600 }}>{t("agents_thinking")}: </span>
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {agent.thinking === false ? "false" : String(agent.thinking)}
              </span>
            </div>
          )}
          {agent.defaultContext && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ fontWeight: 600 }}>{t("agents_context")}: </span>
              {agent.defaultContext}
            </div>
          )}
          <div style={{ ...monoStyle, color: "var(--text-dim)", marginTop: 2 }}>{agent.filePath}</div>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ entry, locale }: { entry: RunHistoryEntry; locale: string }) {
  const { t } = useI18n();
  const ok = entry.status === "ok";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{entry.agent}</span>
        <span
          style={{
            fontSize: 10.5,
            padding: "1px 7px",
            borderRadius: 999,
            border: `1px solid ${ok ? "var(--border)" : "#dc262655"}`,
            color: ok ? "var(--text-dim)" : "#dc2626",
          }}
        >
          {ok ? t("agents_statusOk") : t("agents_statusError")}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>
          {formatTs(entry.ts, locale)} · {formatDuration(entry.duration)}
          {entry.exit !== undefined ? ` · exit ${entry.exit}` : ""}
        </span>
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.45,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
        title={entry.task}
      >
        {entry.task}
      </div>
    </div>
  );
}

export function AgentsConfig({ cwd }: AgentsConfigProps) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<AgentRosterSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      const qs = params.toString();
      const res = await fetch(`/api/agents${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as AgentRosterSnapshot;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const grouped = useMemo(() => {
    if (!data) return [] as Array<{ source: AgentSource; agents: AgentRosterEntry[] }>;
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? data.agents.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q) ||
            (a.model?.toLowerCase().includes(q) ?? false),
        )
      : data.agents;
    return SOURCE_ORDER.map((source) => ({
      source,
      agents: filtered.filter((a) => a.source === source),
    })).filter((g) => g.agents.length > 0);
  }, [data, filter]);

  const intlLocale = locale === "zh-CN" ? "zh-CN" : "en-US";

  return (
    <div style={{ padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 14 }}>
        {t("agents_readOnlyHint")}
      </div>

      {loading && !data ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("common_loading")}</div>
      ) : error && !data ? (
        <div>
          <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 10 }}>
            {t("agents_loadFailed")}: {error}
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            style={{
              minHeight: 30,
              padding: "0 12px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("agents_retry")}
          </button>
        </div>
      ) : data ? (
        <>
          {error && (
            <div style={{ fontSize: 11, color: "#dc2626", marginBottom: 12 }}>
              {t("agents_loadFailed")}: {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              marginBottom: 14,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("agents_countSummary", {
                total: data.counts.total,
                builtin: data.counts.bySource.builtin ?? 0,
                package: data.counts.bySource.package ?? 0,
                user: data.counts.bySource.user ?? 0,
                project: data.counts.bySource.project ?? 0,
              })}
            </span>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("agents_searchPlaceholder")}
              style={{
                marginLeft: "auto",
                minWidth: 160,
                maxWidth: 260,
                flex: "1 1 160px",
                padding: "6px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={loading}
              style={{
                minHeight: 30,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: 12,
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? t("common_loading") : t("agents_refresh")}
            </button>
          </div>

          {grouped.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 22 }}>
              {filter.trim() ? t("agents_noMatch") : t("agents_empty")}
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.source} style={{ marginBottom: 20 }}>
                <div style={sectionTitleStyle}>
                  {t(sourceLabelKey(group.source))}
                  <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--text-dim)" }}>
                    {group.agents.length}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {group.agents.map((agent) => (
                    <AgentCard key={`${agent.source}:${agent.filePath}:${agent.name}`} agent={agent} />
                  ))}
                </div>
              </div>
            ))
          )}

          <div style={{ marginBottom: 8 }}>
            <div style={sectionTitleStyle}>{t("agents_historyTitle")}</div>
            <div style={{ ...monoStyle, color: "var(--text-dim)", marginBottom: 8 }}>{data.historyPath}</div>
            {!data.historyAvailable ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("agents_historyMissing")}</div>
            ) : data.history.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("agents_historyEmpty")}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {data.history.map((entry, index) => (
                  <HistoryRow
                    key={`${entry.ts}-${entry.agent}-${index}`}
                    entry={entry}
                    locale={intlLocale}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
