"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ViewportDialog } from "./ui/ViewportDialog";
import { useI18n } from "@/lib/i18n";
import {
  getProjectTrustBadgeTone,
  type ProjectTrustBadgeTone,
  type ProjectTrustChoice,
  type ProjectTrustStatus,
} from "@/lib/project-trust-model";

export interface ProjectTrustEntry {
  cwd: string;
  status: ProjectTrustStatus;
  parentPath: string | null;
}

/**
 * 侧栏所有项目的信任状态：一次批量请求问完，避免每个项目行各发一次。
 * 解析失败的目录不会出现在 map 中，对应的行就不显示徽章。
 */
export function useProjectTrust(roots: string[]): {
  entries: Map<string, ProjectTrustEntry>;
  refresh: () => void;
} {
  const [entries, setEntries] = useState<Map<string, ProjectTrustEntry>>(new Map());
  // 用排序后的 JSON 作依赖，避免父组件每次渲染出的新数组触发重复请求；
  // JSON 而非分隔符拼接，路径里可能含空格甚至换行。
  const key = useMemo(() => JSON.stringify([...new Set(roots)].sort()), [roots]);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const paths = JSON.parse(key) as string[];
    if (paths.length === 0) {
      setEntries(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const query = paths.map((path) => `cwd=${encodeURIComponent(path)}`).join("&");
        const res = await fetch(`/api/project-trust?${query}`);
        if (!res.ok) return;
        const data = (await res.json()) as { statuses?: ProjectTrustEntry[] };
        if (cancelled) return;
        setEntries(new Map((data.statuses ?? []).map((entry) => [entry.cwd, entry])));
      } catch {
        // 信任徽章是增量信息：读不到就不显示，不打断侧栏其它功能。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { entries, refresh };
}

const TONE_STYLE: Record<Exclude<ProjectTrustBadgeTone, "none">, { color: string; border: string }> = {
  trusted: { color: "var(--text-dim)", border: "var(--border)" },
  untrusted: { color: "var(--error-text)", border: "var(--status-danger-border)" },
  undecided: {
    color: "var(--warning)",
    border: "color-mix(in srgb, var(--warning) 35%, transparent)",
  },
};

/** 项目行上的信任徽章：只在信任真正起作用时出现，点击进入决策对话框。 */
export function ProjectTrustBadge({
  status,
  projectName,
  onClick,
}: {
  status: ProjectTrustStatus;
  projectName: string;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const tone = getProjectTrustBadgeTone(status);
  if (tone === "none") return null;

  const label =
    tone === "trusted" ? t("trust_badgeTrusted") : tone === "untrusted" ? t("trust_badgeUntrusted") : t("trust_badgeUndecided");
  const title =
    tone === "trusted"
      ? t("trust_badgeTrustedTitle")
      : tone === "untrusted"
        ? t("trust_badgeUntrustedTitle")
        : t("trust_badgeUndecidedTitle");
  const style = TONE_STYLE[tone];

  return (
    <button
      type="button"
      title={title}
      aria-label={t("trust_manage", { project: projectName })}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        // 命中区至少 24×24，视觉仍是 15px 胶囊，避免撑高侧栏行。
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 24,
        height: 24,
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 9,
          padding: "0 5px",
          height: 15,
          borderRadius: 999,
          border: `1px solid ${style.border}`,
          background: "transparent",
          color: style.color,
          lineHeight: 1.5,
          fontWeight: tone === "trusted" ? 400 : 600,
          pointerEvents: "none",
        }}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * 信任决策对话框。选项与 SDK `getProjectTrustOptions` 对齐（信任 / 信任父目录 / 不信任），
 * 不提供「仅本次会话」——Deck 的服务端会话可被重连复用，没有稳定的「本次」边界。
 */
export function ProjectTrustDialog({
  open,
  entry,
  onClose,
  onDecided,
}: {
  open: boolean;
  entry: ProjectTrustEntry | null;
  onClose: () => void;
  onDecided: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<ProjectTrustChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  // entry 消失且对话框仍 open 时关闭，避免隐身后复活；hooks 须在条件 return 之前。
  useEffect(() => {
    if (open && !entry) onClose();
  }, [open, entry, onClose]);

  const decide = useCallback(
    async (choice: ProjectTrustChoice) => {
      if (!entry) return;
      setBusy(choice);
      setError(null);
      try {
        const res = await fetch("/api/project-trust", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: entry.cwd, choice }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? String(res.status));
        if (!mounted.current) return;
        onDecided();
        onClose();
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [entry, onClose, onDecided],
  );

  const optionStyle = (danger: boolean): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: danger ? "var(--error-text)" : "var(--text)",
    fontSize: 12.5,
    cursor: busy ? "progress" : "pointer",
    marginBottom: 8,
  });

  if (!entry) return null;
  const { status, parentPath } = entry;

  return (
    <ViewportDialog
      open={open}
      onClose={onClose}
      title={t("trust_dialogTitle")}
      description={t("trust_dialogBody")}
      closeLabel={t("close")}
      width={520}
    >
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all", marginBottom: 12 }}>
        {status.cwd}
      </div>

      {status.inherited && status.storedPath && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
          {t("trust_inheritedFrom", { path: status.storedPath })}
        </div>
      )}

      <button type="button" disabled={busy !== null} style={optionStyle(false)} onClick={() => decide("trust")}>
        {t("trust_optionTrust")}
      </button>
      {parentPath && (
        <button type="button" disabled={busy !== null} style={optionStyle(false)} onClick={() => decide("trust-parent")}>
          <span>{t("trust_optionTrustParent")}</span>
          <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", wordBreak: "break-all", marginTop: 2 }}>
            {parentPath}
          </span>
        </button>
      )}
      <button type="button" disabled={busy !== null} style={optionStyle(true)} onClick={() => decide("distrust")}>
        {t("trust_optionDistrust")}
      </button>

      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginTop: 4 }}>
        {t("trust_appliesNextSession")}
      </div>
      {busy && (
        <div aria-live="polite" style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
          {t("trust_saving")}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--error-text)", marginTop: 8, wordBreak: "break-all" }}>
          {t("trust_saveFailed")}: {error}
        </div>
      )}
    </ViewportDialog>
  );
}
