import { describe, expect, it } from "vitest";
import { BindingEngine } from "./BindingEngine";
import { SceneGraph } from "../scene/SceneGraph";
import { createShape, GroupShape } from "../shapes";
import { VariableManager } from "../variables";
import type { Binding } from "../types";

const bind = (
  variableId: string,
  targetProp: string,
  extra: Partial<Binding> = {}
): Binding => ({
  variableId,
  variableType: "AI",
  targetProp,
  mapping: { type: "direct" },
  smooth: false,
  ...extra,
});

const indexOf = (engine: BindingEngine) =>
  (engine as unknown as { index: Map<string, unknown[]> }).index;

const rect = (id: string) => createShape("rect", { id, x: 0, y: 0 });

/** 定义 AI 变量（数值直通，不受 DI/DO 归一化影响） */
const defineVar = (vars: VariableManager, id: string, defaultValue = 0) => {
  vars.define({
    id,
    name: id,
    type: "AI",
    address: "",
    defaultValue,
    unit: "",
    description: "",
    group: "",
    min: 0,
    max: 1000,
  });
};

describe("BindingEngine 反向索引", () => {
  it("rebuildIndex 从场景绑定建立 variableId → 图元索引", () => {
    const scene = new SceneGraph();
    const sh = rect("s1");
    sh.bindings = [bind("V1", "x")];
    scene.add(sh);
    const engine = new BindingEngine(scene, new VariableManager());
    engine.rebuildIndex();
    expect(indexOf(engine).get("V1")?.length).toBe(1);
  });

  it("组内子图元按完整路径进索引", () => {
    const scene = new SceneGraph();
    const group = createShape("group", {
      id: "g1",
      x: 0,
      y: 0,
      children: [rect("c1").toJSON()],
    }) as GroupShape;
    group.children[0].bindings = [bind("V1", "x")];
    scene.add(group);
    const engine = new BindingEngine(scene, new VariableManager());
    engine.rebuildIndex();
    const records = indexOf(engine).get("V1") ?? [];
    expect(records.length).toBe(1);
    expect((records[0] as { path: string[] }).path).toEqual(["g1", "c1"]);
  });

  it("reindexPath 清除旧记录并立即应用变量当前值", () => {
    const scene = new SceneGraph();
    const vars = new VariableManager();
    vars.define({
      id: "V1",
      name: "v",
      type: "DI",
      address: "",
      defaultValue: 42,
      unit: "",
      description: "",
      group: "",
      min: 0,
      max: 1,
    });
    const sh = rect("s1");
    scene.add(sh);
    const engine = new BindingEngine(scene, vars);
    engine.rebuildIndex();
    // 给 s1 加绑定后按路径重建：索引更新且当前值立即应用
    sh.bindings = [bind("V1", "x")];
    engine.reindexPath(["s1"]);
    expect(sh.x).toBe(42);
    expect(indexOf(engine).get("V1")?.length).toBe(1);
    // 图元被移除后按路径重建：记录清除
    scene.remove("s1");
    engine.reindexPath(["s1"]);
    expect(indexOf(engine).get("V1")).toBeUndefined();
  });
});

describe("BindingEngine 值映射与平滑过渡", () => {
  it("变量变化经映射立即写入图元属性（smooth=false）", () => {
    const scene = new SceneGraph();
    const sh = rect("s1");
    sh.bindings = [bind("V1", "x")];
    scene.add(sh);
    const vars = new VariableManager();
    defineVar(vars, "V1");
    const engine = new BindingEngine(scene, vars);
    engine.start();
    vars.setValue("V1", 77);
    expect(sh.x).toBe(77);
    engine.stop();
  });

  it("smooth=true 时按注入时钟插值，最终到达目标值", () => {
    let now = 0;
    const scene = new SceneGraph();
    const sh = rect("s1");
    sh.bindings = [bind("V1", "x", { smooth: true, smoothMs: 300 })];
    scene.add(sh);
    const vars = new VariableManager();
    defineVar(vars, "V1");
    const engine = new BindingEngine(scene, vars, () => now);
    engine.start();
    now = 100;
    vars.setValue("V1", 100);
    // 过渡进行中：不跳变
    now = 100 + 150;
    engine.tick(now);
    expect(sh.x).toBeGreaterThan(0);
    expect(sh.x).toBeLessThan(100);
    // 到达终点
    now = 100 + 300;
    engine.tick(now);
    expect(sh.x).toBe(100);
    engine.stop();
  });

  it("重复触发覆盖目标：过渡收敛到最新值", () => {
    let now = 0;
    const scene = new SceneGraph();
    const sh = rect("s1");
    sh.bindings = [bind("V1", "x", { smooth: true, smoothMs: 300 })];
    scene.add(sh);
    const vars = new VariableManager();
    defineVar(vars, "V1");
    const engine = new BindingEngine(scene, vars, () => now);
    engine.start();
    now = 100;
    vars.setValue("V1", 100);
    now = 200;
    vars.setValue("V1", 50); // 中途改目标
    now = 200 + 300;
    engine.tick(now);
    expect(sh.x).toBe(50);
    engine.stop();
  });
});
