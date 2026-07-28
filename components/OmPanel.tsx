"use client";

import { useId, useMemo } from "react";
import type { OmObservationView, OmReflectionView, OmRelevance, ObservationalMemoryView } from "@/lib/om-ledger";
import { useI18n } from "@/lib/i18n";

export interface OmPanelProps {
  memory: ObservationalMemoryView | null | undefined;
  collapsed: boolean;
  onToggle: () => void;
}

const RELEVANCE_ORDER: OmRelevance[] = ["critical", "high", "medium", "low"];

const RELEVANCE_KEYS: Record<OmRelevance, "om_relevanceCritical" | "om_relevanceHigh" | "om_relevanceMedium" | "om_relevanceLow"> = {
  critical: "om_relevanceCritical",
  high: "om_relevanceHigh",
  medium: "om_relevanceMedium",
  low: "om_relevanceLow",
};

const RELEVANCE_COLORS: Record<OmRelevance, string> = {
  critical: "#ef4444",
  high: "#f59e0b",
  medium: "var(--accent)",
  low: "var(--text-dim)",
};

function formatOmTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function RelevanceBadge({ relevance }: { relevance: OmRelevance }) {
  const { t } = useI18n();
  return (
    <span
      title={t(RELEVANCE_KEYS[relevance])}
      style={{
        flexShrink: 0,
        color: RELEVANCE_COLORS[relevance],
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: relevance === "critical" || relevance === "high" ? 700 : 550,
        letterSpacing: 0.35,
        textTransform: "uppercase",
      }}
    >
      {t(RELEVANCE_KEYS[relevance])}
    </span>
  );
}

export function OmPanel({ memory, collapsed, onToggle }: OmPanelProps) {
  const { t } = useI18n();
  const listId = useId();

  const observationsNewestFirst = useMemo(() => {
    if (!memory) return [] as OmObservationView[];
    return [...memory.observations].reverse();
  }, [memory]);

  const reflectionsNewestFirst = useMemo(() => {
    if (!memory) return [] as OmReflectionView[];
    return [...memory.reflections].reverse();
  }, [memory]);

  if (!memory || !memory.hasData) return null;

  const { counts, relevance } = memory;
  const latestObservation = observationsNewestFirst[0] ?? null;
  const relevanceParts = RELEVANCE_ORDER
    .filter((key) => (relevance[key] ?? 0) > 0)
    .map((key) => `${relevance[key]} ${t(RELEVANCE_KEYS[key])}`);

  return (
    <section
      aria-label={t("om_toggle")}
      style={{
        marginBottom: 8,
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <button
        type="button"
        aria-controls={listId}
        aria-expanded={!collapsed}
        title={collapsed ? t("om_expand") : t("om_collapse")}
        onClick={onToggle}
        style={{
          display: "flex",
          width: "100%",
          minHeight: 32,
          alignItems: "center",
          gap: 8,
          padding: "5px 9px",
          border: 0,
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform 0.15s ease",
          }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>

        <span
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 650,
            letterSpacing: 0.45,
            textTransform: "uppercase",
          }}
        >
          {t("om_toggle")}
        </span>

        <span
          style={{
            flexShrink: 0,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          {t("om_countSummary", {
            observations: counts.observationsActive,
            reflections: counts.reflectionsRecorded,
          })}
        </span>

        {counts.observationsDropped > 0 ? (
          <span
            style={{
              flexShrink: 0,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            {t("om_dropped", { count: counts.observationsDropped })}
          </span>
        ) : null}

        {relevanceParts.length > 0 ? (
          <span
            className="hidden min-[560px]:inline"
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            {relevanceParts.join(" · ")}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}

        {latestObservation ? (
          <span
            className="hidden min-[640px]:inline"
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            {formatOmTime(latestObservation.timestamp)}
          </span>
        ) : null}
      </button>

      {!collapsed && (
        <div
          id={listId}
          style={{
            maxHeight: 224,
            overflowY: "auto",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div style={{ padding: "6px 10px 2px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 650, letterSpacing: 0.4, textTransform: "uppercase" }}>
            {t("om_observations")}
            <span style={{ marginLeft: 6, fontWeight: 500 }}>{counts.observationsActive}</span>
          </div>
          {observationsNewestFirst.length === 0 ? (
            <div style={{ padding: "2px 10px 8px", color: "var(--text-dim)", fontSize: 11 }}>{t("om_emptyObservations")}</div>
          ) : (
            <ul style={{ margin: 0, padding: "0 0 4px", listStyle: "none" }}>
              {observationsNewestFirst.map((item) => (
                <li
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "4px 10px",
                    color: "var(--text)",
                    fontSize: 12,
                    lineHeight: 1.45,
                  }}
                >
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", overflowWrap: "anywhere" }}>{item.content}</span>
                    <span style={{ display: "block", marginTop: 1, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                      {formatOmTime(item.timestamp)}
                      {item.tokenCount > 0 ? ` · ${item.tokenCount} tok` : ""}
                    </span>
                  </span>
                  <RelevanceBadge relevance={item.relevance} />
                </li>
              ))}
            </ul>
          )}

          <div style={{ padding: "6px 10px 2px", borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 650, letterSpacing: 0.4, textTransform: "uppercase" }}>
            {t("om_reflections")}
            <span style={{ marginLeft: 6, fontWeight: 500 }}>{counts.reflectionsRecorded}</span>
          </div>
          {reflectionsNewestFirst.length === 0 ? (
            <div style={{ padding: "2px 10px 8px", color: "var(--text-dim)", fontSize: 11 }}>{t("om_emptyReflections")}</div>
          ) : (
            <ul style={{ margin: 0, padding: "0 0 6px", listStyle: "none" }}>
              {reflectionsNewestFirst.map((item) => (
                <li
                  key={item.id}
                  style={{
                    padding: "4px 10px",
                    color: "var(--text)",
                    fontSize: 12,
                    lineHeight: 1.45,
                  }}
                >
                  <span style={{ display: "block", overflowWrap: "anywhere" }}>{item.content}</span>
                  {item.tokenCount > 0 ? (
                    <span style={{ display: "block", marginTop: 1, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                      {item.tokenCount} tok
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
