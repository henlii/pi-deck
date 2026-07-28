"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { HermesMemorySnapshot, MemoryEntry, MemorySection } from "@/lib/hermes-memory";

interface MemoryConfigProps {
  /** 活动项目目录；可空，仍展示全局记忆 */
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

function MemoryEntryRow({ entry }: { entry: MemoryEntry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!entry.sensitive);

  if (entry.sensitive && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 12,
        }}
      >
        <span
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            padding: "1px 7px",
            borderRadius: 999,
            border: "1px solid #dc262655",
            color: "#dc2626",
          }}
        >
          {t("memory_sensitiveBadge")}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("memory_sensitiveCollapsed")}
        </span>
      </button>
    );
  }

  return (
    <div
      style={{
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      {entry.sensitive && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span
            style={{
              fontSize: 10.5,
              padding: "1px 7px",
              borderRadius: 999,
              border: "1px solid #dc262655",
              color: "#dc2626",
            }}
          >
            {t("memory_sensitiveBadge")}
          </span>
          {entry.sensitiveIds.length > 0 && (
            <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
              {entry.sensitiveIds.join(", ")}
            </span>
          )}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {t("memory_collapse")}
          </button>
        </div>
      )}
      <div
        style={{
          fontSize: 12.5,
          color: "var(--text)",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {entry.text}
      </div>
    </div>
  );
}

function MemorySectionBlock({
  title,
  section,
}: {
  title: string;
  section: MemorySection;
}) {
  const { t } = useI18n();

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={{ ...monoStyle, color: "var(--text-dim)", marginBottom: 8 }}>{section.path}</div>
      {section.error ? (
        <div style={{ fontSize: 12, color: "#dc2626" }}>{section.error}</div>
      ) : !section.exists ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("memory_fileMissing")}</div>
      ) : section.entries.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("memory_empty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {section.entries.map((entry, index) => (
            <MemoryEntryRow key={`${section.path}-${index}`} entry={entry} />
          ))}
        </div>
      )}
      {section.truncated && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
          {t("memory_truncated")}
        </div>
      )}
    </div>
  );
}

export function MemoryConfig({ cwd }: MemoryConfigProps) {
  const { t } = useI18n();
  const [data, setData] = useState<HermesMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      const qs = params.toString();
      const res = await fetch(`/api/memory${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as HermesMemorySnapshot;
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

  return (
    <div style={{ padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 18 }}>
        {t("memory_readOnlyHint")}
      </div>

      {loading && !data ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("common_loading")}</div>
      ) : error && !data ? (
        <div>
          <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 10 }}>
            {t("memory_loadFailed")}: {error}
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
            {t("memory_retry")}
          </button>
        </div>
      ) : data ? (
        <>
          {error && (
            <div style={{ fontSize: 11, color: "#dc2626", marginBottom: 12 }}>
              {t("memory_loadFailed")}: {error}
            </div>
          )}
          <MemorySectionBlock title={t("memory_globalMemory")} section={data.global.memory} />
          <MemorySectionBlock title={t("memory_userProfile")} section={data.global.user} />
          <MemorySectionBlock title={t("memory_failures")} section={data.global.failures} />
          {data.project ? (
            <MemorySectionBlock
              title={t("memory_projectMemoryNamed", { name: data.project.name })}
              section={data.project.memory}
            />
          ) : (
            <div style={{ marginBottom: 22 }}>
              <div style={sectionTitleStyle}>{t("memory_projectMemory")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t("memory_selectProjectForProject")}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
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
              {loading ? t("common_loading") : t("memory_refresh")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
