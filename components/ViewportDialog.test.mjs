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
