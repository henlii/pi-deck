/**
 * 会话分支路径纯逻辑（只读投影共享的中性基础设施）。
 * 从 leaf 沿 parentId 上溯到 root 再 reverse 为 root→leaf 顺序。
 * 本模块不 import 任何投影 lib，供各只读投影（om/workspace-history 等）复用。
 */

export type SessionBranchEntry = {
  id: string;
  type: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
};

/**
 * 从 leaf 沿 parentId 上溯到 root，再 reverse 为 root→leaf。
 * leaf 为 null 或找不到时用全部 entries 的原始顺序。
 */
export function buildActiveBranchPath<T extends SessionBranchEntry>(
  entries: ReadonlyArray<T>,
  leafId: string | null | undefined,
): T[] {
  if (leafId == null) {
    return [...entries];
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (!byId.has(leafId)) {
    return [...entries];
  }
  const path: T[] = [];
  const seen = new Set<string>();
  let current: T | undefined = byId.get(leafId);
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.push(current);
    const parentId = current.parentId ?? null;
    if (parentId == null) break;
    current = byId.get(parentId);
  }
  path.reverse();
  return path;
}
