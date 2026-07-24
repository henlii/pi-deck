import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const base = { desiredSize: { width: 120, height: 100 }, viewport: { offsetLeft: 0, offsetTop: 0, width: 400, height: 300 }, margin: 10, gap: 5 };

test("优先下方并在空间不足时翻转", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  const result = calculateAnchoredOverlay({ ...base, anchor: { top: 250, left: 20, right: 50, bottom: 270 } });
  assert.equal(result.placement, "above");
  assert.equal(result.maxHeight, 235);
});

test("左右 clamp、visual viewport 偏移和极端尺寸保持安全", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  const result = calculateAnchoredOverlay({ desiredSize: { width: 900, height: 900 }, viewport: { offsetLeft: 100, offsetTop: 40, width: 80, height: 60 }, anchor: { top: -20, left: -50, right: 0, bottom: 0 }, margin: 8 });
  assert.equal(result.left, 108);
  assert.equal(result.top, 48);
  assert.equal(result.maxWidth, 64);
  assert.ok(result.maxHeight >= 0);
  assert.ok(Number.isFinite(result.top) && Number.isFinite(result.left));
});
