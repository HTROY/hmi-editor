import {
  sanitizeResolution,
  computeScaleFactor,
  sanitizePageBackground,
  DEFAULT_PAGE_VIEW,
  normalizePageView,
  isProjectPackageFile,
  unpackProjectPackage,
} from "../../core";
import type { PageViewState } from "../../core";
import type { StoreSet, StoreGet, AutosaveHooks } from "../editorStoreTypes";
import type { EditorServices } from "../editorServices";

/** 页面/视图领域的状态与动作（精确类型）。 */
export interface PageSliceState {
  activePageId: string;
  pageViews: Record<string, PageViewState>;
  pageRevision: number;
  syncSceneToProject: () => void;
  newProject: () => void;
  saveProject: () => void;
  openProject: (f: File) => void;
  openProjectPackage: (file: File) => Promise<void>;
  exportScene: () => void;
  exportProjectPackage: () => Promise<void>;
  importScene: (j: string) => void;
  importProject: (j: string) => void;
  exportProject: () => void;
  switchPage: (id: string) => void;
  addPage: () => void;
  deletePage: (id: string) => void;
  renamePage: (id: string, t: string) => void;
  movePage: (id: string, newOrder: number) => void;
  setPageResolution: (pageId: string, width: number, height: number) => void;
  scaleShapesToResolution: (width: number, height: number) => void;
  setPageBackground: (pageId: string, background: string) => void;
  setPageView: (pageId: string, view: PageViewState) => void;
}

/**
 * 页面/视图领域：页面元数据（projectManager 为事实来源）、页面视图状态、
 * 工程打开/保存/导出/导入。
 */
export const createPageSlice = (
  set: StoreSet,
  get: StoreGet,
  services: EditorServices,
  hooks: AutosaveHooks
): PageSliceState => {
  const { pageController, projectManager, sceneEditor, loadProjectData } =
    services;
  const { flushAutosave } = hooks;

  return {
    activePageId: projectManager.activePageId,
    pageViews: {
      [projectManager.activePageId]: { ...DEFAULT_PAGE_VIEW },
    },
    pageRevision: 0,
    syncSceneToProject: () => {
      get().projectManager.syncScene(get().activePageId, get().scene);
    },
    newProject: () => {
      pageController.newProject({
        fullProject: true,
        fit: true,
        clearRemoteLink: true,
      });
    },
    saveProject: () => {
      const s = get();
      s.syncSceneToProject();
      flushAutosave();
      s.projectManager.downloadProject();
    },
    openProject: (file) => {
      const s = get();
      if (isProjectPackageFile(file)) {
        void s.openProjectPackage(file);
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        try {
          loadProjectData(JSON.parse(r.result as string));
        } catch {
          alert("打开失败");
        }
      };
      r.readAsText(file);
    },
    openProjectPackage: async (file) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        loadProjectData(await unpackProjectPackage(bytes));
      } catch (e) {
        alert(
          "打开工程包失败：" + (e instanceof Error ? e.message : String(e))
        );
      }
    },
    exportScene: () => {
      const s = get();
      s.syncSceneToProject();
      flushAutosave();
      s.projectManager.downloadProject();
    },
    exportProjectPackage: async () => {
      const s = get();
      s.syncSceneToProject();
      flushAutosave();
      try {
        await s.projectManager.downloadProjectPackage();
      } catch (e) {
        alert(
          "导出工程包失败：" + (e instanceof Error ? e.message : String(e))
        );
      }
    },
    importScene: (json) => {
      try {
        const d = JSON.parse(json);
        if (d.pages) {
          loadProjectData(d);
        } else if (d.shapes) {
          // 裸图元数组导入：场景替换/历史重置/索引重建/视口适配统一走页面加载路径
          pageController.importShapes(d.shapes);
        }
      } catch {}
    },
    importProject: (json) => {
      get().importScene(json);
    },
    exportProject: () => {
      const s = get();
      s.syncSceneToProject();
      flushAutosave();
      s.projectManager.downloadProject();
    },
    switchPage: (pageId) => {
      pageController.switchPage(pageId);
    },
    addPage: () => {
      pageController.addPage();
    },
    deletePage: (pageId) => {
      const s = get();
      if (s.projectManager.getPages().length <= 1) return;
      sceneEditor.deletePageHistory(pageId);
      set((st) => {
        const pageViews = { ...st.pageViews };
        delete pageViews[pageId];
        return { pageViews };
      });
      s.projectManager.deletePage(pageId);
      const pgs = s.projectManager.getPages();
      if (pgs.length > 0) s.switchPage(pgs[0].id);
    },
    renamePage: (pageId, newTitle) => {
      const s = get();
      s.projectManager.renamePage(pageId, newTitle);
      // 页面元数据以 projectManager 为唯一来源：递增修订号驱动派生选择器刷新
      set((st) => ({ pageRevision: st.pageRevision + 1 }));
      flushAutosave();
    },
    movePage: (pageId, newOrder) => {
      const s = get();
      s.projectManager.movePage(pageId, newOrder);
      set((st) => ({ pageRevision: st.pageRevision + 1 }));
    },
    setPageResolution: (pageId, width, height) => {
      const s = get();
      const meta = s.projectManager.getPageMeta(pageId);
      if (!meta) return;
      const { width: w, height: h } = sanitizeResolution(width, height);
      meta.width = w;
      meta.height = h;
      meta.updatedAt = new Date().toISOString();
      s.projectManager.dirty = true;
      if (pageId === s.activePageId) {
        set((st) => ({ pageRevision: st.pageRevision + 1 }));
        s.renderer?.setPage(w, h, meta.background ?? "#FFFFFF");
        s.renderer?.render();
      }
      flushAutosave();
    },
    scaleShapesToResolution: (width, height) => {
      const s = get();
      const meta = s.projectManager.getPageMeta(s.activePageId);
      if (!meta) return;
      const { width: newW, height: newH } = sanitizeResolution(width, height);
      if (meta.width === newW && meta.height === newH) return;
      const factor = computeScaleFactor(meta.width, meta.height, newW, newH);
      sceneEditor.scaleAll(factor);
      meta.width = newW;
      meta.height = newH;
      meta.updatedAt = new Date().toISOString();
      s.projectManager.dirty = true;
      set((st) => ({ pageRevision: st.pageRevision + 1 }));
      s.renderer?.setPage(newW, newH, meta.background ?? "#FFFFFF");
      s.renderer?.render();
      flushAutosave();
    },
    setPageBackground: (pageId, background) => {
      const s = get();
      const color = sanitizePageBackground(background);
      s.projectManager.setPageBackground(pageId, color);
      const meta = s.projectManager.getPageMeta(pageId);
      if (pageId === s.activePageId && meta) {
        set((st) => ({ pageRevision: st.pageRevision + 1 }));
        s.renderer?.setPage(meta.width, meta.height, color);
        s.renderer?.render();
      }
      flushAutosave();
    },
    setPageView: (pageId, view) => {
      set((st) => ({
        pageViews: {
          ...st.pageViews,
          [pageId]: normalizePageView(view),
        },
      }));
      hooks.scheduleAutosave();
      if (pageId === get().activePageId)
        pageController.activateViewport(pageId, false);
    },
  };
};
