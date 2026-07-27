"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ViewportDialog } from "./ui/ViewportDialog";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { useI18n, type Locale } from "@/lib/i18n";
import type { ProjectTrustDecisionList, ProjectTrustStatus } from "@/lib/project-trust-model";
import {
  SETTINGS_PAGE_STORAGE_KEY,
  getSettingsPages,
  nextMobileSettingsView,
  parseStoredSettingsPage,
  type MobileSettingsView,
  type SettingsPageId,
} from "./settings-nav";

interface SettingsViewProps {
  /** 活动项目目录；Skills/Plugins 需要，Appearance/Models 不需要 */
  cwd: string | null;
  sessionId: string | null;
  onClose: () => void;
  /** Models 保存后刷新聊天区的模型列表 */
  onModelsChanged?: () => void;
  /** Plugins reload 后需要重建会话（沿用旧 AppShell 行为） */
  onPluginsReloaded?: () => void;
}

/** 设置页 id → 本地化标签 key：nav 按钮、对话框标题与 section aria-label 共用同一映射。 */
function settingsPageLabelKey(id: SettingsPageId) {
  return id === "appearance"
    ? "common_appearance"
    : id === "models"
      ? "common_models"
      : id === "skills"
        ? "common_skills"
        : id === "plugins"
          ? "common_plugins"
          : "common_trust";
}

function readInitialPage(): SettingsPageId {
  if (typeof window === "undefined") return parseStoredSettingsPage(null);
  try {
    return parseStoredSettingsPage(window.localStorage.getItem(SETTINGS_PAGE_STORAGE_KEY));
  } catch {
    return parseStoredSettingsPage(null);
  }
}

/** 无 cwd 页面的具体提示：保留导航项，内容区指引用户先选择项目。 */
function NeedsProjectHint({ hint }: { hint: "skills" | "plugins" }) {
  const { t } = useI18n();
  void hint;
  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: 24,
      textAlign: "center",
    }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{t("common_selectProject")}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, maxWidth: 380 }}>{t("common_selectProjectHint")}</div>
    </div>
  );
}

/** 明确的二选一分段控件（主题/语言共用）：不用 toggle，选中态一目了然。 */
function SegmentedChoice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{label}</div>
      <div
        role="group"
        aria-label={label}
        style={{
          display: "flex",
          gap: 2,
          padding: 2,
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--bg-panel)",
          width: "fit-content",
          maxWidth: "100%",
        }}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              style={{
                minWidth: 96,
                height: 30,
                padding: "0 14px",
                border: "none",
                borderRadius: 7,
                background: active ? "var(--bg-selected)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
                fontWeight: active ? 600 : 400,
                fontSize: 12.5,
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "background 0.12s, color 0.12s",
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AppearancePage() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();
  return (
    <div style={{ padding: "18px 20px" }}>
      <SegmentedChoice
        label={t("appearance_theme")}
        options={[
          { value: "light", label: t("appearance_light") },
          { value: "dark", label: t("appearance_dark") },
        ]}
        value={theme}
        onChange={(next) => setTheme(next)}
      />
      <SegmentedChoice<Locale>
        label={t("appearance_language")}
        options={[
          { value: "en", label: "English" },
          { value: "zh-CN", label: "简体中文" },
        ]}
        value={locale}
        onChange={(next) => setLocale(next)}
      />
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 420 }}>
        {t("appearance_coverage")}
      </div>
    </div>
  );
}

/**
 * 项目信任只读视图：展示 defaultProjectTrust 回退行为、当前项目的生效状态，
 * 以及 ~/.pi/agent/trust.json 中已保存的全部决策。修改入口只在侧栏项目行，
 * 避免同一个写操作出现在两处。
 */
function TrustPage({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [list, setList] = useState<ProjectTrustDecisionList | null>(null);
  const [current, setCurrent] = useState<ProjectTrustStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/project-trust");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ProjectTrustDecisionList;
        if (!cancelled) setList(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // cwd 切换时先清空，避免在 GET 返回前残留旧项目状态。
    setCurrent(null);
    if (!cwd) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { statuses?: { cwd: string; status: ProjectTrustStatus }[] };
        if (!cancelled) setCurrent(data.statuses?.[0]?.status ?? null);
      } catch {
        // 当前项目状态读不到时只隐藏该区块，不影响下方决策列表。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const defaultLabel =
    list?.defaultProjectTrust === "always"
      ? t("trust_defaultAlways")
      : list?.defaultProjectTrust === "never"
        ? t("trust_defaultNever")
        : t("trust_defaultAsk");

  const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 };
  const mono: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11.5, wordBreak: "break-all" };

  return (
    <div style={{ padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 18 }}>
        {t("trust_appliesNextSession")}
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={sectionTitle}>{t("trust_defaultLabel")}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {list ? defaultLabel : failed ? t("trust_loadFailed") : t("common_loading")}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{t("trust_defaultHint")}</div>
      </div>

      {current && (
        <div style={{ marginBottom: 22 }}>
          <div style={sectionTitle}>{t("trust_currentProject")}</div>
          <div style={{ ...mono, color: "var(--text-muted)" }}>{current.cwd}</div>
          <div style={{ fontSize: 12.5, color: "var(--text)", marginTop: 6 }}>
            {!current.requiresTrust
              ? t("trust_noGate")
              : current.needsDecision
                ? t("trust_badgeUndecidedTitle")
                : current.trusted
                  ? t("trust_badgeTrustedTitle")
                  : t("trust_badgeUntrustedTitle")}
          </div>
          {current.inherited && current.storedPath && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              {t("trust_inheritedFrom", { path: current.storedPath })}
            </div>
          )}
        </div>
      )}

      <div style={sectionTitle}>{t("trust_decisionsTitle")}</div>
      {failed || list?.error ? (
        <div style={{ fontSize: 12, color: "#dc2626" }}>
          {t("trust_loadFailed")}
          {list?.error ? `: ${list.error}` : ""}
        </div>
      ) : !list ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("common_loading")}</div>
      ) : list.decisions.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("trust_decisionsEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {list.decisions.map((entry) => (
            <div
              key={entry.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-panel)",
              }}
            >
              <span style={{ ...mono, flex: 1, color: "var(--text)" }}>{entry.path}</span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10.5,
                  padding: "1px 7px",
                  borderRadius: 999,
                  border: `1px solid ${entry.decision ? "var(--border)" : "#dc262655"}`,
                  color: entry.decision ? "var(--text-dim)" : "#dc2626",
                }}
              >
                {entry.decision ? t("trust_decisionTrusted") : t("trust_decisionDistrusted")}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12, lineHeight: 1.6 }}>{t("trust_readOnlyHint")}</div>
    </div>
  );
}

export function SettingsView({ cwd, sessionId, onClose, onModelsChanged, onPluginsReloaded }: SettingsViewProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [activePage, setActivePage] = useState<SettingsPageId>(readInitialPage);
  // 移动端「导航首页 → 页面内容」：null 表示导航首页；桌面端始终双栏。
  const [mobileView, setMobileView] = useState<MobileSettingsView>({ page: null });

  // 记忆最近页（localStorage 可安全失败）。
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_PAGE_STORAGE_KEY, JSON.stringify(activePage));
    } catch {
      // 隐私模式或禁用存储不影响本次使用。
    }
  }, [activePage]);

  const hasCwd = Boolean(cwd);
  const pages = useMemo(() => getSettingsPages(hasCwd), [hasCwd]);
  const activePageInfo = pages.find((page) => page.id === activePage) ?? pages[0];

  const selectPage = useCallback((page: SettingsPageId) => {
    setActivePage(page);
    setMobileView((current) => nextMobileSettingsView(current, { type: "select", page }));
  }, []);
  const goMobileHome = useCallback(() => {
    setMobileView((current) => nextMobileSettingsView(current, { type: "back" }));
  }, []);

  const renderPageContent = () => {
    if (!activePageInfo.available) {
      return <NeedsProjectHint hint={activePageInfo.unavailableHint!} />;
    }
    switch (activePageInfo.id) {
      case "appearance":
        return <AppearancePage />;
      case "models":
        return <ModelsConfig embedded onClose={onModelsChanged ?? onClose} />;
      case "skills":
        return <SkillsConfig embedded cwd={cwd!} onClose={onClose} />;
      case "plugins":
        return <PluginsConfig embedded cwd={cwd!} sessionId={sessionId} onClose={onClose} onReloaded={onPluginsReloaded} />;
      case "trust":
        return <TrustPage cwd={cwd} />;
    }
  };

  const navList = (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: isMobile ? "10px 10px" : "10px 8px" }}>
      {pages.map((page) => {
        const active = page.id === activePageInfo.id;
        return (
          <button
            key={page.id}
            type="button"
            aria-current={!isMobile && active ? "page" : undefined}
            onClick={() => selectPage(page.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              minHeight: isMobile ? 44 : 34,
              padding: isMobile ? "0 12px" : "0 10px",
              border: "none",
              borderRadius: 7,
              background: !isMobile && active ? "var(--bg-selected)" : "transparent",
              color: !isMobile && active ? "var(--text)" : "var(--text-muted)",
              fontWeight: !isMobile && active ? 600 : 400,
              fontSize: 13,
              textAlign: "left",
              cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t(page.label === "appearance" ? "common_appearance" : page.label === "models" ? "common_models" : page.label === "skills" ? "common_skills" : "common_plugins")}
            </span>
            {!page.available && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{t("common_needsProject")}</span>
            )}
            {isMobile && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );

  // 移动端进入页面时，标题栏左侧提供明确的 Back（ARIA 可达）。
  const mobileBackAction = isMobile && mobileView.page !== null ? (
    <button
      type="button"
      onClick={goMobileHome}
      aria-label={t("common_back")}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        minHeight: 32,
        padding: "0 8px",
        background: "none",
        border: "none",
        borderRadius: 7,
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {t("common_back")}
    </button>
  ) : undefined;

  return (
    <ViewportDialog
      open
      onClose={onClose}
      closeLabel={t("dialog_close")}
      title={isMobile && mobileView.page !== null ? t(activePageInfo.label === "appearance" ? "common_appearance" : activePageInfo.label === "models" ? "common_models" : activePageInfo.label === "skills" ? "common_skills" : "common_plugins") : t("common_settings")}
      width={920}
      zIndex={1000}
      headerActions={mobileBackAction}
      contentPadding="0"
    >
      <div style={{ display: "flex", height: "min(72dvh, 660px)", minHeight: 0 }}>
        {isMobile ? (
          mobileView.page === null ? (
            <nav aria-label={t("common_settings")} style={{ flex: 1, overflowY: "auto" }}>
              {navList}
            </nav>
          ) : (
            <section aria-label={t(settingsPageLabelKey(activePageInfo.id))} style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
                {renderPageContent()}
              </div>
            </section>
          )
        ) : (
          <>
            <nav
              aria-label={t("common_settings")}
              style={{
                width: 190,
                flexShrink: 0,
                borderRight: "1px solid var(--border)",
                background: "var(--bg-panel)",
                overflowY: "auto",
              }}
            >
              {navList}
            </nav>
            <section aria-label={t(settingsPageLabelKey(activePageInfo.id))} style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
                {renderPageContent()}
              </div>
            </section>
          </>
        )}
      </div>
    </ViewportDialog>
  );
}
