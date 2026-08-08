import { describe, expect, it } from "vitest";
import { SceneGraph } from "../scene";
import { createShape } from "../shapes";
import { VariableManager } from "../variables";
import { BindingEngine } from "./BindingEngine";
import type { Binding } from "../types";

function setup() {
  const scene = new SceneGraph();
  const variables = new VariableManager();
  let now = 1000;
  const engine = new BindingEngine(scene, variables, () => now);
  variables.define({
    id: "v1",
    name: "测试变量",
    type: "AI",
    address: "0",
    defaultValue: 0,
    unit: "",
    description: "",
    group: "test",
    min: 0,
    max: 100,
  });
  const shape = createShape("rect", { id: "r1", opacity: 0, fill: "#000000" });
  scene.add(shape);
  engine.start();
  return { scene, variables, engine, shape, tick: (ms: number) => (now = ms) };
}

const numericBinding = (overrides: Partial<Binding> = {}): Binding => ({
  variableId: "v1",
  variableType: "AI",
  targetProp: "opacity",
  mapping: { type: "direct" },
  smooth: true,
  smoothMs: 300,
  ...overrides,
});

describe("BindingEngine 平滑过渡", () => {
  it("数值属性默认 300ms ease-out 过渡到目标值", () => {
    const { shape, engine, tick } = setup();
    shape.bindings = [numericBinding()];
    engine.reindexShape("r1");

    engine.trigger("v1", 1);
    expect(shape.opacity).toBeCloseTo(0);

    tick(1000 + 150);
    engine.tick(1150);
    // ease-out cubic: 1-(1-0.5)^3 = 0.875
    expect(shape.opacity).toBeCloseTo(0.875, 5);

    tick(1000 + 300);
    engine.tick(1300);
    expect(shape.opacity).toBe(1);
  });

  it("smooth:false 时立即生效", () => {
    const { shape, engine } = setup();
    shape.bindings = [numericBinding({ smooth: false })];
    engine.reindexShape("r1");

    engine.trigger("v1", 0.6);
    expect(shape.opacity).toBe(0.6);
  });

  it("颜色/字符串属性不平滑，直接赋值", () => {
    const { shape, engine } = setup();
    shape.bindings = [
      {
        variableId: "v1",
        variableType: "AI",
        targetProp: "fill",
        mapping: { type: "stateColor" },
        smooth: true,
      },
    ];
    engine.reindexShape("r1");

    engine.trigger("v1", 0x00ff00);
    expect(shape.fill).toBe("#00ff00");
  });

  it("过渡期间变量再次变化时从当前值平滑到新目标", () => {
    const { shape, engine, tick } = setup();
    shape.bindings = [numericBinding()];
    engine.reindexShape("r1");

    engine.trigger("v1", 1);
    tick(1000 + 100);
    engine.tick(1100);
    const mid = shape.opacity;
    engine.trigger("v1", 0);
    tick(1000 + 100);
    engine.tick(1100);
    expect(shape.opacity).toBeCloseTo(mid);
  });

  it("reindexShape 用当前变量值触发平滑而非跳变", () => {
    const { shape, variables, engine } = setup();
    variables.setValue("v1", 1);
    shape.bindings = [numericBinding()];
    engine.reindexShape("r1");
    expect(shape.opacity).toBeCloseTo(0);
  });
});
