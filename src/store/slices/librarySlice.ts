import type { ShapeBase, LibraryItem, LibraryGroup } from "../../core";
import { importSvg } from "../../core/svg";
import { libraryItemToShape } from "../../core/shapes/library";
import type { StoreSet, StoreGet } from "../editorStoreTypes";
import type { EditorServices } from "../editorServices";

/** 图元库领域的状态与动作（精确类型）。 */
export interface LibrarySliceState {
  library: LibraryItem[];
  libraryGroups: LibraryGroup[];
  libraryCollapsed: string[];
  libraryRevision: number;
  saveSelectionToLibrary: (
    name: string,
    groupId?: string
  ) => LibraryItem | null;
  importSvgToLibrary: (file: File, groupId?: string) => void;
  renameLibraryItem: (id: string, name: string) => void;
  deleteLibraryItem: (id: string) => void;
  overwriteLibraryItem: (id: string) => void;
  placeLibraryItem: (id: string, x?: number, y?: number) => void;
  resyncFromLibrary: (itemId: string, shapeId: string) => void;
  addLibraryGroup: (name: string) => boolean;
  renameLibraryGroup: (id: string, name: string) => boolean;
  deleteLibraryGroup: (id: string) => void;
  moveLibraryItemToGroup: (itemId: string, groupId: string | null) => void;
  moveLibraryGroup: (id: string, targetIndex: number) => void;
  toggleLibraryCollapsed: (key: string) => void;
}

/**
 * 图元库领域：库项/分组的增删改、放置与回写。
 */
export const createLibrarySlice = (
  _set: StoreSet,
  get: StoreGet,
  services: EditorServices
): LibrarySliceState => {
  const { libraryController, sceneEditor, projectManager } = services;

  return {
    library: projectManager.getLibrary(),
    libraryGroups: [],
    libraryCollapsed: [],
    libraryRevision: 0,
    saveSelectionToLibrary: (name, groupId) => {
      const s = get();
      const ids = Array.from(s.selection.multiIds);
      const shapes = ids
        .map((id) => s.scene.get(id))
        .filter((sh): sh is ShapeBase => !!sh);
      if (shapes.length === 0) return null;
      return libraryController.addItem(
        shapes,
        name.trim() || "未命名图元",
        groupId
      );
    },
    importSvgToLibrary: (file, groupId) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const s = get();
          const meta = s.projectManager.getPageMeta(s.activePageId);
          const result = importSvg(reader.result as string, {
            pageWidth: meta?.width ?? 0,
            pageHeight: meta?.height ?? 0,
          });
          if (result.shapes.length === 0) {
            alert("未找到可导入的图元");
            return;
          }
          const baseName = file.name.replace(/\.svg$/i, "") || "SVG 图元";
          libraryController.addItem(result.shapes, baseName, groupId);
          const lines: string[] = [...result.warnings];
          if (result.outOfBounds.length > 0) {
            lines.push(result.outOfBounds.length + " 个图元超出页面边界");
          }
          if (lines.length > 0) alert(lines.join("\n"));
        } catch (e) {
          alert(
            "SVG 导入失败：" + (e instanceof Error ? e.message : String(e))
          );
        }
      };
      reader.onerror = () => alert("SVG 文件读取失败");
      reader.readAsText(file);
    },
    renameLibraryItem: (id, name) => libraryController.renameItem(id, name),
    deleteLibraryItem: (id) => libraryController.deleteItem(id),
    overwriteLibraryItem: (id) => {
      const s = get();
      const target = s.library.find((item) => item.id === id);
      if (!target) return;
      const ids = Array.from(s.selection.multiIds);
      const shapes = ids
        .map((shapeId) => s.scene.get(shapeId))
        .filter((sh): sh is ShapeBase => !!sh);
      if (shapes.length === 0) return;
      libraryController.overwriteItem(id, shapes);
    },
    placeLibraryItem: (id, x, y) => {
      const s = get();
      const item = s.library.find((i) => i.id === id);
      if (!item) return;
      const sh = libraryItemToShape(item, x, y);
      // 库项可能携带绑定：addShapes 会重建其绑定索引
      sceneEditor.addShapes([sh]);
      s.selectShape(sh.id);
      s.projectManager.dirty = true;
    },
    resyncFromLibrary: (itemId, shapeId) => {
      const s = get();
      const item = s.library.find((i) => i.id === itemId);
      const old = s.scene.get(shapeId);
      if (!item || !old) return;
      const bbox = old.boundingBox;
      const center = {
        x: bbox.x + bbox.width / 2,
        y: bbox.y + bbox.height / 2,
      };
      const sh = libraryItemToShape(item, center.x, center.y);
      sceneEditor.replaceShape(shapeId, sh);
      s.selectShape(sh.id);
    },
    addLibraryGroup: (name) => libraryController.addGroup(name),
    renameLibraryGroup: (id, name) => libraryController.renameGroup(id, name),
    deleteLibraryGroup: (id) => libraryController.deleteGroup(id),
    moveLibraryItemToGroup: (itemId, groupId) =>
      libraryController.moveItemToGroup(itemId, groupId),
    moveLibraryGroup: (id, targetIndex) =>
      libraryController.moveGroup(id, targetIndex),
    toggleLibraryCollapsed: (key) => libraryController.toggleCollapsed(key),
  };
};
