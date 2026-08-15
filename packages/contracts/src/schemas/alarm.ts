// ============================================================
// 报警/SOE REST DTO 的 JSON Schema（与 api.ts 类型一一对应）
// 契约测试用；字段名与后端 serde 序列化（alarm/types.rs）一致。
// ============================================================

import type { JsonSchema } from "../schema";

const severityEnum = ["critical", "major", "minor", "warning"] as const;
const statusEnum = ["active", "acknowledged", "recovered"] as const;
const conditionEnum = ["high", "low", "equal", "notEqual", "change"] as const;
const eventTypeEnum = ["trigger", "ack", "recover", "rule_disabled"] as const;

export const alarmRuleSchema: JsonSchema = {
  type: "object",
  required: [
    "id",
    "variableId",
    "name",
    "description",
    "severity",
    "group",
    "condition",
    "threshold",
    "enabled",
    "hysteresis",
    "confirmMs",
  ],
  properties: {
    id: { type: "string" },
    variableId: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    severity: { enum: [...severityEnum] },
    group: { type: "string" },
    condition: { enum: [...conditionEnum] },
    threshold: { type: "number" },
    enabled: { type: "boolean" },
    hysteresis: { type: "number" },
    confirmMs: { type: "number" },
  },
};

export const alarmOccurrenceSchema: JsonSchema = {
  type: "object",
  required: [
    "id",
    "ruleId",
    "variableId",
    "name",
    "severity",
    "group",
    "message",
    "value",
    "threshold",
    "status",
    "triggeredAt",
    "recoveredAt",
    "recoveredReason",
    "acknowledgedAt",
    "acknowledgedBy",
  ],
  properties: {
    id: { type: "string" },
    ruleId: { type: "string" },
    variableId: { type: "string" },
    name: { type: "string" },
    severity: { enum: [...severityEnum] },
    group: { type: "string" },
    message: { type: "string" },
    value: { type: ["number", "boolean"] },
    threshold: { type: "number" },
    status: { enum: [...statusEnum] },
    triggeredAt: { type: "number" },
    recoveredAt: { type: ["number", "null"] },
    recoveredReason: { type: "string" },
    acknowledgedAt: { type: ["number", "null"] },
    acknowledgedBy: { type: "string" },
  },
};

export const alarmStreamEventSchema: JsonSchema = {
  type: "object",
  required: [
    "id",
    "occurrenceId",
    "eventType",
    "atMs",
    "byUser",
    "value",
    "message",
  ],
  properties: {
    id: { type: "number" },
    occurrenceId: { type: "string" },
    eventType: { enum: [...eventTypeEnum] },
    atMs: { type: "number" },
    byUser: { type: "string" },
    value: { type: ["number", "boolean"] },
    message: { type: "string" },
  },
};

export const soeRecordSchema: JsonSchema = {
  type: "object",
  required: [
    "id",
    "seq",
    "variableId",
    "value",
    "quality",
    "deviceTime",
    "receiveTime",
    "source",
  ],
  properties: {
    id: { type: "number" },
    seq: { type: "number" },
    variableId: { type: "string" },
    value: { type: ["number", "boolean"] },
    quality: { enum: ["good", "bad", "uncertain"] },
    deviceTime: { type: "number" },
    receiveTime: { type: "number" },
    source: { type: "string" },
  },
};

/** 分页包装（Paged<T>）；items 由调用方传入条目 schema */
export function pagedSchema(itemsSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    required: ["total", "items"],
    properties: {
      total: { type: "number" },
      items: { type: "array", items: itemsSchema },
    },
  };
}
