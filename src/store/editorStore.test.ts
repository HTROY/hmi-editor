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
});
