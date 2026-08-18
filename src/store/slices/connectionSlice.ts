import {
  DEFAULT_CONNECTION_CONFIG,
  loadConnectionConfig,
  saveConnectionConfig,
} from "../../core";
import type { ConnectionConfig } from "../../core";
import type { StoreSet, StoreGet } from "../editorStoreTypes";

/** 连接/运行领域的状态与动作（精确类型）。 */
export interface ConnectionSliceState {
  simRunning: boolean;
  previewRunning: boolean;
  wsConfig: { url: string; backupUrl?: string };
  connectionConfig: ConnectionConfig;
  toggleSimulation: () => void;
  togglePreview: () => void;
  setWsConfig: (c: { url: string; backupUrl?: string }) => void;
  setConnectionConfig: (c: ConnectionConfig) => void;
}

/**
 * 连接/运行领域：数据源连接配置、模拟与预览运行状态。
 */
export const createConnectionSlice = (
  set: StoreSet,
  get: StoreGet
): ConnectionSliceState => {
  return {
    simRunning: false,
    previewRunning: false,
    wsConfig: { url: "ws://localhost:8080/iscs/data" },
    connectionConfig: loadConnectionConfig() ?? DEFAULT_CONNECTION_CONFIG,
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
  };
};
