import { describe, expect, it } from "vitest";
import { SceneGraph } from "../scene";
import { GroupShape, createShape } from "../shapes";
import { buildShapeTree } from "./tree";
import { applySiblingOrder, getSiblingList, reorderSibling } from "./reorder";

function addRect(scene: SceneGraph, id: string, zIndex: number) {
  scene.add(createShape("rect", { id, zIndex }));
}

function addGroup(
  scene: SceneGraph,
  id: string,
  zIndex: number,
  children: { id: string; zIndex: number }[]
) {
  const group = new GroupShape({
    id,
    zIndex,
    children: children.map((c) =>
      createShape("rect", { id: c.id, zIndex: c.zIndex }).toJSON()
    ),
  });
  scene.add(group);
  return group;
}

describe("getSiblingList", () => {
  it("顶层图元按最上层优先返回", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    addRect(scene, "r3", 5);
    expect(getSiblingList(scene, ["r3"])?.map((s) => s.id)).toEqual([
      "r2",
      "r3",
      "r1",
    ]);
  });

  it("组内子图元按最上层优先返回", () => {
    const scene = new SceneGraph();
    addGroup(scene, "g", 0, [
      { id: "a", zIndex: 0 },
      { id: "b", zIndex: 10 },
      { id: "c", zIndex: 5 },
    ]);
    expect(getSiblingList(scene, ["g", "c"])?.map((s) => s.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("reorderSibling", () => {
  it("顶层换序后树序与 z 序同步归一", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    addRect(scene, "r3", 5);
    const result = reorderSibling(scene, ["r3"], 0);
    expect(result).toEqual({
      before: ["r2", "r3", "r1"],
      after: ["r3", "r2", "r1"],
    });
    expect(buildShapeTree(scene).map((n) => n.shape.id)).toEqual([
      "r3",
      "r2",
      "r1",
    ]);
    expect(scene.getAll().map((s) => s.id)).toEqual(["r1", "r2", "r3"]);
    expect(scene.get("r1")!.zIndex).toBe(0);
    expect(scene.get("r2")!.zIndex).toBe(1);
    expect(scene.get("r3")!.zIndex).toBe(2);
  });

  it("组内子图元换序后数组顺序与 z 序同步归一", () => {
    const scene = new SceneGraph();
    const group = addGroup(scene, "g", 0, [
      { id: "a", zIndex: 0 },
      { id: "b", zIndex: 1 },
      { id: "c", zIndex: 2 },
    ]);
    const result = reorderSibling(scene, ["g", "b"], 0);
    expect(result).toEqual({
      before: ["c", "b", "a"],
      after: ["b", "c", "a"],
    });
    expect(group.children.map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(group.children.map((s) => s.zIndex)).toEqual([0, 1, 2]);
    expect(buildShapeTree(scene)[0].children.map((n) => n.shape.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("目标下标越界时收敛到有效范围", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    const up = reorderSibling(scene, ["r2"], -5);
    expect(up?.after).toEqual(["r2", "r1"]);
    const down = reorderSibling(scene, ["r2"], 99);
    expect(down?.after).toEqual(["r1", "r2"]);
  });

  it("非法路径返回 null 且场景不变", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    expect(reorderSibling(scene, ["missing"], 0)).toBeNull();
    expect(reorderSibling(scene, [], 0)).toBeNull();
    expect(scene.count).toBe(1);
  });
});

describe("applySiblingOrder", () => {
  it("按展示顺序应用顶层 z 序", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    addRect(scene, "r3", 5);
    applySiblingOrder(scene, [], ["r3", "r2", "r1"]);
    expect(scene.getAll().map((s) => s.id)).toEqual(["r1", "r2", "r3"]);
    expect(buildShapeTree(scene).map((n) => n.shape.id)).toEqual([
      "r3",
      "r2",
      "r1",
    ]);
  });

  it("按展示顺序应用组内子图元顺序", () => {
    const scene = new SceneGraph();
    const group = addGroup(scene, "g", 0, [
      { id: "a", zIndex: 0 },
      { id: "b", zIndex: 1 },
      { id: "c", zIndex: 2 },
    ]);
    applySiblingOrder(scene, ["g"], ["b", "c", "a"]);
    expect(group.children.map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(group.children.map((s) => s.zIndex)).toEqual([0, 1, 2]);
  });
});
