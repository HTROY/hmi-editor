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
