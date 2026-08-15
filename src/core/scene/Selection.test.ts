import { describe, expect, it } from "vitest";
import { Selection, getSelectedShape } from "./Selection";
import { SceneGraph } from "./SceneGraph";
import { createShape, GroupShape } from "../shapes";
import type { UndoRedoResult } from "./SceneEditor";

describe("Selection 基础状态", () => {
  it("初始为空选中", () => {
    const sel = new Selection();
    expect(sel.primaryId).toBeNull();
    expect(sel.primaryPath).toBeNull();
    expect(sel.multiIds).toEqual([]);
    expect(sel.childPath).toBeNull();
    expect(sel.isEmpty()).toBe(true);
    expect(sel.count).toBe(0);
  });

  it("select(id) 单选顶层图元", () => {
    const sel = new Selection().select("s1");
    expect(sel.primaryId).toBe("s1");
    expect(sel.primaryPath).toEqual(["s1"]);
    expect(sel.multiIds).toEqual(["s1"]);
    expect(sel.childPath).toBeNull();
    expect(sel.isEmpty()).toBe(false);
    expect(sel.contains("s1")).toBe(true);
    expect(sel.isChildSelected).toBe(false);
  });

  it("select(null) 清空选中", () => {
    const sel = new Selection().select("s1").select(null);
    expect(sel.isEmpty()).toBe(true);
    expect(sel.primaryPath).toBeNull();
  });

  it("selectMany 多选：主选中为首个，顺序保留", () => {
    const sel = new Selection().selectMany(["s1", "s2", "s3"]);
    expect(sel.primaryId).toBe("s1");
    expect(sel.primaryPath).toEqual(["s1"]);
    expect(sel.multiIds).toEqual(["s1", "s2", "s3"]);
    expect(sel.count).toBe(3);
    expect(sel.contains("s2")).toBe(true);
    expect(sel.contains("s4")).toBe(false);
  });

  it("selectMany([]) 等价清空", () => {
    const sel = new Selection().selectMany([]);
    expect(sel.isEmpty()).toBe(true);
  });

  it("不可变：旧实例不受后续变更影响", () => {
    const a = new Selection().select("s1");
    const b = a.select("s2");
    expect(a.primaryId).toBe("s1");
    expect(b.primaryId).toBe("s2");
    expect(b).not.toBe(a);
  });
});

describe("Selection 路径选中（图元树）", () => {
  it("selectAt 顶层路径进入多选集合", () => {
    const sel = new Selection().selectAt(["s1"]);
    expect(sel.primaryId).toBe("s1");
    expect(sel.multiIds).toEqual(["s1"]);
    expect(sel.childPath).toBeNull();
  });

  it("selectAt 组内路径只设只读高亮，不进多选集合", () => {
    const sel = new Selection().selectAt(["g1", "c1"]);
    expect(sel.primaryId).toBe("c1");
    expect(sel.primaryPath).toEqual(["g1", "c1"]);
    expect(sel.multiIds).toEqual([]);
    expect(sel.childPath).toEqual(["g1", "c1"]);
    expect(sel.isChildSelected).toBe(true);
  });
});

describe("Selection 撤销/重做结果应用", () => {
  const result = (r: Partial<UndoRedoResult>): UndoRedoResult => ({
    keepSelection: false,
    selected: null,
    ...r,
  });

  it("null 结果不动选中（同一实例）", () => {
    const sel = new Selection().select("s1");
    expect(sel.applyUndoRedo(null)).toBe(sel);
  });

  it("keepSelection 不动选中（同一实例）", () => {
    const sel = new Selection().select("s1");
    expect(
      sel.applyUndoRedo(result({ keepSelection: true }))
    ).toBe(sel);
  });

  it("selected 为 null 时清空选中", () => {
    const sel = new Selection().select("s1");
    const next = sel.applyUndoRedo(result({ selected: null }));
    expect(next.isEmpty()).toBe(true);
  });

  it("恢复顶层图元选中", () => {
    const sel = new Selection();
    const next = sel.applyUndoRedo(
      result({ selected: { id: "s1", path: ["s1"], isChild: false } })
    );
    expect(next.primaryId).toBe("s1");
    expect(next.multiIds).toEqual(["s1"]);
    expect(next.childPath).toBeNull();
  });

  it("恢复组内子图元只读高亮", () => {
    const sel = new Selection();
    const next = sel.applyUndoRedo(
      result({ selected: { id: "c1", path: ["g1", "c1"], isChild: true } })
    );
    expect(next.primaryId).toBe("c1");
    expect(next.multiIds).toEqual([]);
    expect(next.childPath).toEqual(["g1", "c1"]);
    expect(next.isChildSelected).toBe(true);
  });
});

describe("getSelectedShape", () => {
  it("顶层图元按主选中路径解析", () => {
    const scene = new SceneGraph();
    const shape = createShape("rect", { id: "s1", x: 0, y: 0 });
    scene.add(shape);
    const sel = new Selection().select("s1");
    expect(getSelectedShape(scene, sel)).toBe(shape);
  });

  it("组内子图元按完整路径解析", () => {
    const scene = new SceneGraph();
    const group = createShape("group", { id: "g1", x: 0, y: 0 }) as GroupShape;
    const child = createShape("circle", { id: "c1", x: 5, y: 5 });
    group.children.push(child);
    scene.add(group);
    const sel = new Selection().selectAt(["g1", "c1"]);
    expect(getSelectedShape(scene, sel)).toBe(child);
  });

  it("无选中或路径失效时返回 null", () => {
    const scene = new SceneGraph();
    expect(getSelectedShape(scene, new Selection())).toBeNull();
    expect(
      getSelectedShape(scene, new Selection().select("missing"))
    ).toBeNull();
  });
});
