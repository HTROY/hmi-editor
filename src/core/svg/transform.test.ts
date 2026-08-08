import { describe, expect, it } from "vitest";
import {
  decomposeRotateScale,
  multiply,
  parseTransform,
  transformPoint,
} from "./transform";

function expectClose(a: number, b: number, eps = 1e-6): void {
  expect(Math.abs(a - b)).toBeLessThan(eps);
}

describe("SVG transform", () => {
  it("translate + scale 组合正确", () => {
    const m = parseTransform("translate(10, 20) scale(2)");
    const p = transformPoint(m, 5, 5);
    expectClose(p.x, 20);
    expectClose(p.y, 30);
  });

  it("rotate 绕中心旋转", () => {
    const m = parseTransform("rotate(90, 10, 10)");
    const p = transformPoint(m, 10, 5);
    expectClose(p.x, 15);
    expectClose(p.y, 10);
  });

  it("matrix 与 multiply 语义一致", () => {
    const m = parseTransform("matrix(1, 0, 0, 1, 5, 6)");
    expect(transformPoint(m, 1, 1)).toEqual({ x: 6, y: 7 });
    const a = parseTransform("translate(3, 0)");
    const b = parseTransform("scale(2)");
    const p = transformPoint(multiply(a, b), 1, 1);
    expectClose(p.x, 5);
    expectClose(p.y, 2);
  });

  it("skew 无法分解为旋转+缩放", () => {
    const m = parseTransform("skewX(30)");
    expect(decomposeRotateScale(m)).toBeNull();
  });

  it("旋转+缩放可分解", () => {
    const m = parseTransform("rotate(90) scale(2)");
    const d = decomposeRotateScale(m);
    expect(d).not.toBeNull();
    expectClose(d!.rotationDeg, 90);
    expectClose(d!.sx, 2);
    expectClose(d!.sy, 2);
  });
});
