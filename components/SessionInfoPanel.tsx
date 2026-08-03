"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionInfo } from "@/lib/types";
import {
  buildSessionExportHtmlHref,
  buildSessionExportJsonlHref,
  canExportSession,
} from "./session-export-links";

type SessionCopyField = "file" | "id";

interface Props {
  session: SessionInfo | null;
  sessionStats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt: string | null;
  /** JSONL 导出按当前分支截断；无 leaf 时导出整分支。 */
  branchActiveLeafId: string | null;
}

/**
 * 右栏「会话信息」Tab：整合会话 stats（tokens+cost+context usage）、
 * 导出（原生 <a href download>，不读进前端内存）与 system prompt 查看。
 * 顶栏不再保留这三类入口，本面板是唯一入口。
 */
export function SessionInfoPanel({ session, sessionStats, contextUsage, systemPrompt, branchActiveLeafId }: Props) {
  const { t } = useI18n();
  const [copiedField, setCopiedField] = useState<SessionCopyField | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopy = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopiedField(field);
      copyTimerRef.current = setTimeout(() => setCopiedField(null), 1400);
    });
  }, []);

  const sectionTitle = (text: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{text}</div>
  );

  const copyButton = (field: SessionCopyField, value: string) => {
    const copied = copiedField === field;
    return (
      <button
        type="button"
        title={copied ? t("app_copied") : field === "file" ? t("app_copyFilePath") : t("app_copySessionId")}
        aria-label={copied ? t("app_copied") : field === "file" ? t("app_copyFilePath") : t("app_copySessionId")}
        onClick={() => handleCopy(field, value)}
        style={{
          alignSelf: "start",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          marginTop: -2,
          color: copied ? "var(--accent)" : "var(--text-dim)",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 4,
          cursor: "pointer",
          flex: "0 0 auto",
          transition: "color 0.12s, border-color 0.12s, background 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--accent)";
          e.currentTarget.style.borderColor = "var(--accent)";
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.background = "transparent";
        }}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    );
  };

  const statSection = (title: string, rows: string[][]) => (
    <div style={{ minWidth: 0 }}>
      {sectionTitle(title)}
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        columnGap: 12,
        rowGap: 4,
      }}>
        {rows.map(([label, value]) => (
          <div key={`${title}:${label}`} style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
            <div style={{
              color: "var(--text-muted)",
              minWidth: 0,
              overflowWrap: "anywhere",
              textAlign: "right",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );

  const hint = (text: string) => (
    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>{text}</div>
  );

  return (
    <div style={{
      height: "100%",
      overflowY: "auto",
      overflowX: "hidden",
      padding: "12px 16px 20px",
      display: "flex",
      flexDirection: "column",
      gap: 18,
      fontSize: 12,
      lineHeight: 1.5,
    }}>
      {!session ? (
        hint(t("panel_selectSessionHint"))
      ) : (
        <>
          {/* 会话标识：名称 / 文件 / id（可复制） */}
          <div style={{ minWidth: 0 }}>
            {sectionTitle(t("app_sessionInfo"))}
            {sessionStats ? (
              <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                {([
                  ...(sessionStats.sessionName ? [{ label: t("app_name"), value: sessionStats.sessionName, copyField: null }] : []),
                  { label: t("app_file"), value: sessionStats.sessionFile ?? t("app_inMemory"), copyField: "file" as const },
                  { label: t("app_id"), value: sessionStats.sessionId, copyField: "id" as const },
                ]).map((row) => (
                  <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                    <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                    <div style={{
                      color: "var(--text-muted)",
                      minWidth: 0,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                      whiteSpace: "normal",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11.5,
                    }}>{row.value}</div>
                    <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                  </div>
                ))}
              </div>
            ) : (
              hint(t("app_sessionInfoAfterMessageHint"))
            )}
          </div>

          {/* 消息 / tokens / 成本 / 上下文用量 */}
          {sessionStats && (
            <>
              {statSection(t("app_messages"), [
                [t("app_user"), sessionStats.userMessages.toLocaleString()],
                [t("app_assistant"), sessionStats.assistantMessages.toLocaleString()],
                [t("app_toolCalls"), sessionStats.toolCalls.toLocaleString()],
                [t("app_toolResults"), sessionStats.toolResults.toLocaleString()],
                [t("app_total"), sessionStats.totalMessages.toLocaleString()],
              ])}
              {(() => {
                const ctx = contextUsage ?? sessionStats.contextUsage;
                const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                return statSection(t("app_tokens"), [
                  [t("app_input"), sessionStats.tokens.input.toLocaleString()],
                  [t("app_output"), sessionStats.tokens.output.toLocaleString()],
                  ...(sessionStats.tokens.cacheRead > 0 ? [[t("app_cacheRead"), sessionStats.tokens.cacheRead.toLocaleString()]] : []),
                  ...(sessionStats.tokens.cacheWrite > 0 ? [[t("app_cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString()]] : []),
                  [t("app_total"), sessionStats.tokens.total.toLocaleString()],
                  ...(sessionStats.cost > 0 ? [[t("app_cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                  ...(ctx?.contextWindow ? [[t("app_context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                ]);
              })()}
            </>
          )}

          {/* 导出：仅已持久化会话（有真实 id）展示；readOnly 子会话同样可导出。
              两项原生 <a href download>；href 随 branchActiveLeafId 实时重建。 */}
          {canExportSession(session) && (
            <div style={{ minWidth: 0 }}>
              {sectionTitle(t("export_title"))}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {([
                  {
                    key: "html",
                    href: buildSessionExportHtmlHref(session.id),
                    label: t("export_htmlLabel"),
                    desc: t("export_htmlDesc"),
                    icon: (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="16 18 22 12 16 6" />
                        <polyline points="8 6 2 12 8 18" />
                      </svg>
                    ),
                  },
                  {
                    key: "jsonl",
                    href: buildSessionExportJsonlHref(session.id, branchActiveLeafId),
                    label: t("export_jsonlLabel"),
                    desc: t("export_jsonlDesc"),
                    icon: (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
                        <path d="M16 21h1a2 2 0 0 0 2-2v-4a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
                      </svg>
                    ),
                  },
                ]).map((item) => (
                  <a
                    key={item.key}
                    href={item.href}
                    download
                    title={item.desc}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 10px", borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "none", textDecoration: "none",
                      color: "var(--text)", cursor: "pointer",
                      transition: "background 0.12s, border-color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.borderColor = "var(--accent)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "none";
                      e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}>{item.icon}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>{item.label}</span>
                      <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4, overflowWrap: "anywhere" }}>{item.desc}</span>
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* System prompt 查看 */}
          <div style={{ minWidth: 0 }}>
            {sectionTitle(t("app_systemPrompt"))}
            {session.readOnly === true ? (
              hint(t("app_systemPromptReadOnlyHint"))
            ) : systemPrompt ? (
              <div style={{
                maxHeight: "min(480px, 60vh)",
                overflowY: "auto",
                padding: "10px 12px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontFamily: "var(--font-mono)",
              }}>
                {systemPrompt}
              </div>
            ) : systemPrompt === "" ? (
              hint(t("app_systemPromptEmptyHint"))
            ) : (
              hint(t("app_systemPromptAfterMessageHint"))
            )}
          </div>
        </>
      )}
    </div>
  );
}
