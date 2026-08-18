import type {
  SceneGraph,
  Renderer,
  Selection,
  ShapeBase,
  CommandHistory,
  Viewport,
  ProjectData,
  ConnectionConfig,
  UndoRedoResult,
} from "../core";
import type { ShapePath } from "../core";
import type { ShapeProps, ResizeHandle, ResizeOptions } from "../core";
import type { LibraryItem } from "../core/shapes/library";
import type { LibraryGroup } from "../core/shapes/libraryGroups";
import { VariableManager } from "../core/variables";
import { BindingEngine, AnimationEngine } from "../core/bindings";
import { DataBridge } from "../core/io";
import { ProjectManager } from "../core/project";
import { AlarmManager } from "../core/alarm";
import type { AlarmRule } from "../core/alarm/types";
import { Historian } from "../core/historian";
import { AuthManager, RemoteAuthClient } from "../core/auth";
import type { RemoteUser } from "../core/auth";
import { ScriptEngine } from "../core/script";
import { ReportEngine } from "../core/report";
import type { ShapeType } from "../core";
import type { SvgImportResult } from "../core/svg";
import { RemoteProjectStore } from "../core/project/remote";
import type { RemoteProject } from "../core/project/remote";
import type { DraftBackup, DraftBackupStore } from "../core/project/backup";
import type { RemoteProjectLink } from "../core/project";
import type { AutosaveSnapshot, PageViewState } from "../core";
import type { StoreApi } from "zustand";

export type ToolMode = "select" | "rect" | "circle" | "line" | "text";
export type RemoteDialog = "none" | "auth" | "projects" | "push";

export type PushResult =
  | { ok: true; created: boolean; version: number; id: string }
  | { ok: false; reason: "conflict"; projectId: string; error: Error }
  | { ok: false; reason: "error"; error: Error };

export type LeftPanel =
  | "library"
  | "variables"
  | "connections"
  | "pages"
  | "alarm"
  | "trend"
  | "auth"
  | "script"
  | "report";

/** zustand `set` 的类型（与 create<EditorState> 推导一致）。 */
export type StoreSet = StoreApi<EditorState>["setState"];

/** zustand `get` 的类型。 */
export type StoreGet = () => EditorState;

export interface EditorState {
  scene: SceneGraph;
  renderer: Renderer | null;
  history: CommandHistory;
  mode: ToolMode;
  /** 选中状态唯一事实来源（不可变；变更后 selectionRevision 递增触发重渲染） */
  selection: Selection;
  selectionRevision: number;
  clipboard: ShapeBase | null;
  library: LibraryItem[];
  libraryGroups: LibraryGroup[];
  libraryCollapsed: string[];
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
  leftPanel: LeftPanel;
  simRunning: boolean;
  previewRunning: boolean;
  wsConfig: { url: string; backupUrl?: string };
  connectionConfig: ConnectionConfig;
  pageViews: Record<string, PageViewState>;
  pageRevision: number;
  varRevision: number;
  shapeRevision: number;
  libraryRevision: number;
  historyRevision: number;
  viewport: Viewport;
  zoom: number;
  panX: number;
  panY: number;
  viewRevision: number;
  setRenderer: (r: Renderer) => void;
  setMode: (m: ToolMode) => void;
  setLeftPanel: (p: LeftPanel) => void;
  selectShape: (id: string | null) => void;
  selectShapes: (ids: string[]) => void;
  selectShapeAt: (path: ShapePath) => void;
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
  addShape: (t: ShapeType, x?: number, y?: number) => void;
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
  deleteSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  updateShape: (
    id: string,
    props: Partial<ShapeProps>,
    record?: boolean
  ) => void;
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

/** 供 slice 工厂读取的自动保存钩子（由主 store 注入）。 */
export interface AutosaveHooks {
  scheduleAutosave: () => void;
  flushAutosave: () => void;
}

/** slice 工厂的公共签名：接收 set/get 与共享服务，产出本领域的 state 片段。 */
export type EditorSliceFactory = (
  set: StoreSet,
  get: StoreGet,
  services: import("./editorServices").EditorServices,
  hooks: AutosaveHooks
) => Partial<EditorState>;

// 重新导出供各 slice 与外部使用
export type { ProjectData, UndoRedoResult };
export type { AutosaveSnapshot, PageViewState };
