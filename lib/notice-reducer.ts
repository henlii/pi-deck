/**
 * 通知状态机纯逻辑（从 hooks/useAgentSession.ts 抽出，无 React 依赖）。
 *
 * 行为语义（与抽离前逐字节一致）：
 * - transient 轻提示：visible 未满 MAX_NOTICES 直接展示；满员时最旧未 exiting 的
 *   transient 标记 exiting（腾位动画），新条进 pending 排队。
 * - important 重要消息：总是直接 visible，不参与 transient 计数与排队。
 * - pending 按插入顺序（FIFO）在 visible 出现空位时回填。
 */

export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  /** 轻提示自动退出；重要消息常驻，直到用户关闭。 */
  tier: "transient" | "important";
  /** 固定只适用于重要消息；固定项始终排在未固定重要消息之前。 */
  pinned: boolean;
  /** warning/error 会尝试写入 pidance.activity，可由通知历史恢复查看。 */
  activityRecord: boolean;
  exiting?: boolean;
};

export type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

export type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "dismiss"; id: string }
  | { type: "toggle_pin"; id: string }
  | { type: "mark_oldest_transient_exiting" }
  | { type: "remove"; id: string };

export const MAX_NOTICES = 5;

function markOldestTransientNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => notice.tier === "transient" && !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.filter((notice) => notice.tier === "transient").length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestTransientNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

export function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (action.notice.tier === "important") {
        return { ...state, visible: [...state.visible, action.notice] };
      }
      const transientCount = state.visible.filter((notice) => notice.tier === "transient").length;
      const transientExiting = state.visible.some((notice) => notice.tier === "transient" && notice.exiting);
      if (transientExiting || transientCount >= MAX_NOTICES) {
        return {
          visible: transientExiting
            ? state.visible
            : markOldestTransientNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "dismiss":
      return {
        ...state,
        visible: state.visible.map((notice) => notice.id === action.id ? { ...notice, exiting: true } : notice),
        pending: state.pending.filter((notice) => notice.id !== action.id),
      };
    case "toggle_pin":
      return {
        ...state,
        visible: state.visible.map((notice) => notice.id === action.id && notice.tier === "important"
          ? { ...notice, pinned: !notice.pinned }
          : notice),
      };
    case "mark_oldest_transient_exiting":
      return { ...state, visible: markOldestTransientNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}
