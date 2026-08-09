import { describe, expect, it } from "vitest";
import { CommandHistory } from "./CommandHistory";
import type { ShapeCommand } from "./CommandHistory";
import { SceneGraph } from "../scene";
import { GroupShape, createShape } from "../shapes";
import { applySiblingOrder } from "../inspector/reorder";
import { buildShapeTree } from "../inspector/tree";
import { planUngroup, wrapShapesInGroup } from "../inspector/groupOps";

function addRect(scene: SceneGraph, id: string, x: number) {
  scene.add(createShape("rect", { id, x, y: 0, width: 10, height: 10 }));
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

describe("CommandHistory 子图元路径命令", () => {
  it("undo/redo 按父路径还原子图元快照且不影响兄弟", () => {
    const scene = new SceneGraph();
    const group = addGroup(scene, "g", 0, [
      { id: "c1", zIndex: 0 },
      { id: "c2", zIndex: 1 },
    ]);
    const history = new CommandHistory();
    const child = group.children.find((c) => c.id === "c1")!;
    const before = child.toJSON();
    child.x = 99;
    const after = child.toJSON();

    history.push({ id: "c1", path: ["g"], before, after, index: 0 });

    history.undo(scene);
    expect(group.children.find((c) => c.id === "c1")!.x).toBe(0);
    expect(group.children.find((c) => c.id === "c2")!.x).toBe(0);

    history.redo(scene);
    expect(group.children.find((c) => c.id === "c1")!.x).toBe(99);
  });
});

describe("CommandHistory 换序命令", () => {
  it("顶层换序 undo/redo 恢复展示顺序", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    addRect(scene, "r3", 5);
    const history = new CommandHistory();
    const before = ["r2", "r3", "r1"];
    const after = ["r3", "r2", "r1"];
    applySiblingOrder(scene, [], after);

    history.push({
      id: "r3",
      before: null,
      after: null,
      index: 0,
      reorder: { parentPath: [], before, after },
    });

    history.undo(scene);
    expect(buildShapeTree(scene).map((n) => n.shape.id)).toEqual(before);

    history.redo(scene);
    expect(buildShapeTree(scene).map((n) => n.shape.id)).toEqual(after);
  });

  it("组内子图元换序 undo/redo 恢复数组顺序与 z 序", () => {
    const scene = new SceneGraph();
    const group = addGroup(scene, "g", 0, [
      { id: "a", zIndex: 0 },
      { id: "b", zIndex: 1 },
      { id: "c", zIndex: 2 },
    ]);
    const history = new CommandHistory();
    const before = ["c", "b", "a"];
    const after = ["b", "c", "a"];
    applySiblingOrder(scene, ["g"], after);

    history.push({
      id: "b",
      before: null,
      after: null,
      index: 0,
      reorder: { parentPath: ["g"], before, after },
    });

    history.undo(scene);
    expect(group.children.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(group.children.map((s) => s.zIndex)).toEqual([0, 1, 2]);

    history.redo(scene);
    expect(group.children.map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(group.children.map((s) => s.zIndex)).toEqual([0, 1, 2]);
  });
});

describe("CommandHistory 成组/取消成组批次命令", () => {
  it("撤销成组后恢复原始图元及其子图元", () => {
    const scene = new SceneGraph();
    const r1 = createShape("rect", { id: "r1", x: 0, zIndex: 0 });
    const inner = new GroupShape({
      id: "g1",
      zIndex: 1,
      children: [createShape("rect", { id: "c1" }).toJSON()],
    });
    scene.add(r1);
    scene.add(inner);
    const history = new CommandHistory();

    // 与 store.groupSelected 相同的命令构造
    const shapes = [r1, inner];
    const group = wrapShapesInGroup(shapes, "组");
    const indexes = new Map(
      shapes.map((sh) => [sh.id, scene.getAll().indexOf(sh)])
    );
    const commands: ShapeCommand[] = shapes.map((sh) => ({
      id: sh.id,
      before: sh.toJSON(),
      after: null,
      index: indexes.get(sh.id) ?? 0,
    }));
    for (const sh of shapes) scene.remove(sh.id);
    scene.insertAt(group, 0);
    commands.push({
      id: group.id,
      before: null,
      after: group.toJSON(),
      index: 0,
    });
    history.pushBatch(commands);

    history.undo(scene);

    expect(scene.get("r1")).toBeDefined();
    expect(scene.get("g1")).toBeDefined();
    expect((scene.get("g1") as GroupShape).children.map((c) => c.id)).toEqual([
      "c1",
    ]);
    expect(scene.get(group.id)).toBeUndefined();
  });

  it("撤销取消成组后恢复组及其子图元，子图元不再留在顶层", () => {
    const scene = new SceneGraph();
    const group = new GroupShape({
      id: "g",
      zIndex: 5,
      children: [
        createShape("rect", { id: "c1" }).toJSON(),
        createShape("rect", { id: "c2" }).toJSON(),
      ],
    });
    scene.add(group);
    const history = new CommandHistory();

    // 与 store.ungroupSelected 相同的命令构造（快照必须在展开前捕获）
    const plan = planUngroup(group);
    const children = plan.children;
    const index = scene.getAll().indexOf(group);
    const commands: ShapeCommand[] = [
      { id: group.id, before: plan.groupSnapshot, after: null, index },
    ];
    scene.remove(group.id);
    for (const child of children) {
      commands.push({
        id: child.id,
        before: null,
        after: child.toJSON(),
        index: scene.getAll().length,
      });
      scene.add(child);
    }
    history.pushBatch(commands);

    history.undo(scene);

    const restored = scene.get("g");
    expect(restored).toBeDefined();
    expect((restored as GroupShape).children.map((c) => c.id).sort()).toEqual([
      "c1",
      "c2",
    ]);
    expect(scene.get("c1")).toBeUndefined();
    expect(scene.get("c2")).toBeUndefined();
  });
});

describe("CommandHistory", () => {
  it("undo restores the previous property snapshot and redo re-applies it", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 10);
    const history = new CommandHistory();
    const before = scene.get("r1")!.toJSON();
    scene.get("r1")!.x = 50;
    const after = scene.get("r1")!.toJSON();

    history.push({ id: "r1", before, after, index: 0 });

    history.undo(scene);
    expect(scene.get("r1")!.x).toBe(10);
    expect(history.canRedo).toBe(true);

    history.redo(scene);
    expect(scene.get("r1")!.x).toBe(50);
    expect(history.canUndo).toBe(true);
  });

  it("undo removes an added shape and redo restores it at its original order", () => {
    const scene = new SceneGraph();
    addRect(scene, "base", 0);
    const added = createShape("circle", { id: "c1", x: 100, y: 100 });
    scene.add(added);
    const history = new CommandHistory();
    history.push({
      id: "c1",
      before: null,
      after: added.toJSON(),
      index: scene.getAll().indexOf(added),
    });

    history.undo(scene);
    expect(scene.get("c1")).toBeUndefined();
    expect(scene.count).toBe(1);

    history.redo(scene);
    expect(scene.get("c1")?.type).toBe("circle");
    expect(scene.count).toBe(2);
    expect(scene.getAll().map((s) => s.id)).toEqual(["base", "c1"]);
  });

  it("undo restores a deleted shape at its original order and redo removes it again", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 0);
    addRect(scene, "r2", 10);
    addRect(scene, "r3", 20);
    const target = scene.get("r2")!;
    const history = new CommandHistory();
    history.push({
      id: "r2",
      before: target.toJSON(),
      after: null,
      index: scene.getAll().indexOf(target),
    });
    scene.remove("r2");

    history.undo(scene);
    expect(scene.getAll().map((s) => s.id)).toEqual(["r1", "r2", "r3"]);
    expect(scene.get("r2")!.x).toBe(10);

    history.redo(scene);
    expect(scene.get("r2")).toBeUndefined();
    expect(scene.getAll().map((s) => s.id)).toEqual(["r1", "r3"]);
  });

  it("undo of a zIndex change invalidates the sorted cache", () => {
    const scene = new SceneGraph();
    scene.add(createShape("rect", { id: "r1", x: 0, zIndex: 0 }));
    scene.add(createShape("rect", { id: "r2", x: 10, zIndex: 10 }));
    scene.add(createShape("rect", { id: "r3", x: 20, zIndex: 5 }));
    scene.markDirty();
    expect(scene.getAll().map((s) => s.id)).toEqual(["r1", "r3", "r2"]);

    const history = new CommandHistory();
    const before = scene.get("r3")!.toJSON();
    scene.get("r3")!.zIndex = 20;
    scene.markDirty();
    const after = scene.get("r3")!.toJSON();
    history.push({ id: "r3", before, after, index: 2 });

    history.undo(scene);
    expect(scene.getAll().map((s) => s.id)).toEqual(["r1", "r3", "r2"]);
    expect(scene.get("r3")!.zIndex).toBe(5);
  });

  it("pushing a new command clears the redo stack", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 10);
    const history = new CommandHistory();
    const before = scene.get("r1")!.toJSON();
    scene.get("r1")!.x = 20;
    history.push({
      id: "r1",
      before,
      after: scene.get("r1")!.toJSON(),
      index: 0,
    });
    history.undo(scene);
    expect(history.canRedo).toBe(true);

    const before2 = scene.get("r1")!.toJSON();
    scene.get("r1")!.y = 5;
    history.push({
      id: "r1",
      before: before2,
      after: scene.get("r1")!.toJSON(),
      index: 0,
    });
    expect(history.canRedo).toBe(false);
    expect(history.canUndo).toBe(true);
  });

  it("clear resets both undo and redo stacks", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 10);
    const history = new CommandHistory();
    const before = scene.get("r1")!.toJSON();
    scene.get("r1")!.x = 20;
    history.push({
      id: "r1",
      before,
      after: scene.get("r1")!.toJSON(),
      index: 0,
    });
    history.undo(scene);

    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undoCount).toBe(0);
    expect(history.redoCount).toBe(0);
  });

  it("undo restores every shape in a batch and redo re-applies them", () => {
    const scene = new SceneGraph();
    addRect(scene, "r1", 10);
    addRect(scene, "r2", 20);
    const history = new CommandHistory();
    const before1 = scene.get("r1")!.toJSON();
    scene.get("r1")!.x = 50;
    const before2 = scene.get("r2")!.toJSON();
    scene.get("r2")!.y = 80;
    history.pushBatch([
      {
        id: "r1",
        before: before1,
        after: scene.get("r1")!.toJSON(),
        index: 0,
      },
      {
        id: "r2",
        before: before2,
        after: scene.get("r2")!.toJSON(),
        index: 1,
      },
    ]);

    history.undo(scene);
    expect(scene.get("r1")!.x).toBe(10);
    expect(scene.get("r2")!.y).toBe(0);
    expect(history.canRedo).toBe(true);

    history.redo(scene);
    expect(scene.get("r1")!.x).toBe(50);
    expect(scene.get("r2")!.y).toBe(80);
    expect(history.canUndo).toBe(true);
  });
});
