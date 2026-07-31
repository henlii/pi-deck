"use client";

/**
 * 撤回坞（OpenChamber RevertedMessageDock 风格）：ChatInput 上方折叠卡片。
 * 折叠态一行标题「已撤回 N 条消息」；展开列出每条被撤回 user 消息的
 * 文本预览与 [恢复] 按钮。数据来自服务端内存栈（lib/retract-stack）。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { RetractedRecord } from "@/lib/retract-stack";

type Props = {
  records: RetractedRecord[];
  busy: boolean;
  onRestore: (entryId: string) => Promise<void> | void;
};

export function RetractedMessagesDock({ records, busy, onRestore }: Props) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // 撤回区变化时重置为折叠（OpenChamber 同款行为）。
  const countKey = records.length;
  useEffect(() => {
    setCollapsed(true);
  }, [countKey]);

  if (records.length === 0) return null;

  const handleRestore = (entryId: string) => {
    if (busy || restoringId) return;
    setRestoringId(entryId);
    Promise.resolve(onRestore(entryId)).finally(() => setRestoringId(null));
  };

  return (
    <div style={{ flexShrink: 0, padding: "0 16px 8px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div
          style={{
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 12px",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text)",
              fontSize: 12,
              fontWeight: 600,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            <span style={{ flexShrink: 0 }}>
              {t("retracted_messagesTitle", { count: records.length })}
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginLeft: "auto", color: "var(--text-dim)", transform: collapsed ? "none" : "rotate(180deg)", transition: "transform 0.15s" }}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {!collapsed && (
            <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6, maxHeight: 168, overflowY: "auto" }}>
              {records.map((record) => (
                <div key={record.entryId} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span
                    title={record.text}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {record.text || t("retracted_noText")}
                  </span>
                  <button
                    type="button"
                    disabled={busy || restoringId !== null}
                    onClick={() => handleRestore(record.entryId)}
                    title={t("retracted_restoreTooltip")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      flexShrink: 0,
                      padding: "3px 8px",
                      height: 22,
                      background: "none",
                      border: "none",
                      borderRadius: 5,
                      color: restoringId === record.entryId ? "var(--accent)" : "var(--text-dim)",
                      cursor: busy || restoringId !== null ? "not-allowed" : "pointer",
                      fontSize: 11,
                      fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color 0.12s",
                    }}
                    onMouseEnter={(e) => { if (!busy && restoringId === null) e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = restoringId === record.entryId ? "var(--accent)" : "var(--text-dim)"; }}
                  >
                    {restoringId === record.entryId ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
                        <line x1="12" y1="2" x2="12" y2="6" />
                        <line x1="12" y1="18" x2="12" y2="22" />
                        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                        <line x1="2" y1="12" x2="6" y2="12" />
                        <line x1="18" y1="12" x2="22" y2="12" />
                        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="15 14 20 9 15 4" />
                        <path d="M20 9h-8a5 5 0 0 0-5 5v6" />
                      </svg>
                    )}
                    {t("retracted_restore")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
