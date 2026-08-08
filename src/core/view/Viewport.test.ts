import { describe, expect, it } from "vitest";
import { Viewport, MIN_ZOOM, MAX_ZOOM } from "./Viewport";

describe("Viewport", () => {
  it("starts at 100% with no pan", () => {
    const vp = new Viewport();
    expect(vp.zoom).toBe(1);
    expect(vp.panX).toBe(0);
    expect(vp.panY).toBe(0);
  });

  it("clamps zoom to the 10%..800% range", () => {
    const vp = new Viewport();
    vp.setZoom(0.02);
    expect(vp.zoom).toBe(MIN_ZOOM);
    vp.setZoom(25);
    expect(vp.zoom).toBe(MAX_ZOOM);
  });

  it("zooms around an anchor so the world point under the cursor stays fixed", () => {
    const vp = new Viewport();
    vp.setZoom(2, 100, 50);
    const world = vp.screenToWorld(100, 50);
    expect(world.x).toBeCloseTo(100, 6);
    expect(world.y).toBeCloseTo(50, 6);
    expect(vp.zoom).toBe(2);
  });

  it("zooms by a factor and keeps the anchor stable", () => {
    const vp = new Viewport();
    vp.zoomBy(1.5, 400, 300);
    expect(vp.zoom).toBeCloseTo(1.5);
    expect(vp.screenToWorld(400, 300).x).toBeCloseTo(400);
    expect(vp.screenToWorld(400, 300).y).toBeCloseTo(300);
  });

  it("converts between screen and world coordinates", () => {
    const vp = new Viewport();
    vp.zoom = 2;
    vp.panX = 50;
    vp.panY = -20;
    expect(vp.worldToScreen(100, 200)).toEqual({ x: 250, y: 380 });
    expect(vp.screenToWorld(250, 380)).toEqual({ x: 100, y: 200 });
  });

  it("pans by screen deltas", () => {
    const vp = new Viewport();
    vp.panBy(12, -8);
    expect(vp.panX).toBe(12);
    expect(vp.panY).toBe(-8);
  });

  it("fitPage centers the page with the requested margin", () => {
    const vp = new Viewport();
    vp.fitPage(1920, 1080, 1200, 800, 40);
    const center = vp.worldToScreen(960, 540);
    expect(center.x).toBeCloseTo(600);
    expect(center.y).toBeCloseTo(400);
    expect(vp.zoom).toBeCloseTo(
      Math.min((1200 - 80) / 1920, (800 - 80) / 1080)
    );
  });

  it("fitPage may zoom above 100% for small pages but never above the max", () => {
    const vp = new Viewport();
    vp.fitPage(800, 600, 1200, 800, 40);
    expect(vp.zoom).toBeCloseTo(1.2);
    const center = vp.worldToScreen(400, 300);
    expect(center.x).toBeCloseTo(600);
    expect(center.y).toBeCloseTo(400);
  });
});
