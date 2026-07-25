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

test("align=end 时面板右缘对齐 anchor 右缘并被 clamp", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  // anchor.right=360，面板宽 120 → left=240；未越过右边界。
  const aligned = calculateAnchoredOverlay({ ...base, align: "end", anchor: { top: 100, left: 300, right: 360, bottom: 130 } });
  assert.equal(aligned.left, 240);
  assert.equal(aligned.placement, "below");
  // anchor 贴近右边缘导致面板越界时，向左 clamp 到 rightEdge-width。
  const clamped = calculateAnchoredOverlay({ ...base, align: "end", anchor: { top: 100, left: 370, right: 399, bottom: 130 } });
  assert.equal(clamped.left, 270); // 400 - 10(margin) - 120(width)
  assert.ok(clamped.left + 120 <= 390);
});

test("上下空间都不足时选择空间更大的一侧并限制 maxHeight", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  // viewport 高 300，anchor 在 250-270：上方空间 235 > 下方 15 → above，maxHeight=235。
  const above = calculateAnchoredOverlay({ ...base, anchor: { top: 250, left: 20, right: 50, bottom: 270 }, minHeight: 400 });
  assert.equal(above.placement, "above");
  assert.equal(above.maxHeight, 235);
  // anchor 在 20-40：下方空间 245 > 上方 5 → below，maxHeight=245。
  const below = calculateAnchoredOverlay({ ...base, anchor: { top: 20, left: 20, right: 50, bottom: 40 }, minHeight: 400 });
  assert.equal(below.placement, "below");
  assert.equal(below.maxHeight, 245);
});

test("minHeight 触发翻转：preferred 空间不足时尝试另一侧", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  // 下方只剩 60，minHeight=100，上方有 235 → 即使 preferred=below 也翻转到 above。
  const flipped = calculateAnchoredOverlay({ ...base, anchor: { top: 210, left: 20, right: 50, bottom: 230 }, minHeight: 100 });
  assert.equal(flipped.placement, "above");
  // 两侧都满足时尊重 preferred=below。
  const kept = calculateAnchoredOverlay({ ...base, anchor: { top: 100, left: 20, right: 50, bottom: 130 }, minHeight: 100 });
  assert.equal(kept.placement, "below");
});

test("负的 visual viewport 偏移按 0 处理，安全边距不被放大", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  const result = calculateAnchoredOverlay({
    ...base,
    viewport: { offsetLeft: -50, offsetTop: -20, width: 400, height: 300 },
    anchor: { top: 100, left: 0, right: 30, bottom: 130 },
  });
  // leftEdge = 0 + margin(10)，面板左缘不被负偏移推到视口外。
  assert.equal(result.left, 10);
  assert.equal(result.maxWidth, 380);
});

test("above 放置且内容高于可用空间时顶部 clamp 到安全边距", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  // viewport 高 300、margin 10、gap 5：aboveSpace=185 < desired 400，
  // belowSpace=75 更小 → 选 above，maxHeight=185，top 贴 topEdge(10)。
  const result = calculateAnchoredOverlay({
    ...base,
    anchor: { top: 200, left: 20, right: 50, bottom: 210 },
    desiredSize: { width: 120, height: 400 },
  });
  assert.equal(result.placement, "above");
  assert.equal(result.maxHeight, 185);
  assert.equal(result.top, 10);
  // 面板底缘恰好停在 anchor 上方 gap 处，不遮挡锚点。
  assert.ok(result.top + result.maxHeight <= 200 - 5);
});

test("anchor 完全位于视口外时可用空间被视口跨度封顶，面板不溢出对侧边", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  // anchor 在视口下方（top=400 > bottomEdge=290）：翻上展示是合理策略，
  // 但可用空间只能是视口安全跨度 280（300-2×10），而不是到顶边的 385。
  const result = calculateAnchoredOverlay({
    ...base,
    anchor: { top: 400, left: 20, right: 50, bottom: 430 },
    desiredSize: { width: 120, height: 500 },
  });
  assert.equal(result.placement, "above");
  assert.equal(result.maxHeight, 280);
  assert.equal(result.top, 10);
  assert.ok(result.top + result.maxHeight <= 290);
  // anchor 在视口上方（bottom=-50 < topEdge=10）：belowSpace 同样被封顶。
  const mirrored = calculateAnchoredOverlay({
    ...base,
    anchor: { top: -80, left: 20, right: 50, bottom: -50 },
    desiredSize: { width: 120, height: 500 },
  });
  assert.equal(mirrored.placement, "below");
  assert.equal(mirrored.maxHeight, 280);
  assert.ok(mirrored.top + mirrored.maxHeight <= 290);
});

test("零高度内容不触发翻转，尊重 preferred=above", async () => {
  const { calculateAnchoredOverlay } = await jiti.import("./anchored-overlay.ts");
  const result = calculateAnchoredOverlay({
    ...base,
    preferredPlacement: "above",
    desiredSize: { width: 120, height: 0 },
    anchor: { top: 20, left: 20, right: 50, bottom: 40 },
  });
  assert.equal(result.placement, "above");
});

test("getAnchoredOverlayPosition 别名与主函数一致", async () => {
  const mod = await jiti.import("./anchored-overlay.ts");
  assert.equal(mod.getAnchoredOverlayPosition, mod.calculateAnchoredOverlay);
});
