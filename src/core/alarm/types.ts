// ============================================================
// 报警与 SOE 领域类型 —— 单一契约源（F13）
//
// 类型定义统一在 packages/contracts（src/api.ts 报警/SOE 段 +
// src/ws.ts AlarmUpdateMessage），与后端 hmi-io-alarm 序列化对齐；
// 本文件仅为编辑器旧导入路径的兼容再导出。
// ============================================================

export type {
  AlarmSeverity,
  AlarmStatus,
  AlarmCondition,
  AlarmEventType,
  AlarmRule,
  AlarmOccurrence,
  AlarmStreamEvent,
  SoeRecord,
  AlarmHistoryQuery,
  SOEQuery,
  Paged,
  AlarmUpdateMessage,
} from "@hmi/contracts";

/** 兼容别名：契约中的规范命名为 SoeRecord */
export type { SoeRecord as SOERecord } from "@hmi/contracts";
