import type {
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
} from "./types";

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type ExtensionUiInlineRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" }>;
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type ExtensionUiNoticeType = "info" | "success" | "warning" | "error";

export interface ExtensionUiState {
  dialog: ExtensionUiDialogRequest | null;
  inlineRequest?: ExtensionUiInlineRequest | null;
  customUi: ExtensionUiCustomRequest | null;
  statuses: ExtensionStatusItem[];
  widgets: ExtensionWidgetItem[];
}

export function isShortSelectOptions(options: readonly string[]): boolean {
  if (options.length < 1 || options.length > 8) return false;
  const trimmedOptions = options.map((option) => option.trim());
  return trimmedOptions.every((option) => option.length > 0 && option.length <= 80)
    && trimmedOptions.reduce((total, option) => total + option.length, 0) <= 320;
}

export function isShortSelectRequest(request: ExtensionUiRequest): request is Extract<ExtensionUiRequest, { method: "select" }> {
  return request.method === "select" && isShortSelectOptions(request.options);
}

export function clearExtensionUiRequest(state: ExtensionUiState, requestId: string): ExtensionUiState {
  if (state.inlineRequest?.id === requestId) return { ...state, inlineRequest: null };
  if (state.dialog?.id === requestId) return { ...state, dialog: null };
  return state;
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
      if (isShortSelectRequest(request)) {
        return { state: { ...state, dialog: null, inlineRequest: request }, effects: [] };
      }
      return { state: { ...state, dialog: request, inlineRequest: null }, effects: [] };
    case "confirm":
    case "input":
      return { state: { ...state, dialog: null, inlineRequest: request }, effects: [] };
    case "editor":
      return { state: { ...state, dialog: request, inlineRequest: null }, effects: [] };
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
