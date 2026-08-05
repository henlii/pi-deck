"use client";

import { useId } from "react";
import type { TodoItem, TodoPriority, TodoStatus } from "@/lib/todo-parser";
import { useI18n } from "@/lib/i18n";

export interface TodoPanelProps {
  todos: readonly TodoItem[];
  collapsed: boolean;
  onToggle: () => void;
}

const STATUS_LABELS: Record<TodoStatus, "todo_pending" | "todo_inProgress" | "todo_completed"> = {
  pending: "todo_pending",
  in_progress: "todo_inProgress",
  completed: "todo_completed",
};

const PRIORITY_LABELS: Record<TodoPriority, "todo_high" | "todo_medium" | "todo_low"> = {
  high: "todo_high",
  medium: "todo_medium",
  low: "todo_low",
};

const PRIORITY_COLORS: Record<TodoPriority, string> = {
  high: "var(--status-danger)",
  medium: "var(--status-warning)",
  low: "var(--text-dim)",
};

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  const color = status === "completed"
    ? "var(--status-success)"
    : status === "in_progress"
      ? "var(--accent)"
      : "var(--text-dim)";

  return (
    <span
      className={status === "in_progress" ? "animate-[pulse_1.5s_ease-in-out_infinite]" : undefined}
      style={{ display: "inline-flex", flex: "0 0 14px", color }}
      aria-hidden="true"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="8" />
        {status === "completed" ? (
          <polyline points="8.5 12.5 11 15 15.8 9.6" />
        ) : status === "in_progress" ? (
          <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        ) : null}
      </svg>
    </span>
  );
}

export function TodoPanel({ todos, collapsed, onToggle }: TodoPanelProps) {
  const { t } = useI18n();
  const listId = useId();

  if (todos.length === 0) return null;

  const completedCount = todos.reduce(
    (count, todo) => count + (todo.status === "completed" ? 1 : 0),
    0,
  );
  const activeTodo = todos.find((todo) => todo.status === "in_progress") ?? null;
  const activeCount = todos.reduce(
    (count, todo) => count + (todo.status === "in_progress" ? 1 : 0),
    0,
  );
  const progress = Math.round((completedCount / todos.length) * 100);
  const allCompleted = completedCount === todos.length;

  return (
    <section
      aria-label={t("todo_toggle")}
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
        title={collapsed ? t("todo_expand") : t("todo_collapse")}
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
          {t("todo_toggle")}
        </span>

        <span
          style={{
            flexShrink: 0,
            color: allCompleted ? "var(--status-success)" : "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          {completedCount}/{todos.length}
        </span>

        <span
          role="progressbar"
          aria-label={t("todo_complete")}
          aria-valuemin={0}
          aria-valuemax={todos.length}
          aria-valuenow={completedCount}
          title={`${progress}% ${t("todo_complete")}`}
          style={{
            width: 46,
            height: 3,
            flexShrink: 0,
            overflow: "hidden",
            borderRadius: 999,
            background: "color-mix(in srgb, var(--border) 78%, transparent)",
          }}
        >
          <span
            style={{
              display: "block",
              width: `${progress}%`,
              height: "100%",
              borderRadius: "inherit",
              background: allCompleted ? "var(--status-success)" : "var(--accent)",
              transition: "width 0.2s ease",
            }}
          />
        </span>

        {activeTodo ? (
          <span
            className="hidden min-[520px]:flex"
            style={{ minWidth: 0, alignItems: "center", gap: 5, color: "var(--text-muted)", fontSize: 11 }}
          >
            <span
              className="animate-[pulse_1.5s_ease-in-out_infinite]"
              aria-hidden="true"
              style={{ width: 5, height: 5, flexShrink: 0, borderRadius: "50%", background: "var(--accent)" }}
            />
            <span style={{ flexShrink: 0, color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {activeCount > 1 ? `${activeCount} ${t("todo_active")}` : t("todo_active")}
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activeTodo.activeForm ?? activeTodo.content}
            </span>
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
      </button>

      {!collapsed && (
        <ul
          id={listId}
          style={{
            maxHeight: 224,
            margin: 0,
            padding: "3px 0 5px",
            overflowY: "auto",
            borderTop: "1px solid var(--border)",
            listStyle: "none",
          }}
        >
          {todos.map((todo) => {
            const completed = todo.status === "completed";
            return (
              <li
                key={todo.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "4px 10px",
                  color: completed ? "var(--text-dim)" : "var(--text)",
                  fontSize: 12,
                  lineHeight: 1.45,
                  opacity: completed ? 0.78 : 1,
                }}
              >
                <span style={{ paddingTop: 2 }}>
                  <TodoStatusIcon status={todo.status} />
                </span>
                <span className="sr-only">{t(STATUS_LABELS[todo.status])}: </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      display: "block",
                      overflowWrap: "anywhere",
                      textDecoration: completed ? "line-through" : "none",
                      textDecorationColor: "color-mix(in srgb, var(--text-dim) 60%, transparent)",
                    }}
                  >
                    {todo.content}
                  </span>
                  {todo.blockedBy && todo.blockedBy.length > 0 ? (
                    <span style={{ display: "block", marginTop: 1, color: "var(--text-dim)", fontSize: 10 }}>
                      {t("todo_blockedBy", { list: todo.blockedBy.join(", ") })}
                    </span>
                  ) : null}
                </span>
                {todo.priority ? (
                  <span
                    title={`${t(PRIORITY_LABELS[todo.priority])} ${t("todo_priority")}`}
                    style={{
                      flexShrink: 0,
                      paddingTop: 1,
                      color: PRIORITY_COLORS[todo.priority],
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      fontWeight: todo.priority === "high" ? 700 : 550,
                      letterSpacing: 0.35,
                      textTransform: "uppercase",
                    }}
                  >
                    {t(PRIORITY_LABELS[todo.priority])}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
