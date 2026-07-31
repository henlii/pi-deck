"use client";

/**
 * 全局命令面板（Ctrl/Cmd+K，OpenChamber CommandPalette 风格）：
 * - 会话切换（fuzzy 匹配名称/首消息/路径）
 * - 新建会话（当前项目）
 * - 文件搜索（/api/file-index，2+ 字符触发）
 * - 设置页导航（模型/技能/插件/记忆）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { SessionInfo } from "@/lib/types";

type SessionHit = { id: string; title: string; cwd: string; session: SessionInfo };
type FileHit = { path: string; name: string };
type SettingsPage = "models" | "skills" | "plugins" | "memory";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
  onOpenFile: (filePath: string, fileName: string) => void;
  onOpenSettings: (page: SettingsPage) => void;
  onToggleTheme: () => void;
  cwd: string | null;
};

function scoreFuzzy(query: string, ...fields: string[]): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  let best = -1;
  for (const field of fields) {
    const text = field.toLowerCase();
    const idx = text.indexOf(q);
    if (idx === -1) continue;
    const score = 1000 - idx * 2 - (text.length > q.length ? 1 : 0);
    if (score > best) best = score;
  }
  if (best >= 0) return best;
  // 子序列匹配（OpenChamber fuzzy 简化版）
  const i = 0;
  for (const ch of q) {
    const found = fields.some((f) => {
      const fi = f.toLowerCase().indexOf(ch, i >= 0 ? 0 : 0);
      return fi >= 0;
    });
    if (!found) return -1;
  }
  return 1;
}

export function CommandPalette({ open, onClose, onSelectSession, onNewSession, onOpenFile, onOpenSettings, onToggleTheme, cwd }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionHit[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeqRef = useRef(0);

  // 打开时加载会话索引并聚焦
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/sessions");
        const data = await res.json() as { sessions?: Array<{ id: string; name?: string; firstMessage?: string; cwd?: string }> };
        const hits: SessionHit[] = (data.sessions ?? []).map((s) => ({
          id: s.id,
          title: s.name || s.firstMessage || s.id.slice(0, 12),
          cwd: s.cwd ?? "",
          session: s as SessionInfo,
        }));
        if (!cancelled) setSessions(hits);
      } catch {
        // 静默
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // 文件搜索（2+ 字符防抖）
  useEffect(() => {
    if (!open || !cwd || query.trim().length < 2) {
      setFiles([]);
      return;
    }
    const seq = ++searchSeqRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        setSearchingFiles(true);
        try {
          const params = new URLSearchParams({ cwd, q: query.trim() });
          const res = await fetch(`/api/file-index?${params.toString()}`);
          const data = await res.json() as { files?: string[] };
          const hits: FileHit[] = (data.files ?? []).slice(0, 12).map((p) => ({
            path: p,
            name: p.split("/").pop() ?? p,
          }));
          if (seq === searchSeqRef.current) setFiles(hits);
        } catch {
          if (seq === searchSeqRef.current) setFiles([]);
        } finally {
          if (seq === searchSeqRef.current) setSearchingFiles(false);
        }
      })();
    }, 180);
    return () => clearTimeout(timer);
  }, [open, cwd, query]);

  const sessionHits = useMemo(() => {
    const q = query.trim();
    if (!q) return sessions.slice(0, 8);
    return sessions
      .map((s) => ({ s, score: scoreFuzzy(q, s.title, s.cwd) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.s);
  }, [sessions, query]);

  const items: Array<{ key: string; kind: "session" | "file" | "action"; title: string; subtitle?: string; run: () => void }> = useMemo(() => {
    const q = query.trim();
    const list: Array<{ key: string; kind: "session" | "file" | "action"; title: string; subtitle?: string; run: () => void }> = [];
    // 操作项始终参与搜索（OpenChamber 语义：命令面板按查询过滤所有分组）。
    const actions: Array<{ key: string; kind: "action"; title: string; run: () => void }> = [
      { key: "new", kind: "action", title: t("palette_newSession"), run: onNewSession },
      { key: "theme", kind: "action", title: t("palette_toggleTheme"), run: onToggleTheme },
      { key: "set-models", kind: "action", title: t("palette_settingsModels"), run: () => onOpenSettings("models") },
      { key: "set-skills", kind: "action", title: t("palette_settingsSkills"), run: () => onOpenSettings("skills") },
      { key: "set-plugins", kind: "action", title: t("palette_settingsPlugins"), run: () => onOpenSettings("plugins") },
      { key: "set-memory", kind: "action", title: t("palette_settingsMemory"), run: () => onOpenSettings("memory") },
    ];
    if (!q) {
      list.push(...actions);
    } else {
      list.push(...actions.filter((a) => scoreFuzzy(q, a.title) >= 0));
    }
    for (const s of sessionHits) {
      list.push({ key: `s:${s.id}`, kind: "session", title: s.title, subtitle: s.cwd, run: () => onSelectSession(s.session) });
    }
    for (const f of files) {
      list.push({ key: `f:${f.path}`, kind: "file", title: f.name, subtitle: f.path, run: () => onOpenFile(f.path, f.name) });
    }
    return list;
  }, [sessionHits, files, query, t, onNewSession, onSelectSession, onOpenFile, onOpenSettings, onToggleTheme]);

  // 键盘导航
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[Math.min(activeIndex, items.length - 1)];
        if (item) {
          onClose();
          item.run();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, items, activeIndex, onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("palette_title")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        padding: "12vh 20px 20px",
        background: "rgba(0,0,0,0.28)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(620px, 100%)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette_placeholder")}
            aria-label={t("palette_title")}
            style={{
              flex: 1,
              minWidth: 0,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
          {searchingFiles && (
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("palette_searching")}</span>
          )}
        </div>
        <div style={{ overflowY: "auto", padding: 6, flex: 1 }}>
          {items.length === 0 && (
            <div style={{ padding: "14px 12px", fontSize: 12, color: "var(--text-dim)" }}>
              {t("palette_noResults")}
            </div>
          )}
          {items.map((item, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={item.key}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onClose();
                  item.run();
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  width: "100%",
                  padding: "7px 10px",
                  borderRadius: 8,
                  border: "none",
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12.5,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, maxWidth: "100%" }}>
                  {item.kind === "session" && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  )}
                  {item.kind === "file" && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  )}
                  {item.kind === "action" && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 10 4 15 9 20" />
                      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                    </svg>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
                </span>
                {item.subtitle && (
                  <span style={{ fontSize: 10.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%", paddingLeft: 18 }}>
                    {item.subtitle}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
