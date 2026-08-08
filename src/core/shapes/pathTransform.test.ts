import { describe, expect, it } from "vitest";
import {
  getPathBounds,
  transformPathData,
  transformPathDataMatrix,
  translatePathData,
} from "./pathTransform";

describe("path 数据变换", () => {
  it("等比缩放改写坐标", () => {
    const out = transformPathData("M0 0 L10 20 H30 Z", 2, 2);
    expect(out).toContain("L20 40");
    expect(out).toContain("H60");
  });

  it("矩阵变换旋转路径", () => {
    const d = transformPathDataMatrix("M0 0 L10 0 L10 10 Z", {
      a: 0,
      b: 1,
      c: -1,
      d: 0,
      e: 0,
      f: 0,
    });
    expect(d).toContain("M0 0");
    expect(d).toContain("L0 10");
    expect(d).toContain("L-10 10");
  });

  it("平移路径", () => {
    const d = translatePathData("M0 0 L5 5", 10, 20);
    expect(d).toBe("M10 20 L15 25");
  });

  it("计算路径包围盒", () => {
    const bb = getPathBounds("M5 5 L50 10 C60 20 70 30 80 40 L10 90 Z");
    expect(bb.x).toBe(5);
    expect(bb.y).toBe(5);
    expect(bb.width).toBe(75);
    expect(bb.height).toBe(85);
  });

  it("弧线参与包围盒计算（半圆高度约为半径）", () => {
    const bb = getPathBounds("M0 0 A50 50 0 0 1 100 0 Z");
    expect(Math.abs(bb.width - 100)).toBeLessThan(0.1);
    expect(Math.abs(bb.height - 50)).toBeLessThan(0.1);
  });

  it("相对命令与 H/V 转换为绝对后变换正确", () => {
    const d = transformPathDataMatrix("m10 10 h20 v20 l5 5", {
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: 100,
      f: 200,
    });
    expect(d).toContain("M120 220");
    expect(d).toContain("L160 220");
    expect(d).toContain("L160 260");
    expect(d).toContain("L170 270");
  });
});
