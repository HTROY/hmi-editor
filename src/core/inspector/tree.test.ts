import { describe, expect, it } from "vitest";
import { SceneGraph } from "../scene";
import { GroupShape, createShape } from "../shapes";
import { buildShapeTree, forEachShape, resolveShape } from "./tree";

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

describe("buildShapeTree", () => {
  it("顶层图元按 z 序从最上层排到最下层", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    addRect(scene, "r3", 5);
    expect(buildShapeTree(scene).map((n) => n.shape.id)).toEqual([
      "r2",
      "r3",
      "r1",
    ]);
  });

  it("组内子图元递归成节点，且子图元按 z 序从最上层排到最下层", () => {
    const scene = new SceneGraph();
    addGroup(scene, "g", 10, [
      { id: "c1", zIndex: 0 },
      { id: "c2", zIndex: 10 },
    ]);
    const nodes = buildShapeTree(scene);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children.map((n) => n.shape.id)).toEqual(["c2", "c1"]);
    expect(nodes[0].children.map((n) => n.path)).toEqual([
      ["g", "c2"],
      ["g", "c1"],
    ]);
  });

  it("嵌套组递归展开为深层路径", () => {
    const scene = new SceneGraph();
    const inner = addGroup(scene, "inner", 0, [{ id: "r", zIndex: 0 }]);
    const outer = new GroupShape({
      id: "outer",
      zIndex: 10,
      children: [inner.toJSON()],
    });
    scene.remove("inner");
    scene.add(outer);
    const leaf = buildShapeTree(scene)[0].children[0].children[0];
    expect(leaf.path).toEqual(["outer", "inner", "r"]);
  });
});

describe("resolveShape", () => {
  it("按路径解析顶层图元", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    expect(resolveShape(scene, ["r1"])?.id).toBe("r1");
  });

  it("按路径解析组内子图元", () => {
    const scene = new SceneGraph();
    addGroup(scene, "g", 0, [{ id: "c1", zIndex: 0 }]);
    expect(resolveShape(scene, ["g", "c1"])?.id).toBe("c1");
  });

  it("路径中间不是组时返回 null", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    expect(resolveShape(scene, ["r1", "ghost"])).toBeNull();
  });

  it("未知路径返回 null", () => {
    const scene = new SceneGraph();
    expect(resolveShape(scene, ["missing"])).toBeNull();
    expect(resolveShape(scene, [])).toBeNull();
  });
});

describe("forEachShape", () => {
  it("遍历顶层与全部子图元并给出完整路径", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addGroup(scene, "g", 10, [
      { id: "c1", zIndex: 0 },
      { id: "c2", zIndex: 5 },
    ]);
    const seen: string[][] = [];
    forEachShape(scene, (shape, path) => seen.push([shape.id, path.join(">")]));
    expect(seen).toEqual([
      ["r1", "r1"],
      ["g", "g"],
      ["c1", "g>c1"],
      ["c2", "g>c2"],
    ]);
  });
});
