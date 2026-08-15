import {
  SceneGraph,
  SceneEditor,
  PageController,
  LibraryController,
  Viewport,
  defaultPageViews,
  normalizePageView,
} from "../core";
import { mergeCollapsed } from "../core/shapes/libraryGroups";
import type { ProjectData } from "../core";
import { VariableManager } from "../core/variables";
import { BindingEngine, AnimationEngine } from "../core/bindings";
import { DataBridge } from "../core/io";
import { ProjectManager } from "../core/project";
import { AlarmManager } from "../core/alarm";
import { Historian } from "../core/historian";
import { AuthManager, RemoteAuthClient } from "../core/auth";
import { ScriptEngine } from "../core/script";
import { ReportEngine } from "../core/report";
import { RemoteProjectStore } from "../core/project/remote";
import { createIndexedDbDraftBackupStore } from "../core/project/backup";
import type { DraftBackupStore } from "../core/project/backup";
import type {
  EditorState,
  StoreGet,
  StoreSet,
  AutosaveHooks,
} from "./editorStoreTypes";

/**
 * 组装编辑器服务实例（场景编辑器、页面控制器、图元库控制器、数据桥、
 * 报警/历史/认证/脚本/报表引擎等）。主 store 只负责组合与生命周期。
 */
export interface EditorServices {
  scene: SceneGraph;
  sceneEditor: SceneEditor;
  pageController: PageController;
  libraryController: LibraryController;
  varManager: VariableManager;
  bindingEngine: BindingEngine;
  animEngine: AnimationEngine;
  dataBridge: DataBridge;
  projectManager: ProjectManager;
  alarmManager: AlarmManager;
  historian: Historian;
  authManager: AuthManager;
  remoteAuth: RemoteAuthClient;
  remoteProjects: RemoteProjectStore;
  draftBackupStore: DraftBackupStore;
  scriptEngine: ScriptEngine;
  reportEngine: ReportEngine;
  /** 初始视口（页面加载路径会重建视口，这里仅作占位） */
  initialViewport: Viewport;
  /** 用工程数据替换当前编辑内容（打开/导入/恢复共用；收敛到 PageController） */
  loadProjectData: (data: ProjectData) => void;
}

export function createEditorServices(
  set: StoreSet,
  get: StoreGet,
  hooks: AutosaveHooks
): EditorServices {
  const scene = new SceneGraph();
  const varManager = new VariableManager();
  const bindingEngine = new BindingEngine(scene, varManager);
  // 图元编辑事务：撤销/重做与历史归属（每页一份）都在 SceneEditor 内
  const sceneEditor = new SceneEditor({
    scene,
    bindingEngine,
    callbacks: {
      onEditApplied: () =>
        set((st) => ({ shapeRevision: st.shapeRevision + 1 })),
      onHistoryApplied: () =>
        set((st) => ({ historyRevision: st.historyRevision + 1 })),
      onHistorySwap: (h) => set({ history: h }),
    },
  });
  // 绑定引擎常驻监听变量变化：无论数据来自模拟、io_backend 还是手动测试，
  // 绑定都立即应用到画布，不需要等到「启动模拟」
  bindingEngine.start();
  const animEngine = new AnimationEngine(scene, varManager);
  const dataBridge = new DataBridge(varManager);
  dataBridge.setOnVarsRefreshed(() => {
    setTimeout(() => {
      const s = get();
      s.bumpVarRevision();
    }, 0);
  });
  const projectManager = new ProjectManager();
  // 图元库变更统一入口：库镜像 + 工程写入 + localStorage 折叠 + 持久化收尾
  const libraryController = new LibraryController({
    projectManager,
    onLibraryChanged: (state, persist) =>
      set((st) => ({
        library: state.library,
        libraryGroups: state.libraryGroups,
        libraryCollapsed: state.libraryCollapsed,
        libraryRevision: persist ? st.libraryRevision + 1 : st.libraryRevision,
      })),
    onPersist: () => hooks.flushAutosave(),
  });
  // 页面加载路径：打开/新建/恢复会话/切页/新增页统一收敛；
  // 页面元数据只以 projectManager 为事实来源，store 不再镜像
  const pageController = new PageController({
    scene,
    sceneEditor,
    bindingEngine,
    projectManager,
    callbacks: {
      onPageSwapped: (meta, opts) => {
        const s = get();
        const patch: Partial<EditorState> = {
          activePageId: meta.id,
          selection: s.selection.clear(),
          selectionRevision: s.selectionRevision + 1,
          historyRevision: 0,
          pageRevision: s.pageRevision + 1,
        };
        if (opts.fullProject) {
          patch.library = s.projectManager.getLibrary();
          patch.libraryGroups = s.projectManager.getLibraryGroups();
          patch.libraryCollapsed = mergeCollapsed(
            s.projectManager.getLibraryUi().collapsed,
            libraryController.loadCollapsed(),
            s.projectManager.getLibraryGroups().map((g) => g.id)
          );
          patch.libraryRevision = 0;
          patch.pageViews = opts.views ?? defaultPageViews(s.projectManager);
        }
        if (opts.clearRemoteLink) {
          patch.remoteLink = null;
          s.projectManager.setRemoteLink(null);
        }
        set(patch);
        if (opts.fullProject)
          libraryController.saveCollapsed(get().libraryCollapsed);
      },
      onViewportActivated: (pageId, vp) =>
        set((st) => ({
          viewport: vp,
          zoom: vp.zoom,
          panX: vp.panX,
          panY: vp.panY,
          viewRevision: st.viewRevision + 1,
          pageViews: {
            ...st.pageViews,
            [pageId]: normalizePageView(vp.toJSON()),
          },
        })),
      getPageView: (pageId) => get().pageViews[pageId],
      onFlushAutosave: () => hooks.flushAutosave(),
    },
  });
  const alarmManager = new AlarmManager(varManager);
  const historian = new Historian(varManager);
  const authManager = new AuthManager();
  const remoteAuth = new RemoteAuthClient();
  const remoteProjects = new RemoteProjectStore(remoteAuth);
  const draftBackupStore = createIndexedDbDraftBackupStore();
  const scriptEngine = new ScriptEngine(varManager);
  const reportEngine = new ReportEngine(historian);
  scriptEngine.setAlarmManager(alarmManager);
  scriptEngine.setScene(scene);
  const { meta: dp } = projectManager.createPage("主画面");
  projectManager.activePageId = dp.id;
  sceneEditor.activatePage(dp.id);
  const initialViewport = new Viewport();

  /** 用工程数据替换当前编辑内容（打开/导入共用；加载路径收敛到 PageController） */
  const loadProjectData = (data: ProjectData) => {
    pageController.loadProject(data, {
      fullProject: true,
      fit: true,
      clearRemoteLink: true,
    });
  };

  return {
    scene,
    sceneEditor,
    pageController,
    libraryController,
    varManager,
    bindingEngine,
    animEngine,
    dataBridge,
    projectManager,
    alarmManager,
    historian,
    authManager,
    remoteAuth,
    remoteProjects,
    draftBackupStore,
    scriptEngine,
    reportEngine,
    initialViewport,
    loadProjectData,
  };
}
