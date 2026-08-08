import { describe, expect, it } from "vitest";
import { createShape } from "../shapes";
import {
  applyAnimationToPoint,
  inverseAnimationToStatic,
} from "./animationGeometry";
import { getAnimatedAABB } from "./resize";

describe("animationGeometry 动画几何变换", () => {
  it("正向与逆向互为反变换（位移 + 旋转 + 缩放）", () => {
    const r = createShape("rect", { x: 100, y: 50, width: 100, height: 50 });
    const anim = { dx: 30, dy: -20, rotation: 45, scaleX: 1.2, scaleY: 0.8 };
    const p = { x: 130, y: 80 };
    const world = applyAnimationToPoint(r, p, anim);
    const back = inverseAnimationToStatic(r, world, anim);
    expect(back.x).toBeCloseTo(p.x, 8);
    expect(back.y).toBeCloseTo(p.y, 8);
  });

  it("无几何变化的动画帧状态返回原坐标", () => {
    const r = createShape("rect", { x: 10, y: 20, width: 30, height: 40 });
    const p = { x: 25, y: 40 };
    expect(applyAnimationToPoint(r, p, { opacity: 0.5 })).toEqual(p);
    expect(inverseAnimationToStatic(r, p, { hueRotate: 90 })).toEqual(p);
  });
});

describe("getAnimatedAABB 动画选中框", () => {
  it("位移动画的 AABB 跟随移动", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 50 });
    expect(getAnimatedAABB(r, { dx: 30 })).toEqual({
      x: 30,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("缩放动画围绕中心放大 AABB", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 50 });
    expect(getAnimatedAABB(r, { scaleX: 2, scaleY: 2 })).toEqual({
      x: -50,
      y: -25,
      width: 200,
      height: 100,
    });
  });

  it("旋转动画按旋转后的外接框计算", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 50 });
    const bb = getAnimatedAABB(r, { rotation: 90 });
    expect(bb.x).toBeCloseTo(25, 6);
    expect(bb.y).toBeCloseTo(-25, 6);
    expect(bb.width).toBeCloseTo(50, 6);
    expect(bb.height).toBeCloseTo(100, 6);
  });
});
