"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  THINKING_LEVELS,
  type AgentSettingsView,
  type AgentThinkingLevel,
  type QueueMode,
} from "@/lib/agent-settings";

interface AgentDefaultsConfigProps {
  cwd: string | null;
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  padding: "7px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  fontFamily: "var(--font-mono)",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "inherit",
  cursor: "pointer",
};

const QUEUE_OPTIONS: QueueMode[] = ["one-at-a-time", "all"];

type Draft = {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: AgentThinkingLevel | "";
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  compactionEnabled: boolean;
  retryEnabled: boolean;
};

function viewToDraft(view: AgentSettingsView): Draft {
  return {
    defaultProvider: view.defaultProvider ?? "",
    defaultModel: view.defaultModel ?? "",
    defaultThinkingLevel: view.defaultThinkingLevel ?? "",
    steeringMode: view.steeringMode,
    followUpMode: view.followUpMode,
    compactionEnabled: view.compaction.enabled,
    retryEnabled: view.retry.enabled,
  };
}

function draftDirty(draft: Draft, view: AgentSettingsView): boolean {
  const base = viewToDraft(view);
  return (
    draft.defaultProvider !== base.defaultProvider ||
    draft.defaultModel !== base.defaultModel ||
    draft.defaultThinkingLevel !== base.defaultThinkingLevel ||
    draft.steeringMode !== base.steeringMode ||
    draft.followUpMode !== base.followUpMode ||
    draft.compactionEnabled !== base.compactionEnabled ||
    draft.retryEnabled !== base.retryEnabled
  );
}

export function AgentDefaultsConfig({ cwd }: AgentDefaultsConfigProps) {
  const { t } = useI18n();
  const [data, setData] = useState<AgentSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      const qs = params.toString();
      const res = await fetch(`/api/agent-settings${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as AgentSettingsView;
      setData(body);
      setDraft(viewToDraft(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const save = useCallback(async () => {
    if (!draft || !data) return;
    setSaving(true);
    setError(null);
    setSavedFlash(false);
    try {
      const payload: Record<string, unknown> = {};
      if (cwd) payload.cwd = cwd;

      const base = viewToDraft(data);
      if (draft.defaultProvider !== base.defaultProvider) {
        payload.defaultProvider = draft.defaultProvider.trim() || null;
      }
      if (draft.defaultModel !== base.defaultModel) {
        payload.defaultModel = draft.defaultModel.trim() || null;
      }
      if (draft.defaultThinkingLevel !== base.defaultThinkingLevel) {
        payload.defaultThinkingLevel = draft.defaultThinkingLevel || null;
      }
      if (draft.steeringMode !== base.steeringMode) {
        payload.steeringMode = draft.steeringMode;
      }
      if (draft.followUpMode !== base.followUpMode) {
        payload.followUpMode = draft.followUpMode;
      }
      if (draft.compactionEnabled !== base.compactionEnabled) {
        payload.compactionEnabled = draft.compactionEnabled;
      }
      if (draft.retryEnabled !== base.retryEnabled) {
        payload.retryEnabled = draft.retryEnabled;
      }

      // 若只有 cwd，无变更
      const keys = Object.keys(payload).filter((k) => k !== "cwd");
      if (keys.length === 0) {
        setSaving(false);
        return;
      }

      const res = await fetch("/api/agent-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          errors?: Array<{ field: string; message: string }>;
        };
        const detail = body.errors?.map((e) => e.message).join("; ");
        throw new Error(detail || body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as AgentSettingsView;
      setData(body);
      setDraft(viewToDraft(body));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, data, cwd]);

  if (loading && !data) {
    return (
      <div style={{ padding: "18px 20px", fontSize: 12, color: "var(--text-muted)" }}>
        {t("common_loading")}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 10 }}>
          {t("defaults_loadFailed")}: {error}
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
          {t("defaults_retry")}
        </button>
      </div>
    );
  }

  if (!data || !draft) return null;

  const dirty = draftDirty(draft, data);

  return (
    <div style={{ padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 16 }}>
        {t("defaults_hint")}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 12 }}>
          {t("defaults_saveFailed")}: {error}
        </div>
      )}

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_modelSection")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={labelStyle}>{t("defaults_provider")}</div>
            <input
              value={draft.defaultProvider}
              onChange={(e) => setDraft({ ...draft, defaultProvider: e.target.value })}
              placeholder="e.g. new-api"
              style={inputStyle}
              spellCheck={false}
            />
          </div>
          <div>
            <div style={labelStyle}>{t("defaults_model")}</div>
            <input
              value={draft.defaultModel}
              onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
              placeholder="e.g. grok-4.5"
              style={inputStyle}
              spellCheck={false}
            />
          </div>
          <div>
            <div style={labelStyle}>{t("defaults_thinking")}</div>
            <select
              value={draft.defaultThinkingLevel}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultThinkingLevel: e.target.value as AgentThinkingLevel | "",
                })
              }
              style={selectStyle}
            >
              <option value="">{t("defaults_thinkingUnset")}</option>
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_queueSection")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={labelStyle}>{t("defaults_steeringMode")}</div>
            <select
              value={draft.steeringMode}
              onChange={(e) => setDraft({ ...draft, steeringMode: e.target.value as QueueMode })}
              style={selectStyle}
            >
              {QUEUE_OPTIONS.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={labelStyle}>{t("defaults_followUpMode")}</div>
            <select
              value={draft.followUpMode}
              onChange={(e) => setDraft({ ...draft, followUpMode: e.target.value as QueueMode })}
              style={selectStyle}
            >
              {QUEUE_OPTIONS.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_compactionSection")}</div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--text)",
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={draft.compactionEnabled}
            onChange={(e) => setDraft({ ...draft, compactionEnabled: e.target.checked })}
          />
          {t("defaults_compactionEnabled")}
        </label>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
          {t("defaults_compactionReadonly", {
            reserve: data.compaction.reserveTokens,
            keep: data.compaction.keepRecentTokens,
          })}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitleStyle}>{t("defaults_retrySection")}</div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--text)",
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={draft.retryEnabled}
            onChange={(e) => setDraft({ ...draft, retryEnabled: e.target.checked })}
          />
          {t("defaults_retryEnabled")}
        </label>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
          {t("defaults_retryReadonly", {
            max: data.retry.maxRetries,
            base: data.retry.baseDelayMs,
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          style={{
            minHeight: 32,
            padding: "0 14px",
            borderRadius: 7,
            border: `1px solid ${dirty ? "var(--accent)" : "var(--border)"}`,
            background: dirty ? "var(--accent)" : "var(--bg-panel)",
            color: dirty ? "#fff" : "var(--text-muted)",
            cursor: !dirty || saving ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            opacity: !dirty || saving ? 0.65 : 1,
          }}
        >
          {saving ? t("common_saving") : t("common_save")}
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading || saving}
          style={{
            minHeight: 32,
            padding: "0 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            cursor: loading || saving ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {t("defaults_refresh")}
        </button>
        {savedFlash && (
          <span style={{ fontSize: 12, color: "var(--accent)" }}>{t("common_saved")}</span>
        )}
      </div>
    </div>
  );
}
