export type FileBaseline = Readonly<{ mtimeMs: number; size: number }>;
export type SaveState = "idle" | "saving" | "conflict" | "error";

export type ExternalChange = Readonly<{
  content: string;
  baseline: FileBaseline;
}>;

export type FileBuffer = Readonly<{
  key: string;
  filePath: string;
  sourceSessionId: string | null;
  savedContent: string;
  content: string;
  baseline: FileBaseline;
  language: string;
  dirty: boolean;
  past: readonly string[];
  future: readonly string[];
  lastEditAt: number | null;
  revision: number;
  saveState: SaveState;
  saveRequestId: string | null;
  saveRequestRevision: number | null;
  error: string | null;
  externalChange: ExternalChange | null;
}>;

export type FileEditorState = Readonly<{ buffers: Readonly<Record<string, FileBuffer>> }>;

export type FileBufferInput = Readonly<{
  filePath: string;
  sourceSessionId?: string | null;
  content: string;
  baseline: FileBaseline;
  language: string;
}>;

export type FileEditorAction =
  | ({ type: "initialize" } & FileBufferInput)
  | ({ type: "edit"; key: string; content: string; at?: number; forceBoundary?: boolean })
  | ({ type: "undo" | "redo" | "discard" | "remove"; key: string })
  | ({ type: "markSaving"; key: string; requestId: string; requestRevision?: number })
  | ({ type: "saveSuccess"; key: string; requestId: string; requestRevision: number; savedContent: string; baseline: FileBaseline })
  | ({ type: "saveConflict"; key: string; requestId?: string; baseline?: FileBaseline; message?: string })
  | ({ type: "saveError"; key: string; requestId?: string; message: string });

export const EMPTY_FILE_EDITOR_STATE: FileEditorState = { buffers: {} };

export function makeFileBufferKey(filePath: string, sourceSessionId?: string | null): string {
  return JSON.stringify([filePath, sourceSessionId ?? null]);
}

function withDerived(buffer: FileBuffer, changes: Partial<FileBuffer>): FileBuffer {
  const next = { ...buffer, ...changes } as FileBuffer;
  return { ...next, dirty: next.content !== next.savedContent };
}

function get(state: FileEditorState, key: string): FileBuffer | undefined {
  return state.buffers[key];
}

function put(state: FileEditorState, buffer: FileBuffer): FileEditorState {
  return { ...state, buffers: { ...state.buffers, [buffer.key]: buffer } };
}

export function fileEditorReducer(state: FileEditorState = EMPTY_FILE_EDITOR_STATE, action: FileEditorAction): FileEditorState {
  if (action.type === "initialize") {
    const key = makeFileBufferKey(action.filePath, action.sourceSessionId);
    const existing = get(state, key);
    if (existing?.dirty) {
      return put(state, withDerived(existing, {
        externalChange: { content: action.content, baseline: action.baseline },
      }));
    }
    if (existing) {
      return put(state, withDerived(existing, {
        savedContent: action.content, content: action.content, baseline: action.baseline,
        language: action.language, past: [], future: [], lastEditAt: null,
        saveState: "idle", saveRequestId: null, saveRequestRevision: null,
        error: null, externalChange: null,
      }));
    }
    const buffer: FileBuffer = {
      key, filePath: action.filePath, sourceSessionId: action.sourceSessionId ?? null,
      savedContent: action.content, content: action.content, baseline: action.baseline,
      language: action.language, dirty: false, past: [], future: [], lastEditAt: null,
      revision: 0, saveState: "idle", saveRequestId: null, saveRequestRevision: null,
      error: null, externalChange: null,
    };
    return put(state, buffer);
  }

  const buffer = get(state, action.key);
  if (!buffer) return state;

  if (action.type === "edit") {
    if (action.content === buffer.content) return state;
    const at = action.at ?? Date.now();
    const merge = !action.forceBoundary && buffer.lastEditAt !== null && at - buffer.lastEditAt <= 500 && at >= buffer.lastEditAt;
    const past = merge ? buffer.past : [...buffer.past, buffer.content].slice(-50);
    return put(state, withDerived(buffer, {
      content: action.content, past, future: [], lastEditAt: at, revision: buffer.revision + 1,
      saveState: buffer.saveState === "error" ? "idle" : buffer.saveState, error: null,
    }));
  }

  if (action.type === "undo") {
    if (!buffer.past.length) return state;
    const previous = buffer.past[buffer.past.length - 1]!;
    return put(state, withDerived(buffer, { content: previous, past: buffer.past.slice(0, -1), future: [buffer.content, ...buffer.future].slice(0, 50), revision: buffer.revision + 1 }));
  }
  if (action.type === "redo") {
    if (!buffer.future.length) return state;
    const next = buffer.future[0]!;
    return put(state, withDerived(buffer, { content: next, past: [...buffer.past, buffer.content].slice(-50), future: buffer.future.slice(1), revision: buffer.revision + 1 }));
  }
  if (action.type === "discard") {
    return put(state, withDerived(buffer, { content: buffer.savedContent, past: [], future: [], lastEditAt: null, revision: buffer.revision + 1, saveState: "idle", saveRequestId: null, saveRequestRevision: null, error: null, externalChange: null }));
  }
  if (action.type === "remove") {
    const buffers = { ...state.buffers };
    delete buffers[action.key];
    return { ...state, buffers };
  }
  if (action.type === "markSaving") {
    const requestRevision = action.requestRevision ?? buffer.revision;
    return put(state, withDerived(buffer, { saveState: "saving", saveRequestId: action.requestId, saveRequestRevision: requestRevision, error: null }));
  }
  if ((action.type === "saveSuccess" || action.type === "saveConflict" || action.type === "saveError") && action.requestId && buffer.saveRequestId !== action.requestId) return state;
  if (action.type === "saveSuccess") {
    if (buffer.saveRequestRevision !== action.requestRevision) return state;
    return put(state, withDerived(buffer, {
      savedContent: action.savedContent, baseline: action.baseline, saveState: "idle",
      saveRequestId: null, saveRequestRevision: null, error: null, externalChange: null,
    }));
  }
  if (action.type === "saveConflict") {
    return put(state, withDerived(buffer, { saveState: "conflict", baseline: action.baseline ?? buffer.baseline, error: action.message ?? "文件已被外部修改" }));
  }
  if (action.type === "saveError") {
    return put(state, withDerived(buffer, { saveState: "error", error: action.message }));
  }
  return state;
}

export function getBuffer(state: FileEditorState, key: string): FileBuffer | undefined { return state.buffers[key]; }
export function hasDirtyBuffers(state: FileEditorState): boolean { return Object.values(state.buffers).some((buffer) => buffer.dirty); }
export function canUndo(buffer: FileBuffer | undefined): boolean { return Boolean(buffer?.past.length); }
export function canRedo(buffer: FileBuffer | undefined): boolean { return Boolean(buffer?.future.length); }
