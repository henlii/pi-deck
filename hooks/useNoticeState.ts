"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { noticeReducer, type NoticeType } from "@/lib/notice-reducer";
import type { SessionActivity } from "@/lib/session-activity";

/**
 * notice/activity 展示状态所有权（从 hooks/useAgentSession.ts 抽出，#17 D5c）。
 *
 * - notices：noticeReducer 的 visible 投影；transient 自动退出 / 退出动画由本 hook 的
 *   effect 驱动，重要消息常驻直到 dismiss。
 * - liveNoticeActivities：notify 持久活动的页内增量覆盖层，避免为了刷新一条 activity
 *   全量 loadSession，与运行中的 message_end / 流式 SSE 竞争并用磁盘旧快照覆盖较新消息。
 *   写入统一经 addLiveActivity（requestId 去重）与 clearLiveActivities（会话切换清空）。
 */

export type LiveNoticeActivity = {
  activity: SessionActivity;
  timestamp: number;
};

const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useNoticeState() {
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  // notify 持久活动的页内增量覆盖层：避免为了刷新一条 activity 全量 loadSession，
  // 与运行中的 message_end / 流式 SSE 竞争并用磁盘旧快照覆盖较新消息。
  const [liveNoticeActivities, setLiveNoticeActivities] = useState<LiveNoticeActivity[]>([]);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType; activityRecord?: boolean }) => {
    const message = notice.message.trim();
    if (!message) return;
    const type = notice.type ?? "info";
    const important = type === "warning" || type === "error";
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type,
        tier: important ? "important" : "transient",
        pinned: false,
        activityRecord: notice.activityRecord === true,
      },
    });
  }, []);

  /** 并入页内活动投影：requestId 去重（与磁盘快照带回后自动去重语义一致）。 */
  const addLiveActivity = useCallback((activity: SessionActivity) => {
    setLiveNoticeActivities((current) => (
      current.some((item) => item.activity.requestId === activity.requestId)
        ? current
        : [...current, { activity, timestamp: Date.now() }]
    ));
  }, []);

  /** 会话切换时清空页内活动投影（不写回磁盘；磁盘活动由 loadSession 重新加载）。 */
  const clearLiveActivities = useCallback(() => {
    setLiveNoticeActivities([]);
  }, []);

  const dismissNotice = useCallback((id: string) => {
    dispatchNotice({ type: "dismiss", id });
  }, []);

  const toggleNoticePin = useCallback((id: string) => {
    dispatchNotice({ type: "toggle_pin", id });
  }, []);

  // transient 自动退出与退出动画：优先处理 exiting 项（动画结束后 remove，腾出空位
  // 让 pending 回填）；否则最旧未 exiting 的 transient 达到可见时长后标记 exiting。
  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible.find((notice) => notice.tier === "transient" && !notice.exiting);
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_transient_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  return {
    notices: noticeState.visible,
    liveNoticeActivities,
    addNotice,
    addLiveActivity,
    clearLiveActivities,
    dismissNotice,
    toggleNoticePin,
  };
}
