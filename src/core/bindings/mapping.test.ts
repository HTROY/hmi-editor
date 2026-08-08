import { describe, expect, it } from "vitest";
import { applyValueMapping } from "./mapping";

describe("applyValueMapping", () => {
  it("direct 原样返回", () => {
    expect(applyValueMapping({ type: "direct" }, 42)).toBe(42);
    expect(applyValueMapping({ type: "direct" }, true)).toBe(true);
  });

  it("enum 按字符串键查表，未命中回退原值", () => {
    const mapping = {
      type: "enum" as const,
      map: { "0": "#808080", "1": "#00FF00" },
    };
    expect(applyValueMapping(mapping, 1)).toBe("#00FF00");
    expect(applyValueMapping(mapping, 2)).toBe(2);
  });

  it("range 线性映射并四舍五入到百分位", () => {
    const mapping = {
      type: "range" as const,
      from: [0, 100] as [number, number],
      to: [0, 270] as [number, number],
    };
    expect(applyValueMapping(mapping, 50)).toBe(135);
    expect(applyValueMapping(mapping, 100)).toBe(270);
    expect(applyValueMapping(mapping, 0)).toBe(0);
  });

  it("range 输入区间为 0 时输出起点", () => {
    const mapping = {
      type: "range" as const,
      from: [50, 50] as [number, number],
      to: [10, 20] as [number, number],
    };
    expect(applyValueMapping(mapping, 50)).toBe(10);
  });

  it("stateColor 数字转十六进制颜色、布尔转绿/灰", () => {
    expect(applyValueMapping({ type: "stateColor" }, 0xff0000)).toBe("#ff0000");
    expect(applyValueMapping({ type: "stateColor" }, true)).toBe("#00FF00");
    expect(applyValueMapping({ type: "stateColor" }, false)).toBe("#808080");
  });

  it("bitmask 返回命中的状态名列表", () => {
    const mapping = {
      type: "bitmask" as const,
      bits: [0, 1, 2],
      states: { 1: "运行", 2: "报警", 4: "故障" },
    };
    expect(applyValueMapping(mapping, 5)).toEqual(["运行", "故障"]);
    expect(applyValueMapping(mapping, 0)).toEqual([]);
  });
});
