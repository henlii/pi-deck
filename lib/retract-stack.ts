/**
 * 消息撤回/恢复的纯逻辑（无 IO、无 React，node:test 可直接测）。
 *
 * 语义对齐 OpenChamber 的 revert 模型在 Pi 分支结构下的实现：
 * - 撤回消息 M（user entry）＝把 leaf 移到 M 之前（navigate_tree(M.parentId)），
 *   M 及其回复链脱离当前链但物理保留在会话文件中，天然可恢复。
 * - 恢复消息 M ＝把 leaf 移回 M 的子孙链最深末端（navigate_tree(chainTail(M))）。
 * - 工作区文件还原/恢复不在此层：由已安装的扩展（如 pi-workspace-history）
 *   经 session_before_tree 事件被动完成，本模块不绑定任何插件。
 *
 * 撤回栈（服务端内存，keyed by sessionId）只记录 UI 展示与恢复所需的最小信息；
 * 被撤回消息本身的数据永远留在会话文件里，栈丢失不影响可恢复性
 * （分支仍在 BranchNavigator 中可见）。
 */
/** 被撤回的一条 user 消息的展示/恢复记录。 */
export interface RetractedRecord {
	/** user 消息的 entry id（撤回目标）。 */
	entryId: string;
	/** 预览文本（截断后的 user 内容）。 */
	text: string;
	/** 该消息子孙链的最深末端 entry id；恢复时作为 navigate_tree 目标。 */
	chainTailEntryId: string;
	/** user 消息时间戳（展示用）。 */
	timestamp?: string;
}

export const RETRACT_PREVIEW_MAX = 120;

/** 从 user 消息内容提取纯文本预览（鸭子类型，兼容 SDK 与本地 message 形状）。 */
export function extractUserText(
	message: { role?: string; content?: unknown } | null | undefined,
): string {
	if (!message || message.role !== "user") return "";
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(b): b is { type: "text"; text?: string } =>
								b != null &&
								typeof b === "object" &&
								(b as { type?: unknown }).type === "text",
						)
						.map((b) => b.text ?? "")
						.join("\n")
				: "";
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > RETRACT_PREVIEW_MAX
		? `${collapsed.slice(0, RETRACT_PREVIEW_MAX)}…`
		: collapsed;
}

/**
 * 计算 entry 子孙链的最深末端：
 * 沿每个节点的第一个孩子（文件顺序）向下走到叶子。
 * 无子孙时返回 entryId 自身；entry 不存在返回 null。
 */
export function computeChainTail(
	entries: ReadonlyArray<{ id: string; parentId: string | null }>,
	entryId: string,
): string | null {
	if (!entries.some((e) => e.id === entryId)) return null;
	const childrenOf = new Map<string, string[]>();
	for (const e of entries) {
		if (e.parentId === null) continue;
		const list = childrenOf.get(e.parentId);
		if (list) list.push(e.id);
		else childrenOf.set(e.parentId, [e.id]);
	}
	let cur = entryId;
	for (let guard = 0; guard < entries.length + 1; guard++) {
		const children = childrenOf.get(cur);
		if (!children || children.length === 0) return cur;
		cur = children[0];
	}
	return cur;
}

/** 判断 targetId 是否落在以 ancestorId 为根的子孙链上（含自身）。 */
export function isDescendantOrSelf(
	entries: ReadonlyArray<{ id: string; parentId: string | null }>,
	targetId: string,
	ancestorId: string,
): boolean {
	if (targetId === ancestorId) return true;
	const parentOf = new Map<string, string | null>();
	for (const e of entries) parentOf.set(e.id, e.parentId);
	let cur = parentOf.get(targetId) ?? null;
	for (let guard = 0; guard < entries.length + 1 && cur; guard++) {
		if (cur === ancestorId) return true;
		cur = parentOf.get(cur) ?? null;
	}
	return false;
}

/** 判断某 user 消息是否在当前 leaf 的祖先链上（链上校验用）。 */
export function isOnLeafChain(
	entries: ReadonlyArray<{ id: string; parentId: string | null }>,
	leafId: string | null,
	entryId: string,
): boolean {
	if (!leafId) return false;
	return isDescendantOrSelf(entries, leafId, entryId);
}

/** 入栈：已存在的 entryId 忽略（幂等）。返回新栈（不修改入参）。 */
export function pushRetracted(
	stack: readonly RetractedRecord[],
	record: RetractedRecord,
): RetractedRecord[] {
	if (stack.some((r) => r.entryId === record.entryId)) return [...stack];
	return [...stack, record];
}

/**
 * 恢复后的栈：移除 entryId 及其子孙链上的所有记录。
 * （串行重发链随被恢复消息一起回到当前链，故一并移出撤回区；
 *   并行兄弟分支不在子孙链上，保持撤回状态。）
 */
export function removeRetracted(
	entries: ReadonlyArray<{ id: string; parentId: string | null }>,
	stack: readonly RetractedRecord[],
	entryId: string,
): RetractedRecord[] {
	return stack.filter((r) => !isDescendantOrSelf(entries, r.entryId, entryId));
}
