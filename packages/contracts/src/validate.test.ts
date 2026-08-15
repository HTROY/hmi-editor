import { describe, expect, it } from "vitest";
import {
  alarmOccurrenceSchema,
  alarmRuleSchema,
  pagedSchema,
  soeRecordSchema,
  validateJson,
  wsClientMessageSchema,
  wsServerEnvelopeSchema,
  isValidJson,
} from "./index";

describe("JSON Schema 校验器基础能力", () => {
  it("校验类型 / required / 嵌套", () => {
    const schema = {
      type: "object",
      required: ["id", "tags"],
      properties: {
        id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        score: { type: "number" },
      },
    };
    expect(validateJson({ id: "a", tags: ["x"] }, schema)).toEqual([]);
    expect(validateJson({ id: "a" }, schema)).toContain(
      '$: 缺少必填字段 "tags"'
    );
    expect(validateJson({ id: 1, tags: [] }, schema)).toContain(
      "$.id: 类型不匹配，期望 string"
    );
    expect(validateJson({ id: "a", tags: [1] }, schema)).toContain(
      "$.tags[0]: 类型不匹配，期望 string"
    );
  });

  it("多类型 type 数组", () => {
    const schema = { type: ["number", "null"] };
    expect(validateJson(3, schema)).toEqual([]);
    expect(validateJson(null, schema)).toEqual([]);
    expect(validateJson("3", schema)).not.toEqual([]);
  });

  it("const / enum", () => {
    expect(validateJson("control", { const: "control" })).toEqual([]);
    expect(validateJson("other", { const: "control" })).not.toEqual([]);
    expect(validateJson("good", { enum: ["good", "bad"] })).toEqual([]);
    expect(validateJson("ok", { enum: ["good", "bad"] })).not.toEqual([]);
  });

  it("anyOf：任一分支通过即可", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "number", const: 42 }],
    };
    expect(validateJson("hi", schema)).toEqual([]);
    expect(validateJson(42, schema)).toEqual([]);
    expect(validateJson(43, schema)).not.toEqual([]);
  });

  it("$ref 解析本地 definitions", () => {
    const schema = {
      definitions: {
        inner: {
          type: "object",
          required: ["v"],
          properties: { v: { type: "number" } },
        },
      },
      type: "object",
      required: ["inner"],
      properties: { inner: { $ref: "#/definitions/inner" } },
    };
    expect(validateJson({ inner: { v: 1 } }, schema)).toEqual([]);
    expect(validateJson({ inner: { v: "x" } }, schema)).toContain(
      "$.inner.v: 类型不匹配，期望 number"
    );
  });

  it("未知字段宽松（不校验 additionalProperties）", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    };
    expect(validateJson({ a: "x", extra: 1 }, schema)).toEqual([]);
  });
});

describe("WS 客户端消息 schema", () => {
  it("接受扁平 control / subscribe / heartbeat", () => {
    expect(
      isValidJson(
        { command: "control", variableId: "a:b", value: 12.5 },
        wsClientMessageSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        { command: "control", variableId: "a:b", value: true },
        wsClientMessageSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        { command: "subscribe", variableIds: ["a"] },
        wsClientMessageSchema
      )
    ).toBe(true);
    expect(isValidJson({ command: "heartbeat" }, wsClientMessageSchema)).toBe(
      true
    );
  });

  it("拒绝嵌套包络与错误类型", () => {
    // 旧版 `{command, value:{variableId,value}}` 必须失败
    expect(
      isValidJson(
        { command: "control", value: { variableId: "a", value: 1 } },
        wsClientMessageSchema
      )
    ).toBe(false);
    expect(
      isValidJson(
        { command: "control", variableId: "a", value: "1" },
        wsClientMessageSchema
      )
    ).toBe(false);
    expect(
      isValidJson(
        { command: "subscribe", variableIds: "a" },
        wsClientMessageSchema
      )
    ).toBe(false);
    expect(isValidJson({ command: "nope" }, wsClientMessageSchema)).toBe(false);
  });
});

describe("WS 服务端信封 schema（与后端广播载荷对齐）", () => {
  const point = {
    id: "modbus_1:STA1",
    value: 12.5,
    quality: "good",
    timestamp: 1700000000000,
  };

  it("snapshot / data 载荷", () => {
    expect(
      isValidJson({ type: "snapshot", data: [point] }, wsServerEnvelopeSchema)
    ).toBe(true);
    expect(
      isValidJson({ type: "data", data: [point] }, wsServerEnvelopeSchema)
    ).toBe(true);
    expect(
      isValidJson(
        { type: "data", data: [{ ...point, value: true }] },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        { type: "data", data: [{ ...point, id: 1 }] },
        wsServerEnvelopeSchema
      )
    ).toBe(false);
  });

  it("config_change / role", () => {
    expect(
      isValidJson(
        {
          type: "config_change",
          action: "upsert",
          variable_id: "a",
          plugin_id: 3,
        },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        { type: "config_change", action: "upsert", variable_id: "a" },
        wsServerEnvelopeSchema
      )
    ).toBe(false);
    expect(
      isValidJson({ type: "role", state: "standby" }, wsServerEnvelopeSchema)
    ).toBe(true);
  });

  it("alarm_update / soe / alarm_snapshot / alarm_rules", () => {
    const occurrence = {
      id: "O1",
      ruleId: "R1",
      variableId: "P1",
      name: "高限",
      severity: "major",
      group: "G",
      message: "P1 超过 100",
      value: 120,
      threshold: 100,
      status: "active",
      triggeredAt: 1700000000000,
      recoveredAt: null,
      recoveredReason: "",
      acknowledgedAt: null,
      acknowledgedBy: "",
    };
    expect(
      isValidJson(
        { type: "alarm_update", data: { event_type: "trigger", occurrence } },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        { type: "alarm_update", data: { event_type: "TRIGGER", occurrence } },
        wsServerEnvelopeSchema
      )
    ).toBe(false);

    const soe = {
      id: 1,
      seq: 2,
      variableId: "P1",
      value: true,
      quality: "good",
      deviceTime: 1,
      receiveTime: 2,
      source: "iec104",
    };
    expect(
      isValidJson({ type: "soe", data: [soe] }, wsServerEnvelopeSchema)
    ).toBe(true);
    expect(
      isValidJson(
        { type: "soe", data: [{ ...soe, seq: "2" }] },
        wsServerEnvelopeSchema
      )
    ).toBe(false);

    expect(
      isValidJson(
        { type: "alarm_snapshot", data: [occurrence] },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        {
          type: "alarm_rules",
          data: [
            {
              id: "R1",
              variableId: "P1",
              name: "高限",
              description: "",
              severity: "major",
              group: "G",
              condition: "high",
              threshold: 100,
              enabled: true,
              hysteresis: 0,
              confirmMs: 0,
            },
          ],
        },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
    expect(
      isValidJson({ type: "alarm_rules_changed" }, wsServerEnvelopeSchema)
    ).toBe(true);
  });

  it("拒绝未知 type", () => {
    expect(
      isValidJson({ type: "mystery", data: [] }, wsServerEnvelopeSchema)
    ).toBe(false);
  });
});

describe("报警 REST DTO schema", () => {
  it("alarmRule / alarmOccurrence / soe 全字段样例", () => {
    const rule = {
      id: "R1",
      variableId: "P1",
      name: "高限",
      description: "",
      severity: "warning",
      group: "G",
      condition: "notEqual",
      threshold: 5,
      enabled: true,
      hysteresis: 1,
      confirmMs: 2000,
    };
    expect(validateJson(rule, alarmRuleSchema)).toEqual([]);
    expect(
      validateJson({ ...rule, severity: "fatal" }, alarmRuleSchema)
    ).not.toEqual([]);

    const occ = {
      id: "O1",
      ruleId: "R1",
      variableId: "P1",
      name: "高限",
      severity: "minor",
      group: "G",
      message: "",
      value: false,
      threshold: 5,
      status: "recovered",
      triggeredAt: 1,
      recoveredAt: 2,
      recoveredReason: "恢复",
      acknowledgedAt: null,
      acknowledgedBy: "op",
    };
    expect(validateJson(occ, alarmOccurrenceSchema)).toEqual([]);

    const soe = {
      id: 1,
      seq: 1,
      variableId: "P1",
      value: 1,
      quality: "good",
      deviceTime: 1,
      receiveTime: 2,
      source: "iec104",
    };
    expect(validateJson(soe, soeRecordSchema)).toEqual([]);

    const paged = { total: 1, items: [rule] };
    expect(validateJson(paged, pagedSchema(alarmRuleSchema))).toEqual([]);
    expect(
      validateJson(
        { total: 1, items: [{ ...rule, id: 1 }] },
        pagedSchema(alarmRuleSchema)
      )
    ).not.toEqual([]);
  });
});
