// ============================================================
// 变量 (点) 定义 — 对应轨道交通 ISCS 中的 AI/DI/AO/DO
// ============================================================

/** 变量数据类型 */
export type VariableType = "AI" | "DI" | "AO" | "DO";

/** 变量/点表定义 */
export interface VariableDef {
  id: string; // 唯一标识，如 "STA1_211_ACB_STATUS"
  name: string; // 中文名称，如 "211 断路器状态"
  type: VariableType;
  address: string; // 协议地址，如 "104.1.1.243.0"
  defaultValue: number | boolean;
  unit: string; // 单位，如 "A", "kV", "℃"
  description: string;
  group: string; // 分组，如 "供电/400V开关柜"
  min: number; // 量程下限
  max: number; // 量程上限
  alarmHigh: number; // 高报警限
  alarmLow: number; // 低报警限
}

/** 变量运行时值 */
export interface VariableValue {
  id: string;
  value: number | boolean;
  quality: "good" | "bad" | "uncertain";
  timestamp: number; // 毫秒时间戳
}

/** 变量变化事件回调 */
export type VariableChangeCallback = (
  variableId: string,
  newValue: VariableValue,
) => void;
