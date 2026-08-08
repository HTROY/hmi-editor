import type { Point } from "../types";

/** 视图缩放范围：10% ~ 800% */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Viewport — 编辑视图变换
 * 只影响画面在画布上的显示（缩放/平移），不修改任何图元坐标或页面分辨率。
 */
export class Viewport {
  zoom = 1;
  panX = 0;
  panY = 0;

  /** 设置缩放倍数，默认以 (0,0) 为锚点；锚点下的世界坐标保持不动 */
  setZoom(zoom: number, anchorX = 0, anchorY = 0): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (next === this.zoom) return;
    const worldX = (anchorX - this.panX) / this.zoom;
    const worldY = (anchorY - this.panY) / this.zoom;
    this.panX = anchorX - worldX * next;
    this.panY = anchorY - worldY * next;
    this.zoom = next;
  }

  /** 按倍数缩放，锚点下的世界坐标保持不动 */
  zoomBy(factor: number, anchorX = 0, anchorY = 0): void {
    this.setZoom(this.zoom * factor, anchorX, anchorY);
  }

  /** 按屏幕像素平移 */
  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /** 屏幕坐标 -> 世界坐标 */
  screenToWorld(x: number, y: number): Point {
    return {
      x: (x - this.panX) / this.zoom,
      y: (y - this.panY) / this.zoom,
    };
  }

  /** 世界坐标 -> 屏幕坐标 */
  worldToScreen(x: number, y: number): Point {
    return {
      x: x * this.zoom + this.panX,
      y: y * this.zoom + this.panY,
    };
  }

  /** 将页面适配到画布并居中，四周保留 margin 像素 */
  fitPage(
    pageWidth: number,
    pageHeight: number,
    canvasWidth: number,
    canvasHeight: number,
    margin = 40
  ): void {
    const availW = Math.max(1, canvasWidth - margin * 2);
    const availH = Math.max(1, canvasHeight - margin * 2);
    const zoom = Math.min(availW / pageWidth, availH / pageHeight, MAX_ZOOM);
    this.zoom = Math.max(MIN_ZOOM, zoom);
    this.panX = (canvasWidth - pageWidth * this.zoom) / 2;
    this.panY = (canvasHeight - pageHeight * this.zoom) / 2;
  }

  /** 恢复 100% 且不平移 */
  reset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  clone(): Viewport {
    const vp = new Viewport();
    vp.zoom = this.zoom;
    vp.panX = this.panX;
    vp.panY = this.panY;
    return vp;
  }

  toJSON(): ViewTransform {
    return { zoom: this.zoom, panX: this.panX, panY: this.panY };
  }
}
