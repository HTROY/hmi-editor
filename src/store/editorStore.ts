import { create } from "zustand";
import {
  SceneGraph,
  Renderer,
  createShape,
  ShapeBase,
  Serializer,
  CommandHistory,
  Viewport,
  sanitizeResolution,
  getOutOfBoundsShapes,
  scaleShape,
  computeScaleFactor,
  applyResize,
  isOverRasterWarningSize,
  isRasterFile,
  rasterDataUrlToImageShape,
  sanitizePageBackground,
  DEFAULT_CONNECTION_CONFIG,
  loadConnectionConfig,
  saveConnectionConfig,
} from "../core";
import type {
  ShapeCommand,
  ShapeProps,
  OutOfBoundsShape,
  ResizeHandle,
  ResizeOptions,
  ProjectData,
  ConnectionConfig,
} from "../core";
import { generateId } from "../core/shapes";
import { importSvg } from "../core/svg";
import type { SvgImportResult } from "../core/svg";
import { VariableManager } from "../core/variables";
import { BindingEngine, AnimationEngine } from "../core/bindings";
import { DataBridge, WebSocketClient } from "../core/io";
import { ProjectManager } from "../core/project";
import { AlarmManager } from "../core/alarm";
import type { AlarmRule } from "../core/alarm/types";
import { Historian } from "../core/historian";
import { AuthManager } from "../core/auth";
import { RemoteAuthClient } from "../core/auth";
import type { RemoteUser } from "../core/auth";
import { ScriptEngine } from "../core/script";
import { ReportEngine } from "../core/report";
import type { ShapeType } from "../core";
import { RemoteProjectStore } from "../core/project/remote";
import type { RemoteProject } from "../core/project/remote";
import { isConflictError } from "../core/project/remote";
import {
  createDraftBackup,
  createIndexedDbDraftBackupStore,
} from "../core/project/backup";
import type { DraftBackup, DraftBackupStore } from "../core/project/backup";
import type { RemoteProjectLink } from "../core/project";
import {
  AutosaveController,
  DEFAULT_PAGE_VIEW,
  applyAutosaveSnapshot,
  buildAutosaveSnapshot,
  createIndexedDbAutosaveStore,
  defaultPageViews,
  isProjectPackageFile,
  isAutosaveSnapshot,
  normalizePageView,
  unpackProjectPackage,
} from "../core";
import type { AutosaveSnapshot, PageViewState } from "../core";

export type ToolMode = "select" | "rect" | "circle" | "line" | "text";
export type RemoteDialog = "none" | "auth" | "projects" | "push";

export type PushResult =
  | { ok: true; created: boolean; version: number; id: string }
  | { ok: false; reason: "conflict"; projectId: string; error: Error }
  | { ok: false; reason: "error"; error: Error };

export type RightPanel =
  | "properties"
  | "bindings"
  | "animations"
  | "variables"
  | "connections"
  | "pages"
  | "alarm"
  | "trend"
  | "auth"
  | "script"
  | "report";

interface EditorState {
  scene: SceneGraph;
  renderer: Renderer | null;
  history: CommandHistory;
  mode: ToolMode;
  selectedId: string | null;
  clipboard: ShapeBase | null;
  pageTitle: string;
  pageWidth: number;
  pageHeight: number;
  pageBackground: string;
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
  remoteUser: RemoteUser | null;
  remoteList: RemoteProject[] | null;
  backupList: DraftBackup[] | null;
  remoteLink: RemoteProjectLink | null;
  syncDialog: RemoteDialog;
  remoteBusy: boolean;
  pendingConflict: { projectId: string } | null;
  scriptEngine: ScriptEngine;
  reportEngine: ReportEngine;
  activePageId: string;
  rightPanel: RightPanel;
  simRunning: boolean;
  previewRunning: boolean;
  wsConfig: { url: string; backupUrl?: string };
  connectionConfig: ConnectionConfig;
  pageViews: Record<string, PageViewState>;
  pageRevision: number;
  varRevision: number;
  shapeRevision: number;
  historyRevision: number;
  viewport: Viewport;
  zoom: number;
  panX: number;
  panY: number;
  viewRevision: number;
  outOfBounds: OutOfBoundsShape[];
  setRenderer: (r: Renderer) => void;
  setMode: (m: ToolMode) => void;
  setRightPanel: (p: RightPanel) => void;
  selectShape: (id: string | null) => void;
  selectShapes: (ids: string[]) => void;
  addShape: (t: ShapeType, x?: number, y?: number) => void;
  deleteSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  updateShape: (id: string, props: any, record?: boolean) => void;
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
  setPageResolution: (pageId: string, width: number, height: number) => void;
  scaleShapesToResolution: (width: number, height: number) => void;
  setPageBackground: (pageId: string, background: string) => void;
  exportProject: () => void;
  importProject: (j: string) => void;
  exportProjectPackage: () => Promise<void>;
  openProjectPackage: (file: File) => Promise<void>;
  importSvgText: (svgText: string) => SvgImportResult;
  importSvgFile: (file: File) => void;
  importRasterFile: (file: File) => void;
  toggleSimulation: () => void;
  togglePreview: () => void;
  setWsConfig: (c: { url: string; backupUrl?: string }) => void;
  setConnectionConfig: (c: ConnectionConfig) => void;
  setPageView: (pageId: string, view: PageViewState) => void;
  restoreSession: () => Promise<boolean>;
  flushAutosave: () => void;
  newProject: () => void;
  saveProject: () => void;
  openProject: (f: File) => void;
  exportScene: () => void;
  importScene: (j: string) => void;
  switchPage: (id: string) => void;
  addPage: () => void;
  deletePage: (id: string) => void;
  renamePage: (id: string, t: string) => void;
  movePage: (id: string, newOrder: number) => void;
  syncSceneToProject: () => void;
  acknowledgeAlarm: (id: string) => void;
  acknowledgeAllAlarms: () => void;
  saveAlarmRule: (rule: AlarmRule) => Promise<void>;
  deleteAlarmRule: (id: string) => Promise<void>;
  bumpVarRevision: () => void;
  bumpShapeRevision: () => void;
  bumpHistoryRevision: () => void;
  initRemoteAuth: () => void;
  setRemoteDialog: (d: RemoteDialog) => void;
  loginRemote: (
    username: string,
    password: string,
    baseUrl?: string
  ) => Promise<RemoteUser>;
  changeRemotePassword: (
    oldPassword: string,
    newPassword: string
  ) => Promise<void>;
  logoutRemote: () => void;
  saveRemoteBaseUrl: (url: string) => void;
  refreshRemoteList: () => Promise<RemoteProject[]>;
  openRemoteProject: (id: string, row?: RemoteProject) => Promise<void>;
  deleteRemoteProject: (id: string) => Promise<void>;
  syncToBackend: () => Promise<void>;
  pushProject: (opts: { id: string; version?: number }) => Promise<PushResult>;
  pushOverwriteRemote: (id: string) => Promise<PushResult>;
  clearPendingConflict: () => void;
  listDraftBackups: () => Promise<DraftBackup[]>;
  restoreDraftBackup: (id: string) => Promise<void>;
  removeDraftBackup: (id: string) => Promise<void>;
}

// ============================================================
// 自动保存（IndexedDB）：停止编辑约 1 秒后写入本地快照；
// 快照只含工程数据与每页视图状态，不含选中项/面板/剪贴板
// ============================================================
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

export const useEditorStore = create<EditorState>((set, get) => {
  const scene = new SceneGraph();
  const historyByPage = new Map<string, CommandHistory>();
  let activeHistory = new CommandHistory();
  let pendingEdit: {
    id: string;
    before: ShapeProps;
    index: number;
  } | null = null;
  const varManager = new VariableManager();
  const bindingEngine = new BindingEngine(scene, varManager);
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
  historyByPage.set(dp.id, activeHistory);
  const initialViewport = new Viewport();

  const pushCommand = (command: ShapeCommand) => {
    activeHistory.push(command);
    set((s) => ({ historyRevision: s.historyRevision + 1 }));
  };

  const pushBatchCommand = (commands: ShapeCommand[]) => {
    activeHistory.pushBatch(commands);
    set((s) => ({ historyRevision: s.historyRevision + 1 }));
  };

  const syncView = (s: EditorState) => {
    const view = normalizePageView(s.viewport.toJSON());
    set((st) => ({
      zoom: view.zoom,
      panX: view.panX,
      panY: view.panY,
      viewRevision: st.viewRevision + 1,
      pageViews: { ...st.pageViews, [st.activePageId]: view },
    }));
    scheduleAutosave();
  };

  const syncOutOfBounds = (
    scene: SceneGraph,
    width: number,
    height: number
  ) => {
    const list = getOutOfBoundsShapes(scene, width, height);
    const cur = get().outOfBounds;
    if (JSON.stringify(cur) !== JSON.stringify(list))
      set({ outOfBounds: list });
  };

  const fitViewport = (vp: Viewport, width: number, height: number) => {
    const r = get().renderer;
    if (r) vp.fitPage(width, height, r.width, r.height);
    else vp.fitPage(width, height, 1280, 800);
  };

  const activateViewport = (fit: boolean) => {
    const s = get();
    const pageId = s.activePageId;
    const stored = normalizePageView(s.pageViews[pageId]);
    const vp = new Viewport();
    vp.zoom = stored.zoom;
    vp.panX = stored.panX;
    vp.panY = stored.panY;
    const meta = s.projectManager.getPageMeta(pageId);
    if (fit && meta) fitViewport(vp, meta.width, meta.height);
    s.renderer?.setViewport(vp);
    if (meta) {
      s.renderer?.setPage(
        meta.width,
        meta.height,
        meta.background ?? "#FFFFFF"
      );
    }
    set({
      viewport: vp,
      zoom: vp.zoom,
      panX: vp.panX,
      panY: vp.panY,
      viewRevision: get().viewRevision + 1,
      pageViews: {
        ...s.pageViews,
        [pageId]: normalizePageView(vp.toJSON()),
      },
    });
    s.renderer?.render();
  };

  const resetHistory = (pageId: string) => {
    historyByPage.clear();
    pendingEdit = null;
    const h = new CommandHistory();
    historyByPage.set(pageId, h);
    activeHistory = h;
    set({ history: h, historyRevision: 0 });
  };

  /** 用工程数据替换当前编辑内容（打开/导入共用） */
  const loadProjectData = (data: ProjectData) => {
    const s = get();
    s.projectManager.importProject(data);
    const f = s.projectManager.activePage;
    if (!f) throw new Error("工程没有页面");
    s.scene.clear();
    for (const sh of f.scene.getAll()) s.scene.add(sh);
    resetHistory(f.meta.id);
    set({
      activePageId: f.meta.id,
      pageTitle: f.meta.title,
      pageWidth: f.meta.width,
      pageHeight: f.meta.height,
      pageBackground: f.meta.background,
      selectedId: null,
      pageViews: defaultPageViews(s.projectManager),
      remoteLink: null,
    });
    s.projectManager.setRemoteLink(null);
    s.bindingEngine.rebuildIndex();
    activateViewport(true);
    s.renderer?.render();
    flushAutosave();
  };

  return {
    scene,
    history: activeHistory,
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
    remoteUser: null,
    remoteList: null,
    backupList: null,
    remoteLink: projectManager.remoteLink,
    syncDialog: "none",
    remoteBusy: false,
    pendingConflict: null,
    scriptEngine,
    reportEngine,
    renderer: null,
    mode: "select",
    selectedId: null,
    clipboard: null,
    pageTitle: dp.title,
    pageWidth: dp.width,
    pageHeight: dp.height,
    pageBackground: dp.background,
    activePageId: dp.id,
    rightPanel: "properties",
    simRunning: false,
    previewRunning: false,
    wsConfig: { url: "ws://localhost:8080/iscs/data" },
    connectionConfig: loadConnectionConfig() ?? DEFAULT_CONNECTION_CONFIG,
    pageViews: { [dp.id]: { ...DEFAULT_PAGE_VIEW } },
    pageRevision: 0,
    varRevision: 0,
    shapeRevision: 0,
    historyRevision: 0,
    viewport: initialViewport,
    zoom: 1,
    panX: 0,
    panY: 0,
    viewRevision: 0,
    outOfBounds: getOutOfBoundsShapes(scene, dp.width, dp.height),
    setRenderer: (r) => {
      set({ renderer: r });
      const s = get();
      r.setViewport(s.viewport);
      const meta = s.projectManager.getPageMeta(s.activePageId);
      r.setPage(s.pageWidth, s.pageHeight, meta?.background ?? "#FFFFFF");
      s.bindingEngine.setRenderer(r);
      s.animEngine.setRenderer(r);
      s.fitPage();
    },
    setMode: (m) => set({ mode: m }),
    setRightPanel: (p) => set({ rightPanel: p }),
    selectShape: (id) => {
      const s = get();
      if (id === null) pendingEdit = null;
      set({ selectedId: id });
      if (s.renderer) {
        s.renderer.selectedIds.clear();
        if (id) s.renderer.selectedIds.add(id);
        s.renderer.render();
      }
    },
    selectShapes: (ids) => {
      const s = get();
      set({ selectedId: ids[0] ?? null });
      if (s.renderer) {
        s.renderer.selectedIds = new Set(ids);
        s.renderer.render();
      }
    },
    addShape: (type, x, y) => {
      const s = get();
      const sh = createShape(type, {
        x: x ?? 200,
        y: y ?? 200,
        width: type === "circle" ? 80 : 120,
        height: type === "circle" ? 80 : 80,
        fill: type === "text" ? "#000000" : "#4A90D9",
        stroke: "#333333",
        strokeWidth: 2,
        text: type === "text" ? "双击编辑" : undefined,
        fontSize: type === "text" ? 24 : undefined,
        d: type === "path" ? "M15 10 L105 10 L105 70 L15 70 Z" : undefined,
        children:
          type === "group"
            ? [
                {
                  id: generateId(),
                  type: "rect",
                  x: 0,
                  y: 0,
                  width: 70,
                  height: 60,
                  fill: "#4A90D9",
                  stroke: "#333333",
                  strokeWidth: 2,
                },
                {
                  id: generateId(),
                  type: "circle",
                  x: 80,
                  y: 5,
                  width: 55,
                  height: 55,
                  fill: "#E67E22",
                  stroke: "#333333",
                  strokeWidth: 2,
                },
              ]
            : undefined,
        src: type === "image" ? "" : undefined,
        breakerStatus: "open",
        signalColor: type === "metro-signal" ? "gray" : undefined,
        running: false,
        speedPercent: 0,
        value: 0,
        min: 0,
        max: 100,
        unit: "A",
        primaryVoltage: "35kV",
        secondaryVoltage: "400V",
        voltageLevel: "400V",
        energized: true,
        label: "",
        labelPosition: "bottom",
      });
      s.scene.add(sh);
      pushCommand({
        id: sh.id,
        before: null,
        after: sh.toJSON(),
        index: s.scene.getAll().indexOf(sh),
      });
      syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
      s.renderer?.render();
    },
    deleteSelected: () => {
      const s = get();
      if (s.selectedId) {
        const sh = s.scene.get(s.selectedId);
        if (sh) {
          if (pendingEdit?.id === sh.id) pendingEdit = null;
          const command: ShapeCommand = {
            id: sh.id,
            before: sh.toJSON(),
            after: null,
            index: s.scene.getAll().indexOf(sh),
          };
          s.scene.remove(sh.id);
          pushCommand(command);
        }
        set({ selectedId: null });
        if (s.renderer) {
          s.renderer.selectedIds.clear();
          s.renderer.render();
        }
      }
      syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
    },
    copySelected: () => {
      const s = get();
      if (s.selectedId) {
        const sh = s.scene.get(s.selectedId);
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
        s.scene.add(c);
        pushCommand({
          id: c.id,
          before: null,
          after: c.toJSON(),
          index: s.scene.getAll().indexOf(c),
        });
        set({ selectedId: c.id });
        syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
        s.renderer?.render();
      }
    },
    updateShape: (id, props, record = true) => {
      const s = get();
      const sh = s.scene.get(id);
      if (sh) {
        const before = sh.toJSON();
        if (sh.type === "metro-breaker" && props.breakerStatus !== undefined) {
          (sh as any).setStatus(props.breakerStatus);
          delete props.breakerStatus;
        }
        Object.assign(sh, props);
        const after = sh.toJSON();
        if (before.zIndex !== after.zIndex) s.scene.markDirty();
        s.renderer?.render();
        // 通知 React：shape 是原地修改的，必须触发订阅面板（绑定/属性）重新渲染
        s.bumpShapeRevision();
        syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
        if (record && JSON.stringify(before) !== JSON.stringify(after)) {
          pushCommand({
            id,
            before,
            after,
            index: s.scene.getAll().indexOf(sh),
          });
        }
      }
    },
    beginShapeEdit: (id) => {
      const s = get();
      const sh = s.scene.get(id);
      if (!sh) return;
      pendingEdit = {
        id,
        before: sh.toJSON(),
        index: s.scene.getAll().indexOf(sh),
      };
    },
    endShapeEdit: () => {
      if (!pendingEdit) return;
      const { id, before, index } = pendingEdit;
      pendingEdit = null;
      const sh = get().scene.get(id);
      if (!sh) return;
      const after = sh.toJSON();
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      pushCommand({ id, before, after, index });
    },
    applyShapeResize: (id, handle, pointer, options) => {
      const s = get();
      const sh = s.scene.get(id);
      if (!sh || sh.locked) return;
      applyResize(sh, handle, pointer, options);
      s.renderer?.render();
      s.bumpShapeRevision();
      syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
    },
    undo: () => {
      const s = get();
      pendingEdit = null;
      const command = activeHistory.undo(s.scene);
      if (!command) return;
      if (command.batch) {
        for (const c of command.batch) s.bindingEngine.reindexShape(c.id);
        set({ selectedId: null });
        if (s.renderer) {
          s.renderer.selectedIds.clear();
          s.renderer.render();
        }
      } else {
        s.bindingEngine.reindexShape(command.id);
        set({
          selectedId: s.scene.get(command.id) ? command.id : null,
        });
        if (s.renderer) {
          s.renderer.selectedIds.clear();
          if (s.scene.get(command.id)) s.renderer.selectedIds.add(command.id);
          s.renderer.render();
        }
      }
      syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
      s.bumpShapeRevision();
      s.bumpHistoryRevision();
    },
    redo: () => {
      const s = get();
      pendingEdit = null;
      const command = activeHistory.redo(s.scene);
      if (!command) return;
      if (command.batch) {
        for (const c of command.batch) s.bindingEngine.reindexShape(c.id);
        set({ selectedId: null });
        if (s.renderer) {
          s.renderer.selectedIds.clear();
          s.renderer.render();
        }
      } else {
        s.bindingEngine.reindexShape(command.id);
        set({
          selectedId: s.scene.get(command.id) ? command.id : null,
        });
        if (s.renderer) {
          s.renderer.selectedIds.clear();
          if (s.scene.get(command.id)) s.renderer.selectedIds.add(command.id);
          s.renderer.render();
        }
      }
      syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
      s.bumpShapeRevision();
      s.bumpHistoryRevision();
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
      s.viewport.zoomToPage(zoom, s.pageWidth, s.pageHeight, r.width, r.height);
      syncView(s);
      r.render();
    },
    fitPage: () => {
      const s = get();
      const r = s.renderer;
      if (!r) return;
      s.viewport.fitPage(s.pageWidth, s.pageHeight, r.width, r.height);
      syncView(s);
      r.render();
    },
    syncSceneToProject: () => {
      get().projectManager.syncScene(get().activePageId, get().scene);
    },
    newProject: () => {
      const s = get();
      s.projectManager.newProject();
      const f = s.projectManager.activePage;
      if (f) {
        s.scene.clear();
        resetHistory(f.meta.id);
        set({
          activePageId: f.meta.id,
          pageTitle: f.meta.title,
          pageWidth: f.meta.width,
          pageHeight: f.meta.height,
          pageBackground: f.meta.background,
          selectedId: null,
          pageViews: defaultPageViews(s.projectManager),
          remoteLink: null,
        });
        activateViewport(true);
        s.renderer?.render();
        flushAutosave();
      }
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
      const s = get();
      try {
        const d = JSON.parse(json);
        if (d.pages) {
          loadProjectData(d);
        } else if (d.shapes) {
          s.scene.clear();
          for (const sp of d.shapes) s.scene.add(createShape(sp.type, sp));
          resetHistory(s.activePageId);
          activateViewport(true);
          s.renderer?.render();
          flushAutosave();
        }
      } catch {}
    },
    switchPage: (pageId) => {
      const s = get();
      s.projectManager.syncScene(s.activePageId, s.scene);
      const ps = s.projectManager.setActivePage(pageId);
      if (ps) {
        s.scene.clear();
        for (const sh of ps.getAll()) s.scene.add(sh);
        const m = s.projectManager.getPageMeta(pageId);
        if (m)
          set({
            activePageId: pageId,
            pageTitle: m.title,
            pageWidth: m.width,
            pageHeight: m.height,
            pageBackground: m.background,
            selectedId: null,
          });
        let h = historyByPage.get(pageId);
        if (!h) {
          h = new CommandHistory();
          historyByPage.set(pageId, h);
        }
        activeHistory = h;
        pendingEdit = null;
        set({ history: h, historyRevision: 0 });
        activateViewport(false);
        if (m) syncOutOfBounds(s.scene, m.width, m.height);
        s.bindingEngine.rebuildIndex();
        s.renderer?.render();
        flushAutosave();
      }
    },
    addPage: () => {
      const s = get();
      s.projectManager.syncScene(s.activePageId, s.scene);
      const { meta, scene: ns } = s.projectManager.createPage();
      s.projectManager.activePageId = meta.id;
      s.scene.clear();
      for (const sh of ns.getAll()) s.scene.add(sh);
      const h = new CommandHistory();
      historyByPage.set(meta.id, h);
      activeHistory = h;
      pendingEdit = null;
      set({
        activePageId: meta.id,
        pageTitle: meta.title,
        pageWidth: meta.width,
        pageHeight: meta.height,
        pageBackground: meta.background,
        selectedId: null,
        history: h,
        historyRevision: 0,
        pageViews: {
          ...s.pageViews,
          [meta.id]: { ...DEFAULT_PAGE_VIEW },
        },
      });
      activateViewport(true);
      s.renderer?.render();
      flushAutosave();
    },
    deletePage: (pageId) => {
      const s = get();
      if (s.projectManager.getPages().length <= 1) return;
      historyByPage.delete(pageId);
      pendingEdit = null;
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
      if (pageId === s.activePageId) set({ pageTitle: newTitle });
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
        set({ pageWidth: w, pageHeight: h });
        syncOutOfBounds(s.scene, w, h);
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
      const shapes = s.scene.getAll();
      const commands: ShapeCommand[] = [];
      for (const shape of shapes) {
        const before = shape.toJSON();
        scaleShape(shape, factor);
        const after = shape.toJSON();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          commands.push({
            id: shape.id,
            before,
            after,
            index: s.scene.getAll().indexOf(shape),
          });
        }
      }
      if (commands.length > 0) pushBatchCommand(commands);
      meta.width = newW;
      meta.height = newH;
      meta.updatedAt = new Date().toISOString();
      s.projectManager.dirty = true;
      set({ pageWidth: newW, pageHeight: newH });
      syncOutOfBounds(s.scene, newW, newH);
      s.renderer?.setPage(newW, newH, meta.background ?? "#FFFFFF");
      s.renderer?.render();
      s.bumpShapeRevision();
      flushAutosave();
    },
    setPageBackground: (pageId, background) => {
      const s = get();
      const color = sanitizePageBackground(background);
      s.projectManager.setPageBackground(pageId, color);
      const meta = s.projectManager.getPageMeta(pageId);
      if (pageId === s.activePageId && meta) {
        set({ pageBackground: color });
        s.renderer?.setPage(meta.width, meta.height, color);
        s.renderer?.render();
      }
      flushAutosave();
    },
    exportProject: () => {
      const s = get();
      s.syncSceneToProject();
      flushAutosave();
      s.projectManager.downloadProject();
    },
    importProject: (json) => {
      get().importScene(json);
    },
    importSvgText: (svgText) => {
      const s = get();
      const result = importSvg(svgText, {
        pageWidth: s.pageWidth,
        pageHeight: s.pageHeight,
      });
      if (result.shapes.length === 0) return result;

      const commands: ShapeCommand[] = [];
      for (const shape of result.shapes) {
        s.scene.add(shape);
        commands.push({
          id: shape.id,
          before: null,
          after: shape.toJSON(),
          index: s.scene.getAll().indexOf(shape),
        });
      }
      pushBatchCommand(commands);
      s.selectShapes(result.shapes.map((sh) => sh.id));
      syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
      s.renderer?.render();
      s.projectManager.dirty = true;
      flushAutosave();
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
        const shape = await rasterDataUrlToImageShape(src, {
          pageWidth: s.pageWidth,
          pageHeight: s.pageHeight,
        });
        s.scene.add(shape);
        pushCommand({
          id: shape.id,
          before: null,
          after: shape.toJSON(),
          index: s.scene.getAll().indexOf(shape),
        });
        s.selectShape(shape.id);
        syncOutOfBounds(s.scene, s.pageWidth, s.pageHeight);
        s.renderer?.render();
        s.projectManager.dirty = true;
        flushAutosave();
      } catch (e) {
        alert("图片导入失败：" + (e instanceof Error ? e.message : String(e)));
      }
    },
    toggleSimulation: () => {
      const s = get();
      if (s.simRunning) {
        s.varManager.stopSimulation();
        if (!s.previewRunning) s.animEngine.stop();
        s.dataBridge.stop();
        s.alarmManager.stop();
        s.historian.stop();
        s.scriptEngine.stop();
        set({ simRunning: false });
      } else {
        s.alarmManager.setMode(
          s.dataBridge.active === "simulation" ? "local" : "remote"
        );
        if (s.dataBridge.active !== "simulation") {
          s.alarmManager.setRemote(
            s.dataBridge.wsClient,
            s.dataBridge.getApiBaseUrl()
          );
        }
        if (s.varManager.count === 0) {
          s.varManager.defineMany([
            {
              id: "STA1_211_ACB_STATUS",
              name: "211断路器状态",
              type: "DI",
              address: "104.1.1.243.0",
              defaultValue: 0,
              unit: "",
              description: "",
              group: "供电",
              min: 0,
              max: 1,
            },
            {
              id: "STA1_211_IA",
              name: "A相电流",
              type: "AI",
              address: "104.1.1.243.2",
              defaultValue: 0,
              unit: "A",
              description: "",
              group: "供电",
              min: 0,
              max: 2000,
            },
            {
              id: "STA1_BUS_VOLTAGE",
              name: "母线电压",
              type: "AI",
              address: "104.1.1.244.0",
              defaultValue: 400,
              unit: "V",
              description: "",
              group: "供电",
              min: 0,
              max: 500,
            },
            {
              id: "STA1_FAN_1_STATUS",
              name: "风机状态",
              type: "DI",
              address: "104.2.1.10.0",
              defaultValue: 0,
              unit: "",
              description: "",
              group: "BAS",
              min: 0,
              max: 1,
            },
            {
              id: "STA1_FAN_1_SPEED",
              name: "风机转速",
              type: "AI",
              address: "104.2.1.10.1",
              defaultValue: 0,
              unit: "rpm",
              description: "",
              group: "BAS",
              min: 0,
              max: 3000,
            },
            {
              id: "STA1_TEMP_ZONE1",
              name: "站厅温度",
              type: "AI",
              address: "104.2.1.20.0",
              defaultValue: 25,
              unit: "℃",
              description: "",
              group: "BAS",
              min: 0,
              max: 50,
            },
          ]);
          if (s.dataBridge.active === "simulation") {
            s.alarmManager.loadPresets();
          }
          s.scriptEngine.loadPresets();
          s.historian.setVariables([
            "STA1_211_IA",
            "STA1_BUS_VOLTAGE",
            "STA1_FAN_1_SPEED",
            "STA1_TEMP_ZONE1",
          ]);
        }
        if (!s.previewRunning) s.animEngine.start();
        s.alarmManager.start();
        s.scriptEngine.start();
        if (s.dataBridge.active === "simulation")
          s.varManager.startSimulation(800);
        s.historian.start();
        set({ simRunning: true });
      }
    },
    togglePreview: () => {
      const s = get();
      if (s.previewRunning) {
        if (!s.simRunning) s.animEngine.stop();
        set({ previewRunning: false });
      } else {
        if (!s.simRunning && !s.animEngine.isRunning) s.animEngine.start();
        set({ previewRunning: true });
      }
    },
    setWsConfig: (c) => {
      set({ wsConfig: c });
      const urls = [c.url, ...(c.backupUrl ? [c.backupUrl] : [])];
      get().dataBridge.wsClient.updateConfig({ urls });
    },
    setConnectionConfig: (c) => {
      set({ connectionConfig: c });
      saveConnectionConfig(c);
    },
    setPageView: (pageId, view) => {
      set((st) => ({
        pageViews: {
          ...st.pageViews,
          [pageId]: normalizePageView(view),
        },
      }));
      scheduleAutosave();
      if (pageId === get().activePageId) activateViewport(false);
    },
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
          s.scene.clear();
          for (const sh of f.scene.getAll()) s.scene.add(sh);
          resetHistory(f.meta.id);
          set({
            activePageId: s.projectManager.activePageId,
            pageTitle: f.meta.title,
            pageWidth: f.meta.width,
            pageHeight: f.meta.height,
            pageBackground: f.meta.background,
            selectedId: null,
            pageViews: views,
          });
          s.bindingEngine.rebuildIndex();
          syncOutOfBounds(s.scene, f.meta.width, f.meta.height);
          activateViewport(false);
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
    acknowledgeAlarm: (id) => {
      get().alarmManager.acknowledge(
        id,
        get().authManager.user?.username ?? "operator"
      );
    },
    acknowledgeAllAlarms: () => {
      get().alarmManager.acknowledgeAll(
        get().authManager.user?.username ?? "operator"
      );
    },
    saveAlarmRule: async (rule) => {
      await get().alarmManager.saveRule(rule);
    },
    deleteAlarmRule: async (id) => {
      await get().alarmManager.deleteRule(id);
    },
    bumpVarRevision: () => set((s) => ({ varRevision: s.varRevision + 1 })),
    bumpShapeRevision: () =>
      set((s) => ({ shapeRevision: s.shapeRevision + 1 })),
    bumpHistoryRevision: () =>
      set((s) => ({ historyRevision: s.historyRevision + 1 })),
    initRemoteAuth: () => {
      const s = get();
      s.remoteAuth.restore();
      s.remoteAuth.onChange(() => {
        const u = get().remoteAuth.user;
        set((st) => ({
          remoteUser: u,
          remoteList: u ? st.remoteList : null,
          syncDialog: u ? st.syncDialog : "none",
        }));
      });
      set({ remoteUser: s.remoteAuth.user });
    },
    setRemoteDialog: (d) =>
      set({
        syncDialog: d,
        pendingConflict: d === "push" ? get().pendingConflict : null,
      }),
    loginRemote: async (username, password, baseUrl) => {
      const u = await get().remoteAuth.login(username, password, baseUrl);
      set({ remoteUser: u });
      return u;
    },
    changeRemotePassword: async (oldPassword, newPassword) => {
      await get().remoteAuth.changePassword(oldPassword, newPassword);
    },
    logoutRemote: () => {
      get().remoteAuth.logout();
      set({ syncDialog: "none", pendingConflict: null });
    },
    saveRemoteBaseUrl: (url) => {
      get().remoteAuth.setBaseUrl(url);
    },
    refreshRemoteList: async () => {
      const list = await get().remoteProjects.list();
      set({ remoteList: list });
      return list;
    },
    openRemoteProject: async (id, row) => {
      const s = get();
      s.syncSceneToProject();
      s.flushAutosave();
      await s.draftBackupStore.save(
        createDraftBackup(
          s.projectManager.meta.name,
          s.projectManager.exportProject(),
          s.activePageId,
          s.pageViews
        )
      );
      const bytes = await s.remoteProjects.get(id);
      const data = await unpackProjectPackage(bytes);
      loadProjectData(data);
      const link: RemoteProjectLink = {
        id,
        name: row?.name || data.meta.name || id,
        version: row?.version ?? 0,
        linkedAt: new Date().toISOString(),
      };
      s.projectManager.setRemoteLink(link);
      set({
        remoteLink: link,
        remoteList: s.remoteList,
        syncDialog: "none",
      });
    },
    deleteRemoteProject: async (id) => {
      const s = get();
      await s.remoteProjects.remove(id);
      const list = await s.remoteProjects.list();
      if (s.projectManager.remoteLink?.id === id) {
        s.projectManager.setRemoteLink(null);
        set({ remoteLink: null });
      }
      set({ remoteList: list });
    },
    syncToBackend: async () => {
      const s = get();
      if (!s.remoteAuth.isLoggedIn) {
        set({ syncDialog: "auth" });
        return;
      }
      const link = s.projectManager.remoteLink;
      if (!link) {
        // 尚未关联远端工程：先让用户选择目标（新建或已有）
        set({ syncDialog: "push" });
        return;
      }
      const result = await s.pushProject({
        id: link.id,
        version: link.version,
      });
      if (result.ok) {
        set({ syncDialog: "none", pendingConflict: null });
        alert(
          `已同步到后端：${result.id} (v${result.version}${
            result.created ? "，新建" : ""
          })`
        );
      } else if (result.reason === "conflict") {
        set({ syncDialog: "push" });
      } else {
        alert(
          "同步失败：" +
            (result.error instanceof Error
              ? result.error.message
              : String(result.error))
        );
      }
    },
    pushProject: async ({ id, version }) => {
      const s = get();
      s.syncSceneToProject();
      s.flushAutosave();
      set({ remoteBusy: true });
      try {
        const bytes = await s.projectManager.toPackageBytes();
        const out = await s.remoteProjects.put(id, bytes, version);
        const link: RemoteProjectLink = {
          id,
          name: s.projectManager.meta.name,
          version: out.version,
          linkedAt: new Date().toISOString(),
        };
        s.projectManager.setRemoteLink(link);
        set({ remoteLink: link });
        return {
          ok: true as const,
          created: out.created,
          version: out.version,
          id,
        };
      } catch (e) {
        if (isConflictError(e)) {
          set({ pendingConflict: { projectId: id } });
          return {
            ok: false as const,
            reason: "conflict" as const,
            projectId: id,
            error: e,
          };
        }
        return {
          ok: false as const,
          reason: "error" as const,
          error: e instanceof Error ? e : new Error(String(e)),
        };
      } finally {
        set({ remoteBusy: false });
      }
    },
    pushOverwriteRemote: async (id) => {
      const s = get();
      let rows = s.remoteList;
      if (!rows) {
        try {
          rows = await s.remoteProjects.list();
        } catch {
          rows = [];
        }
      }
      const row = rows.find((r) => r.id === id);
      const result = await s.pushProject({
        id,
        version: row?.version,
      });
      if (result.ok) {
        set({ pendingConflict: null, syncDialog: "none" });
        alert(`已覆盖远端：${result.id} (v${result.version})`);
      }
      return result;
    },
    clearPendingConflict: () => set({ pendingConflict: null }),
    listDraftBackups: async () => {
      const list = await get().draftBackupStore.list();
      set({ backupList: list });
      return list;
    },
    restoreDraftBackup: async (id) => {
      const s = get();
      const backup = await s.draftBackupStore.load(id);
      if (!backup) return;
      // 先备份当前工程，避免恢复操作造成新的丢失
      s.syncSceneToProject();
      await s.draftBackupStore.save(
        createDraftBackup(
          s.projectManager.meta.name,
          s.projectManager.exportProject(),
          s.activePageId,
          s.pageViews
        )
      );
      loadProjectData(backup.project);
      set({ pageViews: backup.views });
      if (backup.activePageId !== get().activePageId) {
        get().switchPage(backup.activePageId);
      }
      s.projectManager.setRemoteLink(null);
      set({ remoteLink: null, syncDialog: "none" });
    },
    removeDraftBackup: async (id) => {
      await get().draftBackupStore.remove(id);
      await get().listDraftBackups();
    },
  };
});

// 图元/绑定/动画等编辑通过 revision 计数器触发防抖自动保存；
// 变量实时值（varRevision）不参与保存
useEditorStore.subscribe((state, prev) => {
  if (
    state.shapeRevision !== prev.shapeRevision ||
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
