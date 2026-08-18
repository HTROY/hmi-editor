import { describe, expect, it } from "vitest";
import { SceneGraph, SceneEditor } from "./index";
import { createShape, GroupShape, MetroBreaker } from "../shapes";
import { VariableManager } from "../variables";
import { BindingEngine } from "../bindings";

function makeEditor() {
  const scene = new SceneGraph();
  const varManager = new VariableManager();
  const bindingEngine = new BindingEngine(scene, varManager);
  const events: string[] = [];
  const editor = new SceneEditor({
    scene,
    bindingEngine,
    callbacks: {
      onEditApplied: () => events.push("edit"),
      onHistoryApplied: () => events.push("history"),
      onHistorySwap: () => events.push("swap"),
    },
  });
  return { scene, editor, events, bindingEngine };
}

const indexOf = (bindingEngine: BindingEngine) =>
  (bindingEngine as unknown as { index: Map<string, unknown[]> }).index;

const rect = (id: string, x = 0) =>
  createShape("rect", { id, x, y: 0, width: 100, height: 50 });

describe("SceneEditor 撤销/重做", () => {
  it("属性修改命令：undo 恢复快照并选中，redo 重新应用", () => {
    const { scene, editor } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.updateShape("a", { x: 42 });

    const u = editor.undo();
    expect(u).toEqual({
      keepSelection: false,
      selected: { id: "a", path: ["a"], isChild: false },
    });
    expect(scene.get("a")!.x).toBe(0);

    const r = editor.redo();
    expect(r).toEqual({
      keepSelection: false,
      selected: { id: "a", path: ["a"], isChild: false },
    });
    expect(scene.get("a")!.x).toBe(42);
  });

  it("新增命令：undo 删除图元并清除选中，redo 按原 z 序恢复", () => {
    const { scene, editor } = makeEditor();
    editor.activatePage("p1");
    const sh = editor.addShape({ type: "rect", id: "b" });

    const u = editor.undo();
    expect(scene.get("b")).toBeUndefined();
    expect(u!.selected).toBeNull();

    const r = editor.redo();
    expect(scene.get("b")).toBeDefined();
    expect(r!.selected).toEqual({ id: "b", path: ["b"], isChild: false });
    expect(sh.id).toBe("b");
  });

  it("删除命令：undo 按原 z 序恢复图元并选中", () => {
    const { scene, editor } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    expect(editor.deleteShape("a")).toBe(true);

    const u = editor.undo();
    expect(scene.get("a")).toBeDefined();
    expect(u!.selected).toEqual({ id: "a", path: ["a"], isChild: false });
  });

  it("子图元命令：undo 恢复子图元并返回 isChild 选中结果", () => {
    const { scene, editor } = makeEditor();
    const group = createShape("group", {
      id: "g",
      x: 0,
      y: 0,
      children: [rect("c1", 5).toJSON()],
    }) as GroupShape;
    scene.add(group);
    editor.activatePage("p1");
    editor.updateShapeAt(["g", "c1"], { x: 99 });
    expect(group.children[0].x).toBe(99);

    const u = editor.undo();
    expect(group.children[0].x).toBe(5);
    expect(u!.selected).toEqual({
      id: "c1",
      path: ["g", "c1"],
      isChild: true,
    });
  });

  it("addShapes 批量新增：undo 整体回退并清除选中", () => {
    const { scene, editor } = makeEditor();
    editor.activatePage("p1");
    editor.addShapes([rect("a"), rect("b")]);

    expect(scene.count).toBe(2);
    const u = editor.undo();
    expect(scene.count).toBe(0);
    expect(u!.selected).toBeNull();
  });

  it("换序命令：undo 恢复顺序且 keepSelection 不动选中", () => {
    const { scene, editor } = makeEditor();
    const a = rect("a");
    const b = rect("b");
    a.zIndex = 0;
    b.zIndex = 1;
    scene.add(a);
    scene.add(b);
    editor.activatePage("p1");
    editor.reorder(["a"], 0); // a 换到最上层

    const u = editor.undo();
    expect(u!.keepSelection).toBe(true);
    expect(scene.getAll().map((s) => s.id)).toEqual(["a", "b"]);
    const r = editor.redo();
    expect(r!.keepSelection).toBe(true);
    expect(scene.getAll().map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("无可撤销时返回 null", () => {
    const { editor } = makeEditor();
    editor.activatePage("p1");
    expect(editor.undo()).toBeNull();
    expect(editor.redo()).toBeNull();
  });

  it("历史按页面隔离：切页后互不干扰", () => {
    const { editor } = makeEditor();
    editor.activatePage("p1");
    editor.addShape({ type: "rect", id: "a" });

    editor.activatePage("p2");
    expect(editor.undo()).toBeNull();

    editor.activatePage("p1");
    expect(editor.undo()).not.toBeNull();
  });

  it("resetHistories 清空全部历史", () => {
    const { editor } = makeEditor();
    editor.activatePage("p1");
    editor.addShape({ type: "rect", id: "a" });
    editor.resetHistories("p1");
    expect(editor.undo()).toBeNull();
  });

  it("回调：动词触发 history，undo 触发 edit + history，activatePage 触发 swap", () => {
    const { editor, events } = makeEditor();
    editor.activatePage("p1");
    editor.addShape({ type: "rect", id: "a" });
    editor.undo();
    expect(events).toEqual(["swap", "history", "edit", "edit", "history"]);
  });
});

describe("SceneEditor 图元编辑动词", () => {
  it("updateShapeAt 应用属性并记录可撤销命令", () => {
    const { scene, editor } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.updateShapeAt(["a"], { x: 42 });
    expect(sh.x).toBe(42);
    editor.undo();
    expect(sh.x).toBe(0);
  });

  it("updateShapeAt 带 bindings 时重建绑定索引", () => {
    const { scene, editor, bindingEngine } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.updateShapeAt(["a"], {
      bindings: [
        {
          variableId: "V1",
          variableType: "DI",
          targetProp: "fill",
          mapping: { type: "direct" },
          smooth: false,
        },
      ],
    });
    expect(indexOf(bindingEngine).get("V1")?.length).toBe(1);
  });

  it("MetroBreaker 经 applyProps 走 setStatus（联动状态色）", () => {
    const { scene, editor } = makeEditor();
    const br = createShape("metro-breaker", {
      id: "br",
      x: 0,
      y: 0,
    }) as MetroBreaker;
    scene.add(br);
    editor.activatePage("p1");
    editor.updateShapeAt(["br"], { breakerStatus: "closed" });
    expect(br.breakerStatus).toBe("closed");
    expect(br.fill).toBe("#00FF00"); // STATUS_COLORS.closed.fill
  });

  it("addShape 创建并记录；undo 移除", () => {
    const { scene, editor } = makeEditor();
    editor.activatePage("p1");
    const sh = editor.addShape({ type: "rect", x: 10, y: 20 });
    expect(scene.get(sh.id)).toBeDefined();
    editor.undo();
    expect(scene.get(sh.id)).toBeUndefined();
  });

  it("deleteShape 移除并清除绑定索引；undo 恢复", () => {
    const { scene, editor, bindingEngine } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.updateShapeAt(["a"], {
      bindings: [
        {
          variableId: "V1",
          variableType: "DI",
          targetProp: "fill",
          mapping: { type: "direct" },
          smooth: false,
        },
      ],
    });
    expect(editor.deleteShape("a")).toBe(true);
    expect(scene.get("a")).toBeUndefined();
    expect(indexOf(bindingEngine).get("V1")).toBeUndefined();
    editor.undo();
    expect(scene.get("a")).toBeDefined();
  });

  it("group 包裹成员并记录批量命令；undo 还原成员", () => {
    const { scene, editor } = makeEditor();
    const a = rect("a");
    const b = rect("b");
    scene.add(a);
    scene.add(b);
    editor.activatePage("p1");
    const g = editor.group(["a", "b"]);
    expect(g).not.toBeNull();
    expect(scene.get("a")).toBeUndefined();
    expect(scene.get(g!.id)).toBeDefined();
    editor.undo();
    expect(scene.get("a")).toBeDefined();
    expect(scene.get("b")).toBeDefined();
    expect(scene.get(g!.id)).toBeUndefined();
  });

  it("ungroup 展开组并返回首个子图元；undo 恢复组快照", () => {
    const { scene, editor } = makeEditor();
    const g = createShape("group", {
      id: "g",
      x: 0,
      y: 0,
      children: [rect("c1", 5).toJSON(), rect("c2", 8).toJSON()],
    }) as GroupShape;
    scene.add(g);
    editor.activatePage("p1");
    const r = editor.ungroup("g");
    expect(r.ok).toBe(true);
    expect(r.firstChildId).toBe("c1");
    expect(scene.get("g")).toBeUndefined();
    expect(scene.get("c1")).toBeDefined();
    editor.undo();
    const restored = scene.get("g");
    expect(restored).toBeDefined();
    expect((restored as GroupShape).children.map((c) => c.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("reorder 换序并记录；undo 恢复顺序", () => {
    const { scene, editor } = makeEditor();
    const a = rect("a");
    const b = rect("b");
    const c = rect("c");
    a.zIndex = 0;
    b.zIndex = 1;
    c.zIndex = 2;
    scene.add(a);
    scene.add(b);
    scene.add(c);
    editor.activatePage("p1");
    editor.reorder(["a"], 0); // a 移到最上层
    expect(scene.getAll().map((s) => s.id)).toEqual(["b", "c", "a"]);
    editor.undo();
    expect(scene.getAll().map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("拖拽缩放协议：begin → resize → end 记录一条命令，undo 恢复", () => {
    const { scene, editor } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.beginShapeEdit("a");
    editor.applyShapeResize("a", "se", { x: 150, y: 80 });
    expect(sh.width).not.toBe(100);
    editor.endShapeEdit();
    editor.undo();
    expect(sh.width).toBe(100);
  });

  it("record=false 的连续移动不逐次记录；endShapeEdit 合并为一条命令", () => {
    const { scene, editor } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.beginShapeEdit("a");
    editor.updateShape("a", { x: 10 }, false);
    editor.updateShape("a", { x: 20 }, false);
    editor.updateShape("a", { x: 30 }, false);
    editor.endShapeEdit();
    editor.undo();
    expect(sh.x).toBe(0);
    expect(editor.undo()).toBeNull(); // 只有一条命令
  });

  it("cancelShapeEdit 丢弃快照，不记录命令", () => {
    const { scene, editor } = makeEditor();
    const sh = rect("a");
    scene.add(sh);
    editor.activatePage("p1");
    editor.beginShapeEdit("a");
    editor.applyShapeResize("a", "se", { x: 150, y: 80 });
    editor.cancelShapeEdit();
    editor.endShapeEdit();
    expect(editor.undo()).toBeNull();
  });

  it("addShapes 批量新增可整体撤销", () => {
    const { scene, editor } = makeEditor();
    editor.activatePage("p1");
    editor.addShapes([rect("a")]);
    expect(editor.undo()).not.toBeNull();
    expect(scene.count).toBe(0);
  });

  it("replaceShape 原位替换：undo 恢复旧图元且保持 z 序", () => {
    const { scene, editor } = makeEditor();
    const a = rect("a");
    const b = rect("b");
    scene.add(a);
    scene.add(b);
    editor.activatePage("p1");
    const replacement = rect("a2", 99);
    const placed = editor.replaceShape("a", replacement);
    expect(placed).toBe(replacement);
    expect(scene.get("a")).toBeUndefined();
    expect(scene.get("a2")).toBe(replacement);
    expect(scene.getAll().map((s) => s.id)).toEqual(["a2", "b"]);

    const u = editor.undo();
    expect(scene.get("a")).toBeDefined();
    expect(scene.get("a2")).toBeUndefined();
    expect(scene.getAll().map((s) => s.id)).toEqual(["a", "b"]);
    expect(u!.selected).toBeNull();
  });

  it("replaceShape 目标不存在时返回 null 且不记录", () => {
    const { editor } = makeEditor();
    editor.activatePage("p1");
    expect(editor.replaceShape("missing", rect("n"))).toBeNull();
    expect(editor.undo()).toBeNull();
  });

  it("scaleAll 等比缩放全部图元：undo 整体恢复", () => {
    const { scene, editor } = makeEditor();
    const a = rect("a");
    const b = rect("b", 10);
    scene.add(a);
    scene.add(b);
    editor.activatePage("p1");
    editor.scaleAll(2);
    expect(scene.get("a")!.width).toBe(200);
    expect(scene.get("b")!.width).toBe(200);

    editor.undo();
    expect(scene.get("a")!.width).toBe(100);
    expect(scene.get("b")!.x).toBe(10);
    expect(editor.undo()).toBeNull(); // 只有一条命令
  });

  it("scaleAll(factor=1) 不记录命令", () => {
    const { scene, editor } = makeEditor();
    scene.add(rect("a"));
    editor.activatePage("p1");
    editor.scaleAll(1);
    expect(editor.undo()).toBeNull();
  });
});
