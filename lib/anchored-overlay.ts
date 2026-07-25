export type AnchorRect = { top: number; left: number; right: number; bottom: number };
export type OverlayDesiredSize = { width: number; height: number };
export type VisualViewportRect = { offsetLeft: number; offsetTop: number; width: number; height: number };
export type AnchoredOverlayOptions = {
  anchor: AnchorRect;
  desiredSize: OverlayDesiredSize;
  viewport: VisualViewportRect;
  margin?: number;
  gap?: number;
  minHeight?: number;
  preferredPlacement?: "above" | "below";
  /** 水平对齐方式：start = 面板左缘对齐 anchor 左缘；end = 面板右缘对齐 anchor 右缘 */
  align?: "start" | "end";
};
export type AnchoredOverlayPlacement = "above" | "below";
export type AnchoredOverlayPosition = {
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
  placement: AnchoredOverlayPlacement;
};

const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);

export function calculateAnchoredOverlay(options: AnchoredOverlayOptions): AnchoredOverlayPosition {
  const { anchor, desiredSize, viewport } = options;
  const margin = Math.max(0, finite(options.margin ?? 8));
  const gap = Math.max(0, finite(options.gap ?? 4));
  const minHeight = Math.max(0, finite(options.minHeight ?? 0));
  // 负的 visual viewport 偏移按 0 处理（与 ViewportDialog 的读取语义一致），
  // 防止异常浏览器状态下安全边距被反向放大。
  const offsetLeft = Math.max(0, finite(viewport.offsetLeft));
  const offsetTop = Math.max(0, finite(viewport.offsetTop));
  const leftEdge = offsetLeft + margin;
  const topEdge = offsetTop + margin;
  const rightEdge = offsetLeft + Math.max(0, finite(viewport.width)) - margin;
  const bottomEdge = offsetTop + Math.max(0, finite(viewport.height)) - margin;
  const maxWidth = Math.max(0, rightEdge - leftEdge);
  // 可用高度必须被视口安全跨度封顶：anchor 完全在视口外时，「到对侧边缘的
  // 距离」会夸大空间，不封顶则高面板会从对侧边溢出可视区。
  const span = Math.max(0, bottomEdge - topEdge);
  const aboveSpace = Math.min(span, Math.max(0, finite(anchor.top) - gap - topEdge));
  const belowSpace = Math.min(span, Math.max(0, bottomEdge - finite(anchor.bottom) - gap));
  const preferred = options.preferredPlacement ?? "below";
  const other = preferred === "below" ? "above" : "below";
  const requiredHeight = Math.max(minHeight, Math.max(0, finite(desiredSize.height)));
  const placement = (preferred === "below" ? belowSpace : aboveSpace) >= requiredHeight
    ? preferred
    : (other === "below" ? belowSpace : aboveSpace) >= requiredHeight
      ? other
      : (belowSpace >= aboveSpace ? "below" : "above");
  const availableHeight = placement === "below" ? belowSpace : aboveSpace;
  const maxHeight = Math.max(0, availableHeight);
  const desiredWidth = Math.max(0, finite(desiredSize.width));
  const rawLeft = options.align === "end"
    ? finite(anchor.right) - desiredWidth
    : finite(anchor.left);
  const left = Math.min(Math.max(rawLeft, leftEdge), Math.max(leftEdge, rightEdge - desiredWidth));
  const rawTop = placement === "below"
    ? finite(anchor.bottom) + gap
    : finite(anchor.top) - gap - Math.max(0, finite(desiredSize.height));
  const top = Math.min(Math.max(rawTop, topEdge), Math.max(topEdge, bottomEdge - Math.min(maxHeight, Math.max(0, finite(desiredSize.height)))));
  return { top: finite(top, topEdge), left: finite(left, leftEdge), maxHeight, maxWidth, placement };
}

export const getAnchoredOverlayPosition = calculateAnchoredOverlay;
