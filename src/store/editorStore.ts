import { create } from "zustand";
import {
  isOverRasterWarningSize,
  isRasterFile,
  rasterDataUrlToImageShape,
  isAutosaveSnapshot,
  applyAutosaveSnapshot,
  buildAutosaveSnapshot,
  AutosaveController,
  createIndexedDbAutosaveStore,
  importSvg,
} from "../core";
import type { AutosaveSnapshot } from "../core";
import type { SvgImportResult } from "../core/svg";
import { createEditorServices } from "./editorServices";
import type { EditorServices } from "./editorServices";
import { createSceneSlice } from "./slices/sceneSlice";
import { createLibrarySlice } from "./slices/librarySlice";
import { createPageSlice } from "./slices/pageSlice";
import { createConnectionSlice } from "./slices/connectionSlice";
import { createAlarmSlice } from "./slices/alarmSlice";
import { createRemoteSlice } from "./slices/remoteSlice";
import type { AutosaveHooks } from "./editorStoreTypes";
import type { EditorState } from "./editorStoreTypes";

export type {
  EditorState,
  ToolMode,
  RemoteDialog,
  PushResult,
  LeftPanel,
} from "./editorStoreTypes";

// ============================================================
// 主 store：只做领域组合与生命周期。
// 领域状态与动作分布在 slices/ 下的独立文件中：
//   sceneSlice / librarySlice / pageSlice / connectionSlice /
//   alarmSlice / remoteSlice
// 服务实例（SceneEditor/PageController/LibraryController/DataBridge/
// AlarmManager/...）由 createEditorServices 工厂组装，便于注入测试替身。
// ============================================================

// 自动保存（IndexedDB）：停止编辑约 1 秒后写入本地快照；
// 快照只含工程数据与每页视图状态，不含选中项/面板/剪贴板
const autosaveController = new AutosaveController(
  createIndexedDbAutosaveStore()
);
let autosaveReady = false;
let hydratePromise: Promise<boolean> | null = null;

function buildAutosaveSnapshotNow(): AutosaveSnapshot {
  const s = useEditorStore.getState();
  s.syncSceneToProject();
  return buildAutosaveSnapshot(s.projectManager, s.pageViews, s.activePageId);
}

function scheduleAutosave(): void {
  if (!autosaveReady) return;
  autosaveController.schedule(buildAutosaveSnapshotNow);
}

function flushAutosave(): void {
  if (!autosaveReady) return;
  autosaveController.flush(buildAutosaveSnapshotNow);
}

const autosaveHooks: AutosaveHooks = { scheduleAutosave, flushAutosave };

export const useEditorStore = create<EditorState>()((set, get) => {
  const services: EditorServices = createEditorServices(
    set,
    get,
    autosaveHooks
  );

  // 服务工厂的协调器字段（sceneEditor/pageController/...）不属于对外状态，
  // 只把 EditorState 声明的字段展开进 store。
  const {
    sceneEditor: _sceneEditor,
    pageController: _pageController,
    libraryController: _libraryController,
    initialViewport: _initialViewport,
    loadProjectData: _loadProjectData,
    ...serviceState
  } = services;

  return {
    // ---- 服务实例（状态字段，供组件直接访问） ----
    ...serviceState,

    // ---- 领域 slices ----
    ...createSceneSlice(set, get, services, autosaveHooks),
    ...createLibrarySlice(set, get, services),
    ...createPageSlice(set, get, services, autosaveHooks),
    ...createConnectionSlice(set, get),
    ...createAlarmSlice(set, get),
    ...createRemoteSlice(set, get, services),

    // ---- 生命周期 ----
    varRevision: 0,
    restoreSession: async () => {
      if (hydratePromise) return hydratePromise;
      hydratePromise = (async () => {
        const s = get();
        try {
          const snapshot = await autosaveController.load();
          if (!snapshot || !isAutosaveSnapshot(snapshot)) {
            autosaveReady = true;
            return false;
          }
          const views = applyAutosaveSnapshot(s.projectManager, snapshot);
          const f = s.projectManager.activePage;
          if (!f) {
            autosaveReady = true;
            return false;
          }
          services.pageController.loadActivePage({ fullProject: true, views });
          autosaveReady = true;
          return true;
        } catch {
          autosaveReady = true;
          return false;
        }
      })();
      return hydratePromise;
    },
    flushAutosave: () => flushAutosave(),

    // ---- 变量与 SVG/光栅导入（跨场景/页面/工程，留在组合层） ----
    bumpVarRevision: () => set((s) => ({ varRevision: s.varRevision + 1 })),
    importSvgText: (svgText: string): SvgImportResult => {
      const s = get();
      const meta = s.projectManager.getPageMeta(s.activePageId);
      const result = importSvg(svgText, {
        pageWidth: meta?.width ?? 0,
        pageHeight: meta?.height ?? 0,
      });
      if (result.shapes.length === 0) return result;

      services.sceneEditor.addShapes(result.shapes);
      s.selectShapes(result.shapes.map((sh) => sh.id));
      s.projectManager.dirty = true;
      return result;
    },
    importSvgFile: (file) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const result = useEditorStore
            .getState()
            .importSvgText(reader.result as string);
          const lines: string[] = [];
          if (result.shapes.length === 0) lines.push("未找到可导入的图元");
          lines.push(...result.warnings);
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
    importRasterFile: async (file) => {
      if (!isRasterFile(file)) {
        alert("仅支持 PNG/JPG 图片");
        return;
      }
      if (isOverRasterWarningSize(file.size)) {
        const ok = window.confirm(
          "图片超过 10MB，导入后工程文件会明显变大，是否继续？"
        );
        if (!ok) return;
      }
      try {
        const s = get();
        const src = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () =>
            reject(reader.error ?? new Error("文件读取失败"));
          reader.readAsDataURL(file);
        });
        const meta = s.projectManager.getPageMeta(s.activePageId);
        const shape = await rasterDataUrlToImageShape(src, {
          pageWidth: meta?.width ?? 0,
          pageHeight: meta?.height ?? 0,
        });
        services.sceneEditor.addShapes([shape]);
        s.selectShape(shape.id);
        s.projectManager.dirty = true;
      } catch (e) {
        alert("图片导入失败：" + (e instanceof Error ? e.message : String(e)));
      }
    },
  };
});

// 图元/绑定/动画等编辑通过 revision 计数器触发防抖自动保存；
// 变量实时值（varRevision）不参与保存
useEditorStore.subscribe((state, prev) => {
  if (
    state.shapeRevision !== prev.shapeRevision ||
    state.libraryRevision !== prev.libraryRevision ||
    state.historyRevision !== prev.historyRevision ||
    state.pageRevision !== prev.pageRevision
  ) {
    scheduleAutosave();
  }
});

// 关闭/刷新页面时尽力把待保存的修改落盘
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (autosaveReady) flushAutosave();
  });
}
