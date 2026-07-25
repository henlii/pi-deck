/**
 * ViewportDialog 的行为门禁 helper：body 滚动锁、实例栈（Esc 只关顶层）、
 * 焦点环/首焦点/焦点恢复的纯逻辑。全部 DOM 解耦，node:test 可直接覆盖。
 */

// ── body 滚动锁（模块级引用计数）──────────────────────────────────────────
// 多实例/嵌套打开时只有首个加锁、末个解锁恢复；「保存旧 overflow 再恢复」
// 在嵌套关闭顺序下会把背景滚动错误解锁，引用计数是最小安全方案。
let bodyLockCount = 0;
let bodyLockSavedOverflow: string | null = null;

export type BodyStyleTarget = { style: { overflow: string } };

/** 加锁并返回幂等的释放函数：重复调用 release 不会提前恢复背景滚动。 */
export function acquireDialogBodyLock(body: BodyStyleTarget): () => void {
  if (bodyLockCount === 0) {
    bodyLockSavedOverflow = body.style.overflow;
    body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bodyLockCount -= 1;
    if (bodyLockCount === 0) {
      body.style.overflow = bodyLockSavedOverflow ?? "";
      bodyLockSavedOverflow = null;
    }
  };
}

// ── 对话框实例栈 ──────────────────────────────────────────────────────────
// Esc 只交给最顶层实例；被压住的底层对话框不响应，也不会 stopPropagation
// 抢占顶层事件。注册顺序即层级顺序，注销与顺序无关。
const dialogInstanceStack: symbol[] = [];

export function registerDialogInstance(id: symbol): () => void {
  dialogInstanceStack.push(id);
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    const index = dialogInstanceStack.lastIndexOf(id);
    if (index >= 0) dialogInstanceStack.splice(index, 1);
  };
}

export function isTopDialogInstance(id: symbol): boolean {
  return dialogInstanceStack.length > 0
    && dialogInstanceStack[dialogInstanceStack.length - 1] === id;
}

export type DialogKeyDownDecision = {
  stopPropagation: boolean;
  preventDefault: boolean;
  close: boolean;
};

/**
 * 计算对话框在 document bubble 阶段对键盘事件的处理结果。
 * 顶层对话框拦截所有 keydown；只有未被消费且允许关闭的 Escape 才关闭。
 */
export function resolveDialogKeyDown(args: {
  key: string;
  defaultPrevented: boolean;
  closeOnEsc: boolean;
  isTop: boolean;
}): DialogKeyDownDecision {
  if (!args.isTop) {
    return { stopPropagation: false, preventDefault: false, close: false };
  }
  const isEsc = args.key === "Escape";
  const close = isEsc && args.closeOnEsc && !args.defaultPrevented;
  return {
    stopPropagation: true,
    preventDefault: close,
    close,
  };
}

// ── 焦点逻辑 ──────────────────────────────────────────────────────────────

/** 打开时的首焦点：显式指定 > 面板内首个可交互元素 > 面板本身。 */
export function pickInitialFocusTarget<T>(
  preferred: T | null | undefined,
  focusable: T[],
  fallback: T,
): T {
  return preferred ?? focusable[0] ?? fallback;
}

export type TabTrapResult<T> = { handled: true; target: T } | { handled: false };

/**
 * Tab 焦点环：焦点在面板内循环，不跑到背景。
 * contains 以回调注入，保持纯逻辑可测（浏览器里即 panel.contains）。
 */
export function resolveTabTrap<T>(args: {
  focusable: T[];
  active: T | null;
  shiftKey: boolean;
  panel: T;
  contains: (el: T) => boolean;
}): TabTrapResult<T> {
  const { focusable, active, shiftKey, panel, contains } = args;
  // 面板内没有可交互元素时，Tab 直接钉在面板上。
  if (focusable.length === 0) return { handled: true, target: panel };
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeInside = active !== null && contains(active);
  if (shiftKey) {
    if (active === first || !activeInside) return { handled: true, target: last };
  } else if (active === last || !activeInside) {
    return { handled: true, target: first };
  }
  return { handled: false };
}

/** 关闭后的焦点恢复目标：触发元素仍在文档中才恢复，否则放弃（交给浏览器）。 */
export function resolveFocusRestoreTarget<T>(
  previous: T | null,
  stillConnected: (el: T) => boolean,
): T | null {
  return previous !== null && stillConnected(previous) ? previous : null;
}
