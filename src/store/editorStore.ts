import { create } from "zustand";
import {
  SceneGraph,
  Renderer,
  createShape,
  ShapeBase,
  Serializer,
} from "../core";
import { generateId } from "../core/shapes";
import { VariableManager } from "../core/variables";
import { BindingEngine, AnimationEngine } from "../core/bindings";
import { DataBridge, WebSocketClient } from "../core/io";
import { ProjectManager } from "../core/project";
import { AlarmManager } from "../core/alarm";
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
  wsConfig: { url: string };
  varRevision: number;
  shapeRevision: number;
  setRenderer: (r: Renderer) => void;
  setMode: (m: ToolMode) => void;
  setRightPanel: (p: RightPanel) => void;
  selectShape: (id: string | null) => void;
  addShape: (t: ShapeType, x?: number, y?: number) => void;
  deleteSelected: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  updateShape: (id: string, props: any) => void;
  renderScene: () => void;
  exportProject: () => void;
  importProject: (j: string) => void;
  toggleSimulation: () => void;
  setWsConfig: (c: { url: string }) => void;
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
  bumpVarRevision: () => void;
  bumpShapeRevision: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => {
  const scene = new SceneGraph();
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
  return {
    scene,
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
    setRenderer: (r) => {
      set({ renderer: r });
      get().bindingEngine.setRenderer(r);
      get().animEngine.setRenderer(r);
    },
    setMode: (m) => set({ mode: m }),
    setRightPanel: (p) => set({ rightPanel: p }),
    selectShape: (id) => {
      const s = get();
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
      s.renderer?.render();
    },
    deleteSelected: () => {
      const s = get();
      if (s.selectedId) {
        s.scene.remove(s.selectedId);
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
        set({ selectedId: c.id });
        s.renderer?.render();
      }
    },
    updateShape: (id, props) => {
      const s = get();
      const sh = s.scene.get(id);
      if (sh) {
        if (sh.type === "metro-breaker" && props.breakerStatus !== undefined) {
          (sh as any).setStatus(props.breakerStatus);
          delete props.breakerStatus;
        }
        Object.assign(sh, props);
        s.renderer?.render();
        // 通知 React：shape 是原地修改的，必须触发订阅面板（绑定/属性）重新渲染
        s.bumpShapeRevision();
      }
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
      set({
        activePageId: meta.id,
        pageTitle: meta.title,
        pageWidth: meta.width,
        pageHeight: meta.height,
        selectedId: null,
      });
      s.renderer?.render();
    },
    deletePage: (pageId) => {
      const s = get();
      if (s.projectManager.getPages().length <= 1) return;
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
              alarmHigh: 0,
              alarmLow: 0,
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
              alarmHigh: 1600,
              alarmLow: 0,
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
              alarmHigh: 450,
              alarmLow: 350,
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
              alarmHigh: 0,
              alarmLow: 0,
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
              alarmHigh: 2800,
              alarmLow: 0,
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
              alarmHigh: 30,
              alarmLow: 15,
            },
          ]);
          s.alarmManager.loadPresets();
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
      get().dataBridge.wsClient.updateConfig({ url: c.url });
    },
    acknowledgeAlarm: (id) => {
      get().alarmManager.acknowledge(
        id,
        get().authManager.user?.username ?? "operator",
      );
    },
    acknowledgeAllAlarms: () => {
      get().alarmManager.acknowledgeAll(
        get().authManager.user?.username ?? "operator",
      );
    },
    bumpVarRevision: () => set((s) => ({ varRevision: s.varRevision + 1 })),
    bumpShapeRevision: () =>
      set((s) => ({ shapeRevision: s.shapeRevision + 1 })),
  };
});
