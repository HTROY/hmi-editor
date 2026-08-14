import { describe, expect, it } from "vitest";
import { createShape } from "../core/shapes";
import type { LibraryItem } from "../core/shapes/library";
import { useEditorStore } from "./editorStore";

describe("editorStore 图元树刷新", () => {
  it("addShape 后场景结构版本递增（图元树随新增刷新）", () => {
    const before = useEditorStore.getState().scene.version;
    useEditorStore.getState().addShape("rect", 0, 0);
    expect(useEditorStore.getState().scene.version).toBeGreaterThan(before);
  });

  it("placeLibraryItem 后场景结构版本递增（拖拽放置后图元树刷新）", () => {
    const item: LibraryItem = {
      id: "lib1",
      name: "拖拽项",
      shape: createShape("rect", { x: 0, y: 0 }).toJSON(),
      createdAt: "",
      updatedAt: "",
    };
    useEditorStore.setState({ library: [item] });
    const before = useEditorStore.getState().scene.version;
    useEditorStore.getState().placeLibraryItem("lib1", 200, 200);
    expect(useEditorStore.getState().scene.version).toBeGreaterThan(before);
  });

  it("deleteSelected 后场景结构版本递增（删除后图元树刷新）", () => {
    const s = useEditorStore.getState();
    s.addShape("rect", 0, 0);
    const target = useEditorStore.getState().scene.getAll()[0];
    useEditorStore.getState().selectShape(target.id);
    const before = useEditorStore.getState().scene.version;
    useEditorStore.getState().deleteSelected();
    expect(useEditorStore.getState().scene.version).toBeGreaterThan(before);
    expect(useEditorStore.getState().scene.get(target.id)).toBeUndefined();
  });

  it("pasteClipboard 后场景结构版本递增（粘贴后图元树刷新）", () => {
    const clip = createShape("rect", {
      id: "clip_" + Date.now(),
      x: 0,
      y: 0,
    });
    useEditorStore.setState({ clipboard: clip });
    const before = useEditorStore.getState().scene.version;
    useEditorStore.getState().pasteClipboard();
    expect(useEditorStore.getState().scene.version).toBeGreaterThan(before);
  });

  it("switchPage 后场景结构版本递增（切页后图元树刷新）", () => {
    const s = useEditorStore.getState();
    s.addPage();
    const pages = useEditorStore.getState().projectManager.getPages();
    const other = pages.find(
      (p) => p.id !== useEditorStore.getState().activePageId
    )!;
    const before = useEditorStore.getState().scene.version;
    useEditorStore.getState().switchPage(other.id);
    expect(useEditorStore.getState().scene.version).toBeGreaterThan(before);
  });

  it("切到其他页面再切回后，原页面图元不丢失", () => {
    useEditorStore.getState().newProject();
    const pageA = useEditorStore.getState().activePageId;
    useEditorStore.getState().addShape("rect", 0, 0);
    const shapeId = useEditorStore.getState().scene.getAll()[0].id;
    useEditorStore.getState().addPage();
    const pageB = useEditorStore.getState().activePageId;
    expect(pageB).not.toBe(pageA);
    useEditorStore.getState().switchPage(pageA);
    const s = useEditorStore.getState();
    expect(s.activePageId).toBe(pageA);
    expect(s.scene.get(shapeId)).toBeDefined();
    expect(s.projectManager.getPageScene(pageA)?.get(shapeId)).toBeDefined();
  });

  it("importScene 后场景结构版本递增（导入场景后图元树刷新）", () => {
    const before = useEditorStore.getState().scene.version;
    useEditorStore.getState().importScene(
      JSON.stringify({
        shapes: [
          {
            id: "imp_" + Date.now(),
            type: "rect",
            x: 0,
            y: 0,
          },
        ],
      })
    );
    expect(useEditorStore.getState().scene.version).toBeGreaterThan(before);
  });
});

describe("editorStore 绑定索引一致性", () => {
  const indexOf = () =>
    (
      useEditorStore.getState().bindingEngine as unknown as {
        index: Map<string, unknown[]>;
      }
    ).index;

  it("updateShapeAt 带 bindings 时重建索引，deleteSelected 后移除已删除图元的记录", () => {
    const s = useEditorStore.getState();
    s.newProject();
    s.addShape("rect", 0, 0);
    const id = s.scene.getAll()[0].id;
    s.updateShapeAt([id], {
      bindings: [
        {
          variableId: "TEST_VAR",
          variableType: "DI",
          targetProp: "fill",
          mapping: { type: "direct" },
          smooth: false,
        },
      ],
    });
    expect(indexOf().get("TEST_VAR")?.length).toBe(1);
    s.selectShape(id);
    s.deleteSelected();
    expect(indexOf().get("TEST_VAR")).toBeUndefined();
  });

  it("placeLibraryItem 后带绑定的库项进入绑定索引", () => {
    const s = useEditorStore.getState();
    s.newProject();
    const shape = createShape("rect", { x: 0, y: 0, width: 10, height: 10 });
    shape.bindings = [
      {
        variableId: "LIB_VAR",
        variableType: "DI",
        targetProp: "fill",
        mapping: { type: "direct" },
        smooth: false,
      },
    ];
    const item: LibraryItem = {
      id: "lib-bind",
      name: "带绑定",
      shape: shape.toJSON(),
      createdAt: "",
      updatedAt: "",
    };
    useEditorStore.setState({ library: [item] });
    useEditorStore.getState().placeLibraryItem("lib-bind", 100, 100);
    expect(indexOf().get("LIB_VAR")?.length).toBe(1);
  });
});
