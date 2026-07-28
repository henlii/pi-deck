"use client";

import { useRef, useState } from "react";
import type { ExtensionUiInlineRequest } from "@/lib/extension-ui-bridge";
import { useI18n } from "@/lib/i18n";
import { MarkdownBody } from "./MarkdownBody";

export type ExtensionUiInlineResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface InlineExtensionCardProps {
  request: ExtensionUiInlineRequest;
  disabled?: boolean;
  onRespond: (response: ExtensionUiInlineResponse) => void;
}

function requestHasExpired(request: ExtensionUiInlineRequest): boolean {
  return typeof request.expiresAt === "number"
    && Number.isFinite(request.expiresAt)
    && request.expiresAt <= Date.now();
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function InlineExtensionCard({ request, disabled = false, onRespond }: InlineExtensionCardProps) {
  const { t } = useI18n();
  const respondedRequestRef = useRef<string | null>(null);
  const [respondedRequestId, setRespondedRequestId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ requestId: string; value: string }>({
    requestId: request.id,
    value: "",
  });

  const value = draft.requestId === request.id ? draft.value : "";
  const expired = requestHasExpired(request);
  const responded = respondedRequestId === request.id;
  const inert = disabled || expired || responded;

  const respondOnce = (response: ExtensionUiInlineResponse) => {
    if (disabled || respondedRequestRef.current === request.id || requestHasExpired(request)) return;

    respondedRequestRef.current = request.id;
    setRespondedRequestId(request.id);
    onRespond(response);
  };

  const setValue = (nextValue: string) => {
    setDraft({ requestId: request.id, value: nextValue });
  };

  const statusMessage = expired
    ? t("extension_expired")
    : disabled
      ? t("extension_waitingEnded")
      : responded
        ? t("extension_responseSent")
        : null;

  return (
    <section
      aria-label={`${t("extension_extension")}: ${request.title}`}
      style={{
        margin: "8px 0",
        overflow: "hidden",
        border: "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))",
        borderRadius: 9,
        background: "color-mix(in srgb, var(--accent) 3%, var(--bg-panel))",
        boxShadow: "0 1px 0 color-mix(in srgb, var(--border) 45%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          minHeight: 32,
          alignItems: "center",
          gap: 8,
          padding: "5px 8px 5px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: "50%",
            background: inert ? "var(--text-dim)" : "var(--accent)",
          }}
        />
        <div
          title={request.title}
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            color: "var(--text)",
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          <MarkdownBody className="markdown-body--extension">{request.title}</MarkdownBody>
        </div>
        <span
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            letterSpacing: 0.35,
            textTransform: "uppercase",
          }}
        >
          {t("extension_extension")} · {request.method}
        </span>
        {request.method === "select" && (
          <button
            type="button"
            className="sidebar-icon-btn sidebar-icon-btn--danger"
            disabled={inert}
            title={t("extension_cancel")}
            aria-label={t("extension_cancel")}
            onClick={() => respondOnce({ cancelled: true })}
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <div style={{ padding: "8px 10px" }}>
        {request.method === "confirm" && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div
              style={{
                minWidth: 0,
                flex: 1,
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}
            >
              <MarkdownBody className="markdown-body--extension">{request.message}</MarkdownBody>
            </div>
            <div style={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 5 }}>
              <button
                type="button"
                className="sidebar-icon-btn sidebar-icon-btn--danger"
                disabled={inert}
                title={t("extension_cancel")}
                aria-label={t("extension_cancel")}
                onClick={() => respondOnce({ cancelled: true })}
              >
                <CloseIcon />
              </button>
              <button
                type="button"
                className="sidebar-icon-btn"
                disabled={inert}
                title={t("extension_confirm")}
                aria-label={t("extension_confirm")}
                onClick={() => respondOnce({ confirmed: true })}
                style={{ color: "var(--accent)" }}
              >
                <CheckIcon />
              </button>
            </div>
          </div>
        )}

        {request.method === "input" && (
          <div style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 5 }}>
            <input
              value={value}
              disabled={inert}
              placeholder={request.placeholder}
              aria-label={request.title}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  respondOnce({ value });
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (value.length > 0) setValue("");
                  else event.currentTarget.blur();
                }
              }}
              style={{
                minWidth: 0,
                height: 28,
                flex: 1,
                padding: "0 8px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                outline: "none",
                background: "var(--bg)",
                color: "var(--text)",
                font: "inherit",
                fontSize: 12,
              }}
            />
            <button
              type="button"
              className="sidebar-icon-btn"
              disabled={inert}
              title={t("extension_submit")}
              aria-label={t("extension_submit")}
              onClick={() => respondOnce({ value })}
              style={{ color: "var(--accent)" }}
            >
              <CheckIcon />
            </button>
            <button
              type="button"
              className="sidebar-icon-btn sidebar-icon-btn--danger"
              disabled={inert}
              title={t("extension_cancel")}
              aria-label={t("extension_cancel")}
              onClick={() => respondOnce({ cancelled: true })}
            >
              <CloseIcon />
            </button>
          </div>
        )}

        {request.method === "select" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {request.options.map((option, index) => (
              <button
                key={`${index}-${option}`}
                type="button"
                disabled={inert}
                title={option}
                onClick={() => respondOnce({ value: option })}
                onMouseEnter={(event) => {
                  if (!inert) event.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "var(--bg)";
                }}
                style={{
                  maxWidth: "100%",
                  minHeight: 26,
                  padding: "3px 9px",
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg)",
                  color: inert ? "var(--text-dim)" : "var(--text)",
                  cursor: inert ? "not-allowed" : "pointer",
                  font: "inherit",
                  fontSize: 12,
                  lineHeight: 1.35,
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "5px 10px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
            color: expired ? "#d97706" : "var(--text-dim)",
            fontSize: 10,
            lineHeight: 1.4,
          }}
        >
          {statusMessage}
        </div>
      )}
    </section>
  );
}
