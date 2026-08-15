import { describe, it, expect } from "vitest";
import { createShape } from "./factory";
import { capabilityOf, shapeCapabilities } from "./capability";
import type { ShapeType } from "../types";

/** 与 factory.createShape 的 switch 同步维护的类型全集（编译期由 Record<ShapeType, _> 双重约束） */
const ALL_TYPES: ShapeType[] = [
  "rect",
  "circle",
  "line",
  "polyline",
  "polygon",
  "text",
  "path",
  "image",
  "group",
  "metro-breaker",
  "metro-busbar",
  "metro-fan",
  "metro-signal",
  "metro-gauge",
  "metro-transformer",
];

describe("图元能力表（切片 1 骨架）", () => {
  it("全部 15 类型都有能力条目且 type 自洽（运行期穷尽兜底）", () => {
    expect(Object.keys(shapeCapabilities)).toHaveLength(15);
    for (const t of ALL_TYPES) {
      expect(shapeCapabilities[t]).toBeDefined();
      expect(shapeCapabilities[t].type).toBe(t);
    }
  });

  it("行为承载条目按类型就近定义（切片 2）", () => {
    for (const t of ["line", "group", "text", "path", "polyline", "polygon"]) {
      expect(shapeCapabilities[t as ShapeType].resize).toBeTypeOf("function");
    }
    for (const t of [
      "metro-breaker",
      "metro-busbar",
      "metro-fan",
      "metro-signal",
      "metro-gauge",
      "metro-transformer",
    ]) {
      expect(shapeCapabilities[t as ShapeType].uniformOnly).toBe(true);
    }
    // rect 类零行为：无 resize 覆盖，走共享 boxResize
    for (const t of ["rect", "circle", "image"]) {
      expect(shapeCapabilities[t as ShapeType].resize).toBeUndefined();
      expect(shapeCapabilities[t as ShapeType].uniformOnly).toBeUndefined();
    }
  });

  it("点集几何与 props 包围盒按类型就近定义（切片 3）", () => {
    for (const t of ["line", "polyline", "polygon"]) {
      const cap = shapeCapabilities[t as ShapeType];
      expect(cap.points).toBeDefined();
      expect(cap.boundsFromProps).toBeTypeOf("function");
    }
    for (const t of ["rect", "circle", "text", "path", "image", "group"]) {
      const cap = shapeCapabilities[t as ShapeType];
      expect(cap.points).toBeUndefined();
      expect(cap.boundsFromProps).toBeUndefined();
    }
    // 点集读写往返：line 两端点、polygon 点集
    const line = createShape("line", {
      startPoint: { x: 1, y: 2 },
      endPoint: { x: 3, y: 4 },
    });
    const lp = shapeCapabilities.line.points!;
    expect(lp.get(line)).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    lp.set(line, [{ x: 5, y: 6 }, { x: 7, y: 8 }]);
    const ll = line as unknown as { startPoint: { x: number; y: number } };
    expect(ll.startPoint).toEqual({ x: 5, y: 6 });
  });

  it("可绑定属性注册表按类型登记（切片 4）", () => {
    for (const t of ALL_TYPES) {
      const bp = shapeCapabilities[t].bindableProps;
      expect(bp).toBeDefined();
      for (const base of ["x", "y", "width", "height", "rotation", "opacity", "visible", "stroke", "strokeWidth"]) {
        expect(bp![base]).toBeDefined();
      }
    }
    // metro 三类型填充为派生状态，不可绑定
    for (const t of [
      "metro-breaker",
      "metro-fan",
      "metro-signal",
    ] as ShapeType[]) {
      expect(shapeCapabilities[t].bindableProps!.fill).toBeUndefined();
    }
    // 逐类型附加
    expect(shapeCapabilities.rect.bindableProps!.cornerRadius.kind).toBe("number");
    expect(shapeCapabilities.text.bindableProps!.text.kind).toBe("string");
    expect(shapeCapabilities.text.bindableProps!.fontSize.kind).toBe("number");
    expect(shapeCapabilities["metro-gauge"].bindableProps!.value.kind).toBe("number");
    expect(shapeCapabilities["metro-fan"].bindableProps!.speedPercent.kind).toBe("number");
    // 类型化读写往返
    const rect = createShape("rect", { x: 1, y: 2 });
    const xp = shapeCapabilities.rect.bindableProps!.x;
    expect(xp.get(rect)).toBe(1);
    xp.set(rect, 42);
    expect(rect.x).toBe(42);
  });

  it("逐类型动画推进（切片 5）", () => {
    expect(shapeCapabilities["metro-fan"].advanceAnimation).toBeTypeOf("function");
    expect(shapeCapabilities.rect.advanceAnimation).toBeUndefined();
    // 运行中的风机推进一帧返回 true；停止的风机返回 false（不触发重绘）
    const fan = createShape("metro-fan", { running: true, speedPercent: 50 });
    expect(shapeCapabilities["metro-fan"].advanceAnimation!(fan, 16)).toBe(true);
    const stopped = createShape("metro-fan", { running: false });
    expect(shapeCapabilities["metro-fan"].advanceAnimation!(stopped, 16)).toBe(false);
  });

  it("检查器编辑描述按类型登记（切片 6）", () => {
    const keysOf = (t: ShapeType) =>
      (shapeCapabilities[t].editor ?? []).map((d) => d.key);
    expect(keysOf("rect")).toEqual(["cornerRadius"]);
    expect(keysOf("text")).toEqual(["text", "fontSize"]);
    expect(keysOf("path")).toEqual(["d"]);
    expect(keysOf("group")).toEqual(["children"]);
    expect(keysOf("image")).toEqual(["src"]);
    expect(keysOf("metro-breaker")).toEqual(["breakerStatus", "showLabel"]);
    expect(keysOf("metro-busbar")).toEqual(["voltageLevel", "energized"]);
    expect(keysOf("metro-fan")).toEqual(["running", "speedPercent", "bladeColor"]);
    expect(keysOf("metro-signal")).toEqual(["signalColor", "blinking", "label", "labelPosition"]);
    expect(keysOf("metro-gauge")).toEqual(["value", "min", "max", "unit"]);
    expect(keysOf("metro-transformer")).toEqual(["primaryVoltage", "secondaryVoltage", "ratedPower", "energized"]);
    for (const t of ["line", "polyline", "polygon", "circle"] as ShapeType[]) {
      expect(shapeCapabilities[t].editor).toBeUndefined();
    }
    // 风机联动规则住在条目里
    const fanRunning = shapeCapabilities["metro-fan"].editor!.find((d) => d.key === "running")!;
    const written: Record<string, unknown> = {};
    fanRunning.sideEffects!(createShape("metro-fan", {}), false, (k, v) => { written[k] = v; });
    expect(written.speedPercent).toBe(0);
  });

  it("capabilityOf 接受实例与类型字符串", () => {
    expect(capabilityOf("rect")).toBe(shapeCapabilities.rect);
    const breaker = createShape("metro-breaker", {});
    expect(capabilityOf(breaker)).toBe(shapeCapabilities["metro-breaker"]);
    expect(capabilityOf(breaker.type)).toBe(shapeCapabilities["metro-breaker"]);
  });

  it("未知类型运行时抛错（防御 as 强转的脏数据）", () => {
    expect(() => capabilityOf("warp-drive" as ShapeType)).toThrow(
      /能力条目/
    );
  });
});