import { resolveShape, normalizePageView } from "../../core";
import type {
  ShapeProps,
  ResizeHandle,
  ResizeOptions,
  UndoRedoResult,
  ShapePath,
  ShapeType,
  SceneGraph,
  Renderer,
  CommandHistory,
  Viewport,
} from "../../core";
import { generateId } from "../../core/shapes";
import { Selection, type ShapeBase } from "../../core";
import type { StoreSet, StoreGet, AutosaveHooks } from "../editorStoreTypes";
import type { EditorServices } from "../editorServices";
import { useEditorStore } from "../editorStore";

/** 场景/画布领域的状态与动作（精确类型，便于与主 store 组合）。 */
export interface SceneSliceState {
  scene: SceneGraph;
  renderer: Renderer | null;
  history: CommandHistory;
  mode: "select" | "rect" | "circle" | "line" | "text";
  selection: Selection;
  selectionRevision: number;
  clipboard: ShapeBase | null;
  shapeRevision: number;
  historyRevision: number;
  viewport: Viewport;
  zoom: number;
  panX: number;
  panY: number;
  viewRevision: number;
  leftPanel:
    | "library"
    | "variables"
    | "connections"
    | "pages"
    | "alarm"
    | "trend"
    | "auth"
    | "script"
    | "report";
  setRenderer: (r: Renderer) => void;
  setMode: (m: "select" | "rect" | "circle" | "line" | "text") => void;
  setLeftPanel: (p: SceneSliceState["leftPanel"]) => void;
  selectShape: (id: string | null) => void;
  selectShapes: (ids: string[]) => void;
  selectShapeAt: (path: ShapePath) => void;
  addShape: (t: ShapeType, x?: number, y?: number) => void;
  deleteSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  updateShape: (
    id: string,
    props: Partial<ShapeProps>,
    record?: boolean
  ) => void;
  updateShapeAt: (
    path: ShapePath,
    props: Partial<ShapeProps>,
    record?: boolean
  ) => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  reorderSelected: (toIndex: number) => void;
  toggleShapeVisible: (path: ShapePath) => void;
  toggleShapeLocked: (path: ShapePath) => void;
  renameShape: (path: ShapePath, name: string) => void;
  beginShapeEdit: (id: string) => void;
  endShapeEdit: () => void;
  applyShapeResize: (
    id: string,
    handle: ResizeHandle,
    pointer: { x: number; y: number },
    options?: ResizeOptions
  ) => void;
  undo: () => void;
  redo: () => void;
  renderScene: () => void;
  setZoom: (zoom: number, anchorX?: number, anchorY?: number) => void;
  zoomBy: (factor: number, anchorX?: number, anchorY?: number) => void;
  panBy: (dx: number, dy: number) => void;
  zoomTo: (zoom: number) => void;
  fitPage: () => void;
  syncSceneToProject: () => void;
  bumpShapeRevision: () => void;
  bumpHistoryRevision: () => void;
}

/**
 * 场景/画布领域：画布图元、选择、剪贴板、视口、撤销重做与渲染。
 */
export const createSceneSlice = (
  set: StoreSet,
  get: StoreGet,
  services: EditorServices,
  hooks: AutosaveHooks
): SceneSliceState => {
  const { scene, sceneEditor, initialViewport } = services;

  const syncView = (s: ReturnType<StoreGet>) => {
    const view = normalizePageView(s.viewport.toJSON());
    set((st) => ({
      zoom: view.zoom,
      panX: view.panX,
      panY: view.panY,
      viewRevision: st.viewRevision + 1,
      pageViews: { ...st.pageViews, [st.activePageId]: view },
    }));
    hooks.scheduleAutosave();
  };

  /** 撤销/重做后应用 SceneEditor 返回的选中结果（keepSelection 时不动选中） */
  const applyUndoRedoSelection = (r: UndoRedoResult | null) => {
    if (!r) return;
    const s = get();
    const next = s.selection.applyUndoRedo(r);
    if (next === s.selection) return;
    set({
      selection: next,
      selectionRevision: s.selectionRevision + 1,
    });
    s.renderer?.render();
  };

  return {
    scene,
    history: sceneEditor.activeHistory!,
    renderer: null,
    mode: "select",
    selection: new Selection(),
    selectionRevision: 0,
    clipboard: null,
    shapeRevision: 0,
    historyRevision: 0,
    viewport: initialViewport,
    zoom: 1,
    panX: 0,
    panY: 0,
    viewRevision: 0,
    leftPanel: "library",
    setRenderer: (r) => {
      set({ renderer: r });
      const s = get();
      r.setViewport(s.viewport);
      r.setSelectionSource(() => useEditorStore.getState().selection);
      const meta = s.projectManager.getPageMeta(s.activePageId);
      if (meta)
        r.setPage(meta.width, meta.height, meta.background ?? "#FFFFFF");
      s.bindingEngine.setRenderer(r);
      s.animEngine.setRenderer(r);
      sceneEditor.setRenderer(r);
      services.pageController.setRenderer(r);
      s.fitPage();
    },
    setMode: (m) => set({ mode: m }),
    setLeftPanel: (p) => set({ leftPanel: p }),
    selectShape: (id) => {
      const s = get();
      if (id === null) sceneEditor.cancelShapeEdit();
      set({
        selection: s.selection.select(id),
        selectionRevision: s.selectionRevision + 1,
      });
      s.renderer?.render();
    },
    selectShapes: (ids) => {
      const s = get();
      set({
        selection: s.selection.selectMany(ids),
        selectionRevision: s.selectionRevision + 1,
      });
      s.renderer?.render();
    },
    selectShapeAt: (path) => {
      const s = get();
      if (!resolveShape(s.scene, path)) return;
      set({
        selection: s.selection.selectAt(path),
        selectionRevision: s.selectionRevision + 1,
      });
      s.renderer?.render();
    },
    addShape: (type, x, y) => {
      sceneEditor.addShape({
        type,
        x: x ?? 200,
        y: y ?? 200,
      });
    },
    deleteSelected: () => {
      const s = get();
      // 组内子图元不允许删除（仅在检查器中编辑）
      if (s.selection.primaryPath && s.selection.primaryPath.length > 1) return;
      if (s.selection.primaryId) {
        sceneEditor.deleteShape(s.selection.primaryId);
        set({
          selection: s.selection.clear(),
          selectionRevision: s.selectionRevision + 1,
        });
      }
    },
    copySelected: () => {
      const s = get();
      // 复制/粘贴仅支持顶层图元
      if (s.selection.primaryPath && s.selection.primaryPath.length > 1) return;
      if (s.selection.primaryId) {
        const sh = s.scene.get(s.selection.primaryId);
        if (sh) set({ clipboard: sh.clone() });
      }
    },
    pasteClipboard: () => {
      const s = get();
      if (s.clipboard) {
        const c = s.clipboard.clone();
        c.id = generateId();
        c.x += 20;
        c.y += 20;
        const placed = sceneEditor.addShape(c.toJSON() as ShapeProps);
        set({
          selection: s.selection.select(placed.id),
          selectionRevision: s.selectionRevision + 1,
        });
        s.renderer?.render();
      }
    },
    updateShape: (id, props, record = true) => {
      sceneEditor.updateShape(id, props, record);
    },
    updateShapeAt: (path, props, record = true) => {
      sceneEditor.updateShapeAt(path, props, record);
    },
    groupSelected: () => {
      const s = get();
      const ids = Array.from(s.selection.multiIds);
      const group = sceneEditor.group(ids);
      if (group) {
        s.selectShape(group.id);
      }
    },
    ungroupSelected: () => {
      const s = get();
      const sel = s.selection;
      if (!sel.primaryId || (sel.primaryPath && sel.primaryPath.length > 1)) {
        return;
      }
      const result = sceneEditor.ungroup(sel.primaryId);
      if (!result.ok) return;
      if (result.firstChildId !== null) {
        s.selectShapeAt([result.firstChildId]);
      } else {
        s.selectShape(null);
      }
    },
    reorderSelected: (toIndex) => {
      const s = get();
      const path = s.selection.primaryPath;
      if (!path) return;
      sceneEditor.reorder(path, toIndex);
    },
    toggleShapeVisible: (path) => {
      const shape = resolveShape(get().scene, path);
      if (shape) {
        get().updateShapeAt(path, { visible: !shape.visible });
      }
    },
    toggleShapeLocked: (path) => {
      const shape = resolveShape(get().scene, path);
      if (shape) {
        get().updateShapeAt(path, { locked: !shape.locked });
      }
    },
    renameShape: (path, name) => {
      if (!name.trim()) return;
      get().updateShapeAt(path, { name: name.trim() });
    },
    beginShapeEdit: (id) => {
      sceneEditor.beginShapeEdit(id);
    },
    endShapeEdit: () => {
      sceneEditor.endShapeEdit();
    },
    applyShapeResize: (id, handle, pointer, options) => {
      sceneEditor.applyShapeResize(id, handle, pointer, options);
    },
    undo: () => {
      applyUndoRedoSelection(sceneEditor.undo());
    },
    redo: () => {
      applyUndoRedoSelection(sceneEditor.redo());
    },
    renderScene: () => {
      get().renderer?.render();
    },
    setZoom: (zoom, anchorX, anchorY) => {
      const s = get();
      const r = s.renderer;
      s.viewport.setZoom(
        zoom,
        anchorX ?? (r ? r.width / 2 : 0),
        anchorY ?? (r ? r.height / 2 : 0)
      );
      syncView(s);
      s.renderer?.render();
    },
    zoomBy: (factor, anchorX, anchorY) => {
      const s = get();
      const r = s.renderer;
      s.viewport.zoomBy(
        factor,
        anchorX ?? (r ? r.width / 2 : 0),
        anchorY ?? (r ? r.height / 2 : 0)
      );
      syncView(s);
      s.renderer?.render();
    },
    panBy: (dx, dy) => {
      const s = get();
      s.viewport.panBy(dx, dy);
      syncView(s);
      s.renderer?.render();
    },
    zoomTo: (zoom) => {
      const s = get();
      const r = s.renderer;
      if (!r) return;
      const meta = s.projectManager.getPageMeta(s.activePageId);
      if (!meta) return;
      s.viewport.zoomToPage(zoom, meta.width, meta.height, r.width, r.height);
      syncView(s);
      r.render();
    },
    fitPage: () => {
      const s = get();
      const r = s.renderer;
      if (!r) return;
      const meta = s.projectManager.getPageMeta(s.activePageId);
      if (!meta) return;
      s.viewport.fitPage(meta.width, meta.height, r.width, r.height);
      syncView(s);
      r.render();
    },
    syncSceneToProject: () => {
      get().projectManager.syncScene(get().activePageId, get().scene);
    },
    bumpShapeRevision: () =>
      set((s) => ({ shapeRevision: s.shapeRevision + 1 })),
    bumpHistoryRevision: () =>
      set((s) => ({ historyRevision: s.historyRevision + 1 })),
  };
};
