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
  const leftEdge = finite(viewport.offsetLeft) + margin;
  const topEdge = finite(viewport.offsetTop) + margin;
  const rightEdge = finite(viewport.offsetLeft) + Math.max(0, finite(viewport.width)) - margin;
  const bottomEdge = finite(viewport.offsetTop) + Math.max(0, finite(viewport.height)) - margin;
  const maxWidth = Math.max(0, rightEdge - leftEdge);
  const aboveSpace = Math.max(0, finite(anchor.top) - gap - topEdge);
  const belowSpace = Math.max(0, bottomEdge - finite(anchor.bottom) - gap);
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
  const rawLeft = finite(anchor.left);
  const left = Math.min(Math.max(rawLeft, leftEdge), Math.max(leftEdge, rightEdge - Math.max(0, finite(desiredSize.width))));
  const rawTop = placement === "below"
    ? finite(anchor.bottom) + gap
    : finite(anchor.top) - gap - Math.max(0, finite(desiredSize.height));
  const top = Math.min(Math.max(rawTop, topEdge), Math.max(topEdge, bottomEdge - Math.min(maxHeight, Math.max(0, finite(desiredSize.height)))));
  return { top: finite(top, topEdge), left: finite(left, leftEdge), maxHeight, maxWidth, placement };
}

export const getAnchoredOverlayPosition = calculateAnchoredOverlay;
