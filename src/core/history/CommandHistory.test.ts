import { describe, expect, it } from "vitest";
import { CommandHistory } from "./CommandHistory";
import { SceneGraph } from "../scene";
import { createShape } from "../shapes";

function addRect(scene: SceneGraph, id: string, x: number) {
  scene.add(createShape("rect", { id, x, y: 0, width: 10, height: 10 }));
}

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
});
