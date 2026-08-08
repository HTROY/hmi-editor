import { create } from "zustand";
import {
  SceneGraph,
  Renderer,
  createShape,
  ShapeBase,
  Serializer,
  CommandHistory,
} from "../core";
import type { ShapeCommand, ShapeProps } from "../core";
import { generateId } from "../core/shapes";
import { VariableManager } from "../core/variables";
import { BindingEngine, AnimationEngine } from "../core/bindings";
import { DataBridge, WebSocketClient } from "../core/io";
import { ProjectManager } from "../core/project";
import { AlarmManager } from "../core/alarm";
import type { AlarmRule } from "../core/alarm/types";
import { Historian } from "../core/historian";
import { AuthManager } from "../core/auth";
import { ScriptEngine } from "../core/script";
import { ReportEngine } from "../core/report";
import type { ShapeType } from "../core";

export type ToolMode = "select" | "rect" | "circle" | "line" | "text";
export type RightPanel =
  | "properties"
  | "bindings"
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
  varManager: VariableManager;
  bindingEngine: BindingEngine;
  animEngine: AnimationEngine;
  dataBridge: DataBridge;
  projectManager: ProjectManager;
  alarmManager: AlarmManager;
  historian: Historian;
  authManager: AuthManager;
  scriptEngine: ScriptEngine;
  reportEngine: ReportEngine;
  activePageId: string;
  rightPanel: RightPanel;
  simRunning: boolean;
  wsConfig: { url: string; backupUrl?: string };
  varRevision: number;
  shapeRevision: number;
  historyRevision: number;
  setRenderer: (r: Renderer) => void;
  setMode: (m: ToolMode) => void;
  setRightPanel: (p: RightPanel) => void;
  selectShape: (id: string | null) => void;
  addShape: (t: ShapeType, x?: number, y?: number) => void;
  deleteSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  updateShape: (id: string, props: any, record?: boolean) => void;
  beginShapeEdit: (id: string) => void;
  endShapeEdit: () => void;
  undo: () => void;
  redo: () => void;
  renderScene: () => void;
  exportProject: () => void;
  importProject: (j: string) => void;
  toggleSimulation: () => void;
  setWsConfig: (c: { url: string; backupUrl?: string }) => void;
  newProject: () => void;
  saveProject: () => void;
  openProject: (f: File) => void;
  exportScene: () => void;
  importScene: (j: string) => void;
  switchPage: (id: string) => void;
  addPage: () => void;
  deletePage: (id: string) => void;
  renamePage: (id: string, t: string) => void;
  syncSceneToProject: () => void;
  acknowledgeAlarm: (id: string) => void;
  acknowledgeAllAlarms: () => void;
  saveAlarmRule: (rule: AlarmRule) => Promise<void>;
  deleteAlarmRule: (id: string) => Promise<void>;
  bumpVarRevision: () => void;
  bumpShapeRevision: () => void;
  bumpHistoryRevision: () => void;
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
  const animEngine = new AnimationEngine(scene);
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
  const scriptEngine = new ScriptEngine(varManager);
  const reportEngine = new ReportEngine(historian);
  scriptEngine.setAlarmManager(alarmManager);
  scriptEngine.setScene(scene);
  const { meta: dp } = projectManager.createPage("主画面");
  projectManager.activePageId = dp.id;
  historyByPage.set(dp.id, activeHistory);

  const pushCommand = (command: ShapeCommand) => {
    activeHistory.push(command);
    set((s) => ({ historyRevision: s.historyRevision + 1 }));
  };

  const resetHistory = (pageId: string) => {
    historyByPage.clear();
    pendingEdit = null;
    const h = new CommandHistory();
    historyByPage.set(pageId, h);
    activeHistory = h;
    set({ history: h, historyRevision: 0 });
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
    scriptEngine,
    reportEngine,
    renderer: null,
    mode: "select",
    selectedId: null,
    clipboard: null,
    pageTitle: dp.title,
    pageWidth: dp.width,
    pageHeight: dp.height,
    activePageId: dp.id,
    rightPanel: "properties",
    simRunning: false,
    wsConfig: { url: "ws://localhost:8080/iscs/data" },
    varRevision: 0,
    shapeRevision: 0,
    historyRevision: 0,
    setRenderer: (r) => {
      set({ renderer: r });
      get().bindingEngine.setRenderer(r);
      get().animEngine.setRenderer(r);
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
    undo: () => {
      const s = get();
      pendingEdit = null;
      const command = activeHistory.undo(s.scene);
      if (!command) return;
      s.bindingEngine.reindexShape(command.id);
      set({
        selectedId: s.scene.get(command.id) ? command.id : null,
      });
      if (s.renderer) {
        s.renderer.selectedIds.clear();
        if (s.scene.get(command.id)) s.renderer.selectedIds.add(command.id);
        s.renderer.render();
      }
      s.bumpShapeRevision();
      s.bumpHistoryRevision();
    },
    redo: () => {
      const s = get();
      pendingEdit = null;
      const command = activeHistory.redo(s.scene);
      if (!command) return;
      s.bindingEngine.reindexShape(command.id);
      set({
        selectedId: s.scene.get(command.id) ? command.id : null,
      });
      if (s.renderer) {
        s.renderer.selectedIds.clear();
        if (s.scene.get(command.id)) s.renderer.selectedIds.add(command.id);
        s.renderer.render();
      }
      s.bumpShapeRevision();
      s.bumpHistoryRevision();
    },
    renderScene: () => {
      get().renderer?.render();
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
          selectedId: null,
        });
        s.renderer?.render();
      }
    },
    saveProject: () => {
      const s = get();
      s.syncSceneToProject();
      s.projectManager.downloadProject();
    },
    openProject: (file) => {
      const s = get();
      const r = new FileReader();
      r.onload = () => {
        try {
          s.projectManager.fromJSON(r.result as string);
          const f = s.projectManager.activePage;
          if (f) {
            s.scene.clear();
            for (const sh of f.scene.getAll()) s.scene.add(sh);
            resetHistory(f.meta.id);
            set({
              activePageId: f.meta.id,
              pageTitle: f.meta.title,
              pageWidth: f.meta.width,
              pageHeight: f.meta.height,
              selectedId: null,
            });
            s.bindingEngine.rebuildIndex();
            s.renderer?.render();
          }
        } catch {
          alert("打开失败");
        }
      };
      r.readAsText(file);
    },
    exportScene: () => {
      const s = get();
      s.syncSceneToProject();
      s.projectManager.downloadProject();
    },
    importScene: (json) => {
      const s = get();
      try {
        const d = JSON.parse(json);
        if (d.pages) {
          s.projectManager.fromJSON(d);
          const f = s.projectManager.activePage;
          if (f) {
            s.scene.clear();
            for (const sh of f.scene.getAll()) s.scene.add(sh);
            resetHistory(f.meta.id);
            set({
              activePageId: f.meta.id,
              pageTitle: f.meta.title,
              pageWidth: f.meta.width,
              pageHeight: f.meta.height,
              selectedId: null,
            });
            s.renderer?.render();
          }
        } else if (d.shapes) {
          s.scene.clear();
          for (const sp of d.shapes) s.scene.add(createShape(sp.type, sp));
          resetHistory(s.activePageId);
          s.renderer?.render();
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
        s.bindingEngine.rebuildIndex();
        s.renderer?.render();
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
        selectedId: null,
        history: h,
        historyRevision: 0,
      });
      s.renderer?.render();
    },
    deletePage: (pageId) => {
      const s = get();
      if (s.projectManager.getPages().length <= 1) return;
      historyByPage.delete(pageId);
      pendingEdit = null;
      s.projectManager.deletePage(pageId);
      const pgs = s.projectManager.getPages();
      if (pgs.length > 0) s.switchPage(pgs[0].id);
    },
    renamePage: (pageId, newTitle) => {
      const s = get();
      s.projectManager.renamePage(pageId, newTitle);
      if (pageId === s.activePageId) set({ pageTitle: newTitle });
    },
    exportProject: () => {
      const s = get();
      s.syncSceneToProject();
      s.projectManager.downloadProject();
    },
    importProject: (json) => {
      get().importScene(json);
    },
    toggleSimulation: () => {
      const s = get();
      if (s.simRunning) {
        s.varManager.stopSimulation();
        s.animEngine.stop();
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
        s.animEngine.start();
        s.alarmManager.start();
        s.scriptEngine.start();
        if (s.dataBridge.active === "simulation")
          s.varManager.startSimulation(800);
        s.historian.start();
        set({ simRunning: true });
      }
    },
    setWsConfig: (c) => {
      set({ wsConfig: c });
      const urls = [c.url, ...(c.backupUrl ? [c.backupUrl] : [])];
      get().dataBridge.wsClient.updateConfig({ urls });
    },
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
  };
});
