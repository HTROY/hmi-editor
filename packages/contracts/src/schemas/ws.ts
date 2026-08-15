// ============================================================
// WebSocket 协议的 JSON Schema（与 ws.ts 类型一一对应）
// 契约测试用：客户端消息与服务端信封都按此校验，防止前后端漂移。
// ============================================================

import type { JsonSchema } from "../schema";
import {
  alarmOccurrenceSchema,
  alarmRuleSchema,
  soeRecordSchema,
} from "./alarm";

const pointValueSchema: JsonSchema = {
  type: "object",
  required: ["id", "value", "quality", "timestamp"],
  properties: {
    id: { type: "string" },
    value: { type: ["number", "boolean", "string", "null"] },
    quality: { type: "string" },
    timestamp: { type: "number" },
  },
};

const dataEnvelope = (type: "snapshot" | "data"): JsonSchema => ({
  type: "object",
  required: ["type", "data"],
  properties: {
    type: { const: type },
    data: { type: "array", items: { $ref: "#/definitions/pointValue" } },
  },
});

/** 客户端 → 服务端消息（对应 ws.rs ClientCommand） */
export const wsClientMessageSchema: JsonSchema = {
  anyOf: [
    {
      type: "object",
      required: ["command", "variableId", "value"],
      properties: {
        command: { const: "control" },
        variableId: { type: "string" },
        value: { type: ["number", "boolean"] },
      },
    },
    {
      type: "object",
      required: ["command", "variableIds"],
      properties: {
        command: { const: "subscribe" },
        variableIds: { type: "array", items: { type: "string" } },
      },
    },
    {
      type: "object",
      required: ["command"],
      properties: { command: { const: "heartbeat" } },
    },
  ],
};

/** 服务端 → 客户端信封（{type, ...} 判别联合） */
export const wsServerEnvelopeSchema: JsonSchema = {
  definitions: {
    pointValue: pointValueSchema,
    alarmRule: alarmRuleSchema,
    alarmOccurrence: alarmOccurrenceSchema,
    soeRecord: soeRecordSchema,
  },
  anyOf: [
    dataEnvelope("snapshot"),
    dataEnvelope("data"),
    {
      type: "object",
      required: ["type", "action", "variable_id", "plugin_id"],
      properties: {
        type: { const: "config_change" },
        action: { type: "string" },
        variable_id: { type: "string" },
        plugin_id: { type: "number" },
      },
    },
    {
      type: "object",
      required: ["type", "state"],
      properties: {
        type: { const: "role" },
        state: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "data"],
      properties: {
        type: { const: "alarm_update" },
        data: {
          type: "object",
          required: ["event_type", "occurrence"],
          properties: {
            event_type: {
              enum: ["trigger", "ack", "recover", "rule_disabled"],
            },
            occurrence: { $ref: "#/definitions/alarmOccurrence" },
          },
        },
      },
    },
    {
      type: "object",
      required: ["type", "data"],
      properties: {
        type: { const: "soe" },
        data: { type: "array", items: { $ref: "#/definitions/soeRecord" } },
      },
    },
    {
      type: "object",
      required: ["type", "data"],
      properties: {
        type: { const: "alarm_snapshot" },
        data: {
          type: "array",
          items: { $ref: "#/definitions/alarmOccurrence" },
        },
      },
    },
    {
      type: "object",
      required: ["type", "data"],
      properties: {
        type: { const: "alarm_rules" },
        data: { type: "array", items: { $ref: "#/definitions/alarmRule" } },
      },
    },
    {
      type: "object",
      required: ["type"],
      properties: { type: { const: "alarm_rules_changed" } },
    },
  ],
};
