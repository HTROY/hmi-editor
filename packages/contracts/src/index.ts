// ============================================================
// @hmi/contracts —— 前后端共享契约入口（F13 单一契约源）
//
// 消费方：
// - 主编辑器（src/core/alarm/types.ts、src/core/io/types.ts、
//   src/core/io/WebSocketClient.ts 等）
// - 管理 UI（io-backend/web-ui/src/api/types.ts 等）
//
// 维护约定：REST DTO 与 WS 协议类型定义在本包；JSON Schema 与类型
// 一一对应，契约测试（validate.test.ts / wsContract.test.ts）交叉校验，
// 任何一端改动字段名都会在测试中暴露。
// ============================================================

export * from "./api";
export * from "./ws";
export { validateJson, isValidJson } from "./schema";
export type { JsonSchema } from "./schema";
export { wsClientMessageSchema, wsServerEnvelopeSchema } from "./schemas/ws";
export {
  alarmRuleSchema,
  alarmOccurrenceSchema,
  alarmStreamEventSchema,
  soeRecordSchema,
  pagedSchema,
} from "./schemas/alarm";
