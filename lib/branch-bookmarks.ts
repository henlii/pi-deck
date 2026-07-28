import type { SessionTreeNode } from "@/lib/types";

/** 分支书签 label 的 UI 上限；与后端 rpc-manager 的 BRANCH_LABEL_MAX_LENGTH 保持一致。 */
export const BRANCH_LABEL_MAX_LENGTH = 120;

/**
 * 书签输入归一化：trim 后为空表示清除；超长拒绝（UI 另有 maxLength 前置约束，
 * 这里兜底覆盖粘贴/程序化调用）。
 */
export type BranchLabelInput =
  | { kind: "set"; label: string }
  | { kind: "clear" }
  | { kind: "tooLong"; maxLength: number };

export function normalizeBranchLabelInput(raw: string | undefined | null): BranchLabelInput {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length > BRANCH_LABEL_MAX_LENGTH) {
    return { kind: "tooLong", maxLength: BRANCH_LABEL_MAX_LENGTH };
  }
  return trimmed === "" ? { kind: "clear" } : { kind: "set", label: trimmed };
}

/**
 * 构造 set_branch_label 命令。清除必须发送空字符串而不是 undefined/null：
 * JSON 序列化会丢弃 undefined 键，后端也拒绝 null；空串经后端 trim 后即为清除。
 * 超长返回 null（调用方不得发送）。
 */
export function buildSetBranchLabelCommand(
  targetId: string,
  rawLabel: string | undefined | null,
): { type: "set_branch_label"; targetId: string; label: string } | null {
  const input = normalizeBranchLabelInput(rawLabel);
  if (input.kind === "tooLong") return null;
  return {
    type: "set_branch_label",
    targetId,
    label: input.kind === "set" ? input.label : "",
  };
}

/** 分支切换的三种选择：直接跳转 / 默认摘要 / 自定义焦点摘要。 */
export type BranchSwitchChoice =
  | { mode: "direct" }
  | { mode: "summary" }
  | { mode: "custom"; focus: string };

/**
 * 构造带选项的 navigate_tree 命令。custom 模式焦点 trim 后必须非空，
 * 否则返回 null（调用方不得发送，UI 同时禁用提交）。
 */
export function buildBranchSwitchCommand(
  targetId: string,
  choice: BranchSwitchChoice,
): Record<string, unknown> | null {
  switch (choice.mode) {
    case "direct":
      return { type: "navigate_tree", targetId, summarize: false };
    case "summary":
      return { type: "navigate_tree", targetId, summarize: true };
    case "custom": {
      const focus = choice.focus.trim();
      if (!focus) return null;
      return { type: "navigate_tree", targetId, summarize: true, customInstructions: focus };
    }
  }
}

/** 节点书签文案：label trim 后非空才是有效书签；否则回退消息摘要显示。 */
export function getBranchNodeBookmark(label: string | undefined | null): string | null {
  const trimmed = label?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** 客户端链压缩门禁：带书签的节点必须保持可见，不能被并入链尾（与服务端投影规则一致）。 */
export function canCompressChainNode(node: { label?: string }): boolean {
  return getBranchNodeBookmark(node.label) === null;
}

/** 树中是否存在任何带书签的节点（线性会话有书签时也应渲染树）。 */
export function treeHasBookmarks(nodes: SessionTreeNode[]): boolean {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (getBranchNodeBookmark(node.label) !== null) return true;
    stack.push(...node.children);
  }
  return false;
}

/** 在树中查找 entryId（含被压缩 id）对应节点的书签文案；无则 null。 */
export function findBranchLabelByEntryId(
  nodes: SessionTreeNode[],
  entryId: string | null | undefined,
): string | null {
  if (!entryId) return null;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.entry.id === entryId || node.compressedEntryIds?.includes(entryId)) {
      return getBranchNodeBookmark(node.label);
    }
    stack.push(...node.children);
  }
  return null;
}

/** 分支写操作门禁：只读会话与分支操作进行中都不允许。 */
export type BranchActionGate =
  | { allowed: true }
  | { allowed: false; reason: "readOnly" | "busy" };

export function gateBranchAction(input: { readOnly: boolean; busy: boolean }): BranchActionGate {
  if (input.readOnly) return { allowed: false, reason: "readOnly" };
  if (input.busy) return { allowed: false, reason: "busy" };
  return { allowed: true };
}

/**
 * 从 branch_summary CustomMessage.details 提取文件元数据。
 * details 形状为 { fromId, details: { readFiles, modifiedFiles }, usage, fromHook }，
 * 全部防御性读取：任何一层缺失/异形都返回 null。
 */
export interface BranchSummaryFileMetadata {
  readFiles: string[];
  modifiedFiles: string[];
}

export function getBranchSummaryFileMetadata(details: unknown): BranchSummaryFileMetadata | null {
  if (!details || typeof details !== "object") return null;
  const nested = (details as { details?: unknown }).details;
  if (!nested || typeof nested !== "object") return null;
  const readStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const readFiles = readStringArray((nested as { readFiles?: unknown }).readFiles);
  const modifiedFiles = readStringArray((nested as { modifiedFiles?: unknown }).modifiedFiles);
  if (readFiles.length === 0 && modifiedFiles.length === 0) return null;
  return { readFiles, modifiedFiles };
}

/** 分支动作结果：ok 应用新 context；cancelled/busy/error 全部保留当前 context。 */
export type BranchActionResult =
  | { kind: "ok" }
  | { kind: "cancelled" }
  | { kind: "busy" }
  | { kind: "error"; message?: string };

/** useAgentSession 暴露给分支 UI 的动作集合。 */
export interface BranchActions {
  /** 可写会话为 true；只读 child 会话隐藏一切写入口。 */
  canWrite: boolean;
  /** 分支切换/总结进行中：禁用树节点与选择项。 */
  busy: boolean;
  navigate: (targetId: string, choice: BranchSwitchChoice) => Promise<BranchActionResult>;
  setLabel: (targetId: string, rawLabel: string) => Promise<BranchActionResult>;
}
