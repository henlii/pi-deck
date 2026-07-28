"use client";

import { useCallback, useId, useMemo, useState } from "react";
import type {
  WorkspaceHistoryMarker,
  WorkspaceHistoryView,
  WorkspaceSnapshotKind,
} from "@/lib/workspace-history";
import { useI18n } from "@/lib/i18n";

export interface WorkspaceHistoryPanelProps {
  history: WorkspaceHistoryView | null | undefined;
  collapsed: boolean;
  onToggle: () => void;
  /** 可写且空闲时可派发；只读/busy 时为 null 或禁用 */
  canAct: boolean;
  acting?: boolean;
  onUndo?: () => void | Promise<void>;
  onRedo?: () => void | Promise<void>;
  onCheckpoint?: (label?: string) => void | Promise<void>;
  /** 可选：展开某 marker 的文件变更 */
  cwd?: string | null;
  sessionId?: string | null;
}

const KIND_ORDER: WorkspaceSnapshotKind[] = ["baseline", "before", "after", "manual"];

const KIND_KEYS: Record<
  WorkspaceSnapshotKind,
  "wh_kindBaseline" | "wh_kindBefore" | "wh_kindAfter" | "wh_kindManual"
> = {
  baseline: "wh_kindBaseline",
  before: "wh_kindBefore",
  after: "wh_kindAfter",
  manual: "wh_kindManual",
};

const KIND_COLORS: Record<WorkspaceSnapshotKind, string> = {
  baseline: "var(--text-dim)",
  before: "var(--accent)",
  after: "#22c55e",
  manual: "#f59e0b",
};

function formatWhTime(value: string): string {
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

function KindBadge({ kind }: { kind: WorkspaceSnapshotKind }) {
  const { t } = useI18n();
  return (
    <span
      title={t(KIND_KEYS[kind])}
      style={{
        flexShrink: 0,
        color: KIND_COLORS[kind],
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: kind === "manual" || kind === "after" ? 700 : 550,
        letterSpacing: 0.35,
        textTransform: "uppercase",
      }}
    >
      {t(KIND_KEYS[kind])}
    </span>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
  primary,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        flexShrink: 0,
        height: 24,
        padding: "0 8px",
        border: primary ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)",
        borderRadius: 5,
        background: primary
          ? "color-mix(in srgb, var(--accent) 12%, var(--bg))"
          : "var(--bg)",
        color: disabled ? "var(--text-dim)" : primary ? "var(--accent)" : "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {label}
    </button>
  );
}

function MarkerDiff({
  marker,
  previousCommit,
  cwd,
  sessionId,
}: {
  marker: WorkspaceHistoryMarker;
  previousCommit?: string;
  cwd: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ status: string; path: string }> | null>(null);

  const fromCommit = previousCommit ?? null;
  const canDiff = !!fromCommit && fromCommit !== marker.commit;

  const loadDiff = useCallback(async () => {
    if (!canDiff || !fromCommit) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        cwd,
        sessionId,
        from: fromCommit,
        to: marker.commit,
      });
      const res = await fetch(`/api/workspace-history/diff?${params}`);
      const data = await res.json() as {
        files?: Array<{ status: string; path: string }>;
        error?: string;
      };
      if (!res.ok && !data.files) {
        setFiles([]);
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setFiles(data.files ?? []);
      setError(data.error ?? null);
    } catch (e) {
      setFiles([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [canDiff, cwd, fromCommit, marker.commit, sessionId]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && files === null && !loading) {
        void loadDiff();
      }
      return next;
    });
  }, [files, loadDiff, loading]);

  if (!canDiff) return null;

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          border: 0,
          background: "transparent",
          color: "var(--accent)",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          padding: 0,
        }}
      >
        {open ? t("wh_hideFiles") : t("wh_showFiles")}
      </button>
      {open && (
        <div style={{ marginTop: 4, paddingLeft: 2 }}>
          {loading ? (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("common_loading")}</div>
          ) : error && (!files || files.length === 0) ? (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("wh_diffUnavailable")}</div>
          ) : files && files.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("wh_noFileChanges")}</div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {(files ?? []).slice(0, 40).map((f) => (
                <li
                  key={`${f.status}:${f.path}`}
                  style={{
                    display: "flex",
                    gap: 6,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", width: 14 }}>{f.status}</span>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{f.path}</span>
                </li>
              ))}
              {files && files.length > 40 ? (
                <li style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 2 }}>
                  {t("wh_moreFiles", { count: files.length - 40 })}
                </li>
              ) : null}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceHistoryPanel({
  history,
  collapsed,
  onToggle,
  canAct,
  acting = false,
  onUndo,
  onRedo,
  onCheckpoint,
  cwd,
  sessionId,
}: WorkspaceHistoryPanelProps) {
  const { t } = useI18n();
  const listId = useId();
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [checkpointLabel, setCheckpointLabel] = useState("");

  const markersNewestFirst = useMemo(() => {
    if (!history) return [] as WorkspaceHistoryMarker[];
    return [...history.markers].reverse();
  }, [history]);

  /** 用于 diff：path 序中前一个 commit（markers 原序较新在末尾） */
  const previousCommitByEntryId = useMemo(() => {
    const map = new Map<string, string | undefined>();
    if (!history) return map;
    let prev: string | undefined;
    for (const m of history.markers) {
      map.set(m.entryId, prev);
      prev = m.commit;
    }
    return map;
  }, [history]);

  if (!history || !history.hasData) return null;

  const { counts } = history;
  const kindParts = KIND_ORDER
    .filter((k) => (counts.byKind[k] ?? 0) > 0)
    .map((k) => `${counts.byKind[k]} ${t(KIND_KEYS[k])}`);
  const latest = markersNewestFirst[0] ?? null;
  const actionsDisabled = !canAct || acting;

  return (
    <section
      aria-label={t("wh_toggle")}
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
        title={collapsed ? t("wh_expand") : t("wh_collapse")}
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
          {t("wh_toggle")}
        </span>

        <span
          style={{
            flexShrink: 0,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          {t("wh_countSummary", { count: counts.total })}
        </span>

        {kindParts.length > 0 ? (
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
            {kindParts.join(" · ")}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}

        {latest ? (
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
            {formatWhTime(latest.createdAt)}
          </span>
        ) : null}
      </button>

      {/* 操作行：仅可写会话显示；只读时不提供按钮 */}
      {(onUndo || onRedo || onCheckpoint) && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            padding: "0 9px 7px",
          }}
        >
          {onUndo ? (
            <ActionButton label={t("wh_undo")} disabled={actionsDisabled} onClick={() => void onUndo()} />
          ) : null}
          {onRedo ? (
            <ActionButton label={t("wh_redo")} disabled={actionsDisabled} onClick={() => void onRedo()} />
          ) : null}
          {onCheckpoint ? (
            checkpointOpen ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, flex: 1 }}>
                <input
                  value={checkpointLabel}
                  onChange={(e) => setCheckpointLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const label = checkpointLabel.trim();
                      void onCheckpoint(label || undefined);
                      setCheckpointOpen(false);
                      setCheckpointLabel("");
                    }
                    if (e.key === "Escape") {
                      setCheckpointOpen(false);
                      setCheckpointLabel("");
                    }
                  }}
                  placeholder={t("wh_checkpointPlaceholder")}
                  aria-label={t("wh_checkpointPlaceholder")}
                  disabled={actionsDisabled}
                  style={{
                    minWidth: 0,
                    flex: 1,
                    height: 24,
                    padding: "0 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    outline: "none",
                  }}
                />
                <ActionButton
                  label={t("wh_checkpointSave")}
                  primary
                  disabled={actionsDisabled}
                  onClick={() => {
                    const label = checkpointLabel.trim();
                    void onCheckpoint(label || undefined);
                    setCheckpointOpen(false);
                    setCheckpointLabel("");
                  }}
                />
                <ActionButton
                  label={t("common_cancel")}
                  disabled={acting}
                  onClick={() => {
                    setCheckpointOpen(false);
                    setCheckpointLabel("");
                  }}
                />
              </span>
            ) : (
              <ActionButton
                label={t("wh_checkpoint")}
                primary
                disabled={actionsDisabled}
                onClick={() => setCheckpointOpen(true)}
              />
            )
          ) : null}
          {!canAct ? (
            <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {t("wh_actionsDisabled")}
            </span>
          ) : null}
        </div>
      )}

      {!collapsed && (
        <div
          id={listId}
          style={{
            maxHeight: 240,
            overflowY: "auto",
            borderTop: "1px solid var(--border)",
          }}
        >
          {markersNewestFirst.length === 0 ? (
            <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 11 }}>{t("wh_empty")}</div>
          ) : (
            <ul style={{ margin: 0, padding: "4px 0 6px", listStyle: "none" }}>
              {markersNewestFirst.map((marker) => {
                const title =
                  marker.label?.trim() ||
                  marker.promptText?.trim() ||
                  t(KIND_KEYS[marker.kind]);
                const prev = previousCommitByEntryId.get(marker.entryId);
                return (
                  <li
                    key={marker.entryId}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "5px 10px",
                      color: "var(--text)",
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}
                  >
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflowWrap: "anywhere" }}>{title}</span>
                      <span
                        style={{
                          display: "block",
                          marginTop: 1,
                          color: "var(--text-dim)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                        }}
                      >
                        {formatWhTime(marker.createdAt)}
                        {" · "}
                        <span title={marker.commit}>{marker.shortCommit}</span>
                      </span>
                      {cwd && sessionId ? (
                        <MarkerDiff
                          marker={marker}
                          previousCommit={prev}
                          cwd={cwd}
                          sessionId={sessionId}
                        />
                      ) : null}
                    </span>
                    <KindBadge kind={marker.kind} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
