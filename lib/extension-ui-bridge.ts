import type {
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
} from "./types";

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type ExtensionUiNoticeType = "info" | "success" | "warning" | "error";

export interface ExtensionUiState {
  dialog: ExtensionUiDialogRequest | null;
  customUi: ExtensionUiCustomRequest | null;
  statuses: ExtensionStatusItem[];
  widgets: ExtensionWidgetItem[];
}

export type ExtensionUiEffect =
  | { type: "notice"; id: string; message: string; noticeType: ExtensionUiNoticeType }
  | { type: "setTitle"; title: string }
  | { type: "insertText"; text: string };

export function applyExtensionUiRequest(
  state: ExtensionUiState,
  request: ExtensionUiRequest,
): { state: ExtensionUiState; effects: ExtensionUiEffect[] } {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return { state: { ...state, dialog: request }, effects: [] };
    case "notify":
      return {
        state,
        effects: [{ type: "notice", id: request.id, message: request.message, noticeType: request.notifyType ?? "info" }],
      };
    case "setStatus": {
      const index = state.statuses.findIndex((item) => item.key === request.statusKey);
      if (!request.statusText) {
        if (index === -1) return { state, effects: [] };
        return { state: { ...state, statuses: state.statuses.filter((item) => item.key !== request.statusKey) }, effects: [] };
      }
      const item = { key: request.statusKey, text: request.statusText };
      if (index !== -1 && state.statuses[index].text === item.text) return { state, effects: [] };
      const statuses = [...state.statuses.filter((current) => current.key !== request.statusKey), item];
      return { state: { ...state, statuses }, effects: [] };
    }
    case "setWidget": {
      const index = state.widgets.findIndex((item) => item.key === request.widgetKey);
      if (!request.widgetLines) {
        if (index === -1) return { state, effects: [] };
        return { state: { ...state, widgets: state.widgets.filter((item) => item.key !== request.widgetKey) }, effects: [] };
      }
      const item = {
        key: request.widgetKey,
        lines: request.widgetLines,
        placement: request.widgetPlacement ?? "aboveEditor",
      } as ExtensionWidgetItem;
      const current = index === -1 ? null : state.widgets[index];
      if (current && current.placement === item.placement && current.lines === item.lines) return { state, effects: [] };
      const widgets = [...state.widgets.filter((existing) => existing.key !== request.widgetKey), item];
      return { state: { ...state, widgets }, effects: [] };
    }
    case "setTitle":
      return request.title
        ? { state, effects: [{ type: "setTitle", title: request.title }] }
        : { state, effects: [] };
    case "set_editor_text":
      return { state, effects: [{ type: "insertText", text: request.text }] };
    case "custom":
      if (request.closed) {
        return request.id === state.customUi?.id
          ? { state: { ...state, customUi: null }, effects: [] }
          : { state, effects: [] };
      }
      return { state: { ...state, customUi: request }, effects: [] };
  }
}
