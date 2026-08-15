import type { AlarmRule } from "../../core/alarm/types";
import type { StoreSet, StoreGet, AutosaveHooks } from "../editorStoreTypes";
import type { EditorServices } from "../editorServices";

/** 报警领域的状态与动作（精确类型）。 */
export interface AlarmSliceState {
  acknowledgeAlarm: (id: string) => void;
  acknowledgeAllAlarms: () => void;
  saveAlarmRule: (rule: AlarmRule) => Promise<void>;
  deleteAlarmRule: (id: string) => Promise<void>;
}

/**
 * 报警领域：报警确认与规则保存（本地引擎或远端客户端由 AlarmManager 处理）。
 */
export const createAlarmSlice = (
  set: StoreSet,
  get: StoreGet
): AlarmSliceState => {
  return {
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
  };
};
