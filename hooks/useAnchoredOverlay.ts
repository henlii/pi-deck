"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import {
  calculateAnchoredOverlay,
  type AnchoredOverlayPlacement,
  type VisualViewportRect,
} from "@/lib/anchored-overlay";

// SSR 时降级为 useEffect，避免服务端渲染告警；定位只在客户端发生。
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface UseAnchoredOverlayOptions {
  /** 是否打开。overlay 的渲染条件需与 open 保持一致，保证打开时 refs 已挂载。 */
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  overlayRef: RefObject<HTMLElement | null>;
  preferredPlacement?: AnchoredOverlayPlacement;
  /** 距可视 viewport 边缘的安全边距，默认 8 */
  margin?: number;
  /** 与 anchor 之间的间隙，默认 4 */
  gap?: number;
  /** 期望的最小可用高度，影响上下翻转判断 */
  minHeight?: number;
  /** 业务高度上限（在可用空间上限之上再取小） */
  maxHeight?: number;
  /** 业务宽度上限（在 viewport 上限之上再取小） */
  maxWidth?: number;
  /** 水平对齐：start = 面板左缘对齐 anchor 左缘；end = 面板右缘对齐 anchor 右缘 */
  align?: "start" | "end";
  /** 宽度策略："anchor" 跟随 anchor 宽，"max" 占满可用宽，数字为固定宽；默认不设置 */
  width?: "anchor" | "max" | number;
  /** 最小宽度："anchor" 或固定数字 */
  minWidth?: "anchor" | number;
  /**
   * 打开期间的位置轮询间隔（毫秒），默认 250，设 0 关闭。
   * ResizeObserver 只报尺寸变化：anchor 被兄弟布局变化（retry banner、
   * 排队消息行、流式输出推开输入区）移动时尺寸不变、也无 scroll/resize，
   * 只能靠低频对 rect 兜底；update 内有 sameMetrics 去重，无位移零开销。
   */
  pollIntervalMs?: number;
}

export interface UseAnchoredOverlayResult {
  /** 适用于 position:fixed 面板的样式；ready 之前 visibility:hidden，避免闪到错误位置 */
  style: CSSProperties;
  placement: AnchoredOverlayPlacement;
  ready: boolean;
}

interface OverlayMetrics {
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
  anchorWidth: number;
  placement: AnchoredOverlayPlacement;
}

function readVisualViewport(): VisualViewportRect {
  const vv = window.visualViewport;
  if (vv) {
    return { offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, width: vv.width, height: vv.height };
  }
  return { offsetLeft: 0, offsetTop: 0, width: window.innerWidth, height: window.innerHeight };
}

function sameMetrics(a: OverlayMetrics | null, b: OverlayMetrics): boolean {
  return a !== null
    && a.top === b.top
    && a.left === b.left
    && a.maxHeight === b.maxHeight
    && a.maxWidth === b.maxWidth
    && a.anchorWidth === b.anchorWidth
    && a.placement === b.placement;
}

/**
 * 视口安全的锚定浮层定位 Hook，包装 lib/anchored-overlay 的纯函数。
 *
 * - 打开后在 layout effect 中同步测量（首帧 paint 前定位，不闪错误位置）；
 * - 监听 window resize / 全捕获 scroll、visualViewport resize+scroll，
 *   以及 anchor/overlay 的 ResizeObserver；事件经 rAF 合帧，读写分离无布局抖动；
 * - 另有低频位置轮询兜底（默认 250ms，pollIntervalMs 可调/关闭），覆盖
 *   「anchor 位移但尺寸不变」这类无事件场景（兄弟 banner/队列行推开布局）；
 * - maxWidth/maxHeight 真实写回 style，由调用方让内容在面板内部滚动；
 * - 关闭时清空测量结果，下次打开重新测量。
 */
export function useAnchoredOverlay(options: UseAnchoredOverlayOptions): UseAnchoredOverlayResult {
  const {
    open,
    anchorRef,
    overlayRef,
    preferredPlacement = "below",
    margin = 8,
    gap = 4,
    minHeight,
    maxHeight: maxHeightLimit,
    maxWidth: maxWidthLimit,
    align,
    width,
    minWidth,
    pollIntervalMs = 250,
  } = options;

  const [metrics, setMetrics] = useState<OverlayMetrics | null>(null);
  const rafRef = useRef(0);

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;
    const rect = anchor.getBoundingClientRect();
    // anchor 不可见（display:none 祖先内）时保持 hidden，等 RO/事件再次触发。
    if (rect.width === 0 && rect.height === 0) {
      setMetrics((prev) => (prev === null ? prev : null));
      return;
    }
    const position = calculateAnchoredOverlay({
      anchor: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      desiredSize: {
        width: overlay.offsetWidth,
        height: Math.min(overlay.offsetHeight, maxHeightLimit ?? Number.POSITIVE_INFINITY),
      },
      viewport: readVisualViewport(),
      margin,
      gap,
      minHeight,
      preferredPlacement,
      align,
    });
    const next: OverlayMetrics = {
      top: position.top,
      left: position.left,
      maxHeight: maxHeightLimit === undefined ? position.maxHeight : Math.min(position.maxHeight, maxHeightLimit),
      maxWidth: maxWidthLimit === undefined ? position.maxWidth : Math.min(position.maxWidth, maxWidthLimit),
      anchorWidth: rect.width,
      placement: position.placement,
    };
    setMetrics((prev) => (sameMetrics(prev, next) ? prev : next));
  }, [anchorRef, overlayRef, margin, gap, minHeight, maxHeightLimit, maxWidthLimit, preferredPlacement, align]);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setMetrics(null);
      return;
    }
    // 首次同步测量，保证首帧 paint 前就有正确位置。
    update();
    const schedule = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        update();
      });
    };
    window.addEventListener("resize", schedule);
    // capture：任意祖先容器的滚动都会改变 anchor 的视口位置。
    window.addEventListener("scroll", schedule, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    const ro = new ResizeObserver(schedule);
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (anchor) ro.observe(anchor);
    if (overlay) ro.observe(overlay);
    // 位置轮询兜底：anchor 位移但尺寸不变（兄弟节点增减推开布局）时，
    // RO/scroll/resize 都不会触发，只能靠定时比对 rect 收敛。
    const poll = pollIntervalMs > 0 ? window.setInterval(schedule, pollIntervalMs) : 0;
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (poll) window.clearInterval(poll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [open, update, anchorRef, overlayRef, pollIntervalMs]);

  const style = useMemo<CSSProperties>(() => {
    if (!metrics) {
      return { position: "fixed", top: 0, left: 0, visibility: "hidden" };
    }
    const next: CSSProperties = {
      position: "fixed",
      top: metrics.top,
      left: metrics.left,
      maxHeight: metrics.maxHeight,
      maxWidth: metrics.maxWidth,
      visibility: "visible",
    };
    const capWidth = (w: number) => Math.max(0, Math.min(w, metrics.maxWidth));
    if (width === "anchor") next.width = capWidth(metrics.anchorWidth);
    else if (width === "max") next.width = metrics.maxWidth;
    else if (typeof width === "number") next.width = capWidth(width);
    const minW = minWidth === "anchor" ? metrics.anchorWidth : typeof minWidth === "number" ? minWidth : undefined;
    if (minW !== undefined) next.minWidth = Math.min(minW, metrics.maxWidth);
    return next;
  }, [metrics, width, minWidth]);

  return {
    style,
    placement: metrics?.placement ?? preferredPlacement,
    ready: metrics !== null,
  };
}
