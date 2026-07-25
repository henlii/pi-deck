import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: true });

// readDialogViewportRect 只读取 window.innerWidth/innerHeight/visualViewport，
// 用全局 mock 覆盖后逐用例恢复。
function withMockWindow(env, fn) {
  const prev = globalThis.window;
  globalThis.window = env;
  try {
    fn();
  } finally {
    globalThis.window = prev;
  }
}

test("visualViewport 存在时返回其 offset 与尺寸（软键盘场景）", async () => {
  const { readDialogViewportRect } = await jiti.import("./ui/ViewportDialog.tsx");
  withMockWindow(
    { innerWidth: 390, innerHeight: 844, visualViewport: { offsetLeft: 0, offsetTop: 220, width: 390, height: 424 } },
    () => {
      assert.deepEqual(readDialogViewportRect(), { top: 220, left: 0, width: 390, height: 424 });
    },
  );
});

test("visualViewport 不存在时回退 innerWidth/innerHeight + 0 offset", async () => {
  const { readDialogViewportRect } = await jiti.import("./ui/ViewportDialog.tsx");
  withMockWindow({ innerWidth: 1280, innerHeight: 720 }, () => {
    assert.deepEqual(readDialogViewportRect(), { top: 0, left: 0, width: 1280, height: 720 });
  });
});

test("visualViewport 尺寸异常（NaN/0/负）时回退 inner 尺寸", async () => {
  const { readDialogViewportRect } = await jiti.import("./ui/ViewportDialog.tsx");
  for (const bad of [Number.NaN, 0, -50]) {
    withMockWindow(
      { innerWidth: 800, innerHeight: 600, visualViewport: { offsetLeft: 10, offsetTop: 20, width: bad, height: 600 } },
      () => {
        assert.deepEqual(readDialogViewportRect(), { top: 0, left: 0, width: 800, height: 600 }, `width=${bad}`);
      },
    );
  }
});

test("offset 非有限或为负时安全截断为 0，inner 尺寸异常时保持非负", async () => {
  const { readDialogViewportRect } = await jiti.import("./ui/ViewportDialog.tsx");
  withMockWindow(
    { innerWidth: 500, innerHeight: 400, visualViewport: { offsetLeft: Number.NaN, offsetTop: -30, width: 500, height: 400 } },
    () => {
      assert.deepEqual(readDialogViewportRect(), { top: 0, left: 0, width: 500, height: 400 });
    },
  );
  withMockWindow({ innerWidth: undefined, innerHeight: Number.NaN }, () => {
    const rect = readDialogViewportRect();
    assert.equal(rect.width, 0);
    assert.equal(rect.height, 0);
    assert.ok(rect.width >= 0 && rect.height >= 0);
  });
});

test("getDialogSafeArea：常见移动视口四边各扣 16", async () => {
  const { getDialogSafeArea } = await jiti.import("./ui/ViewportDialog.tsx");
  assert.deepEqual(getDialogSafeArea({ top: 0, left: 0, width: 320, height: 568 }), { maxWidth: 288, maxHeight: 536 });
  assert.deepEqual(getDialogSafeArea({ top: 0, left: 0, width: 360, height: 640 }), { maxWidth: 328, maxHeight: 608 });
  assert.deepEqual(getDialogSafeArea({ top: 220, left: 0, width: 390, height: 424 }), { maxWidth: 358, maxHeight: 392 });
});

test("getDialogSafeArea：自定义 margin 与极端小视口保持非负", async () => {
  const { getDialogSafeArea } = await jiti.import("./ui/ViewportDialog.tsx");
  assert.deepEqual(getDialogSafeArea({ top: 0, left: 0, width: 360, height: 640 }, 8), { maxWidth: 344, maxHeight: 624 });
  assert.deepEqual(getDialogSafeArea({ top: 0, left: 0, width: 20, height: 10 }), { maxWidth: 0, maxHeight: 0 });
  assert.deepEqual(getDialogSafeArea({ top: 0, left: 0, width: 0, height: 0 }), { maxWidth: 0, maxHeight: 0 });
});

// ── 行为门禁（dialog-guards）──────────────────────────────────────────────

test("body 锁引用计数：嵌套打开只有末个解锁才恢复，释放幂等", async () => {
  const { acquireDialogBodyLock } = await jiti.import("./ui/dialog-guards.ts");
  const body = { style: { overflow: "auto" } };
  const releaseA = acquireDialogBodyLock(body);
  assert.equal(body.style.overflow, "hidden");
  const releaseB = acquireDialogBodyLock(body);
  // 内层先释放：仍保持锁定（外层还开着）。
  releaseB();
  assert.equal(body.style.overflow, "hidden");
  // 重复释放同一个句柄不影响计数。
  releaseB();
  assert.equal(body.style.overflow, "hidden");
  // 末个解锁恢复最初的值（不是清空，也不是内层保存的 hidden）。
  releaseA();
  assert.equal(body.style.overflow, "auto");
  releaseA();
  assert.equal(body.style.overflow, "auto");
});

test("对话框实例栈：Esc 只交给最顶层，注销后层级回落且与顺序无关", async () => {
  const { registerDialogInstance, isTopDialogInstance } = await jiti.import("./ui/dialog-guards.ts");
  const a = Symbol("a");
  const b = Symbol("b");
  const unregisterA = registerDialogInstance(a);
  assert.equal(isTopDialogInstance(a), true);
  const unregisterB = registerDialogInstance(b);
  // b 压栈后 a 不再响应 Esc。
  assert.equal(isTopDialogInstance(a), false);
  assert.equal(isTopDialogInstance(b), true);
  // 先注销 a（乱序关闭）：b 仍是顶层。
  unregisterA();
  assert.equal(isTopDialogInstance(b), true);
  unregisterB();
  assert.equal(isTopDialogInstance(a), false);
  assert.equal(isTopDialogInstance(b), false);
  // 重复注销安全。
  unregisterA();
  unregisterB();
});

test("Tab 焦点环：首末循环、空面板钉面板、面板外焦点拉回", async () => {
  const { resolveTabTrap } = await jiti.import("./ui/dialog-guards.ts");
  const panel = { name: "panel" };
  const first = { name: "first" };
  const middle = { name: "middle" };
  const last = { name: "last" };
  const focusable = [first, middle, last];
  const inside = (el) => focusable.includes(el);

  // 末位 Tab → 回首位。
  assert.deepEqual(resolveTabTrap({ focusable, active: last, shiftKey: false, panel, contains: inside }), { handled: true, target: first });
  // 首位 Shift+Tab → 回末位。
  assert.deepEqual(resolveTabTrap({ focusable, active: first, shiftKey: true, panel, contains: inside }), { handled: true, target: last });
  // 中间位不拦截。
  assert.deepEqual(resolveTabTrap({ focusable, active: middle, shiftKey: false, panel, contains: inside }), { handled: false });
  // 焦点在面板外：Tab 回首位、Shift+Tab 回末位。
  const outside = { name: "outside" };
  assert.deepEqual(resolveTabTrap({ focusable, active: outside, shiftKey: false, panel, contains: inside }), { handled: true, target: first });
  assert.deepEqual(resolveTabTrap({ focusable, active: outside, shiftKey: true, panel, contains: inside }), { handled: true, target: last });
  assert.deepEqual(resolveTabTrap({ focusable, active: null, shiftKey: false, panel, contains: inside }), { handled: true, target: first });
  // 无可交互元素：任何 Tab 都钉在面板上。
  assert.deepEqual(resolveTabTrap({ focusable: [], active: null, shiftKey: false, panel, contains: inside }), { handled: true, target: panel });
});

test("首焦点与焦点恢复：优先显式指定，其次首个可交互元素；恢复目标须仍在文档中", async () => {
  const { pickInitialFocusTarget, resolveFocusRestoreTarget } = await jiti.import("./ui/dialog-guards.ts");
  const preferred = { name: "preferred" };
  const first = { name: "first" };
  const panel = { name: "panel" };
  assert.equal(pickInitialFocusTarget(preferred, [first], panel), preferred);
  assert.equal(pickInitialFocusTarget(null, [first], panel), first);
  assert.equal(pickInitialFocusTarget(undefined, [], panel), panel);

  const trigger = { name: "trigger" };
  assert.equal(resolveFocusRestoreTarget(trigger, () => true), trigger);
  // 触发元素已被移除（如列表刷新）时不强行恢复。
  assert.equal(resolveFocusRestoreTarget(trigger, () => false), null);
  assert.equal(resolveFocusRestoreTarget(null, () => true), null);
});

test("顶层对话框拦截 Ctrl+Alt+N，但不关闭", async () => {
  const { resolveDialogKeyDown } = await jiti.import("./ui/dialog-guards.ts");
  assert.deepEqual(resolveDialogKeyDown({ key: "n", defaultPrevented: false, closeOnEsc: true, isTop: true }), {
    stopPropagation: true,
    preventDefault: false,
    close: false,
  });
});

test("顶层已 defaultPrevented 的 Escape 仍拦截但不关闭", async () => {
  const { resolveDialogKeyDown } = await jiti.import("./ui/dialog-guards.ts");
  assert.deepEqual(resolveDialogKeyDown({ key: "Escape", defaultPrevented: true, closeOnEsc: true, isTop: true }), {
    stopPropagation: true,
    preventDefault: false,
    close: false,
  });
});

test("顶层普通 Escape 拦截、阻止默认行为并关闭", async () => {
  const { resolveDialogKeyDown } = await jiti.import("./ui/dialog-guards.ts");
  assert.deepEqual(resolveDialogKeyDown({ key: "Escape", defaultPrevented: false, closeOnEsc: true, isTop: true }), {
    stopPropagation: true,
    preventDefault: true,
    close: true,
  });
});

test("非顶层对话框不处理键盘事件", async () => {
  const { resolveDialogKeyDown } = await jiti.import("./ui/dialog-guards.ts");
  assert.deepEqual(resolveDialogKeyDown({ key: "n", defaultPrevented: false, closeOnEsc: true, isTop: false }), {
    stopPropagation: false,
    preventDefault: false,
    close: false,
  });
});

test("全局快捷键 disabled 时不执行", async () => {
  const { shouldRunGlobalKeyboardShortcuts } = await jiti.import("../hooks/useKeyboardShortcuts.ts");
  assert.equal(shouldRunGlobalKeyboardShortcuts(true), false);
  assert.equal(shouldRunGlobalKeyboardShortcuts(false), true);
});
