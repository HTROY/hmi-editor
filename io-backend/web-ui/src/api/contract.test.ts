import { describe, expect, it } from "vitest";
import {
  alarmOccurrenceSchema,
  alarmRuleSchema,
  isValidJson,
  pagedSchema,
  soeRecordSchema,
  wsServerEnvelopeSchema,
  type AlarmOccurrence,
  type AlarmRule,
  type PluginRow,
  type PointRow,
  type RedundancyStatus,
  type SoeRecord,
} from "@hmi/contracts";

/**
 * F13 契约快照测试：
 * 1. 类型夹具（satisfies）——REST DTO 与后端 serde 结构保持一致，
 *    字段名一旦漂移会在编译期失败；
 * 2. schema 校验——报警 DTO 与 WS 信封样例通过 JSON Schema 校验。
 */

const PLUGIN_FIXTURE = {
  id: 1,
  name: "modbus_tcp",
  wasm_file: "modbus_tcp.wasm",
  config_json: "{}",
  enabled: true,
  redundancy_group: "mb-link",
  // 全站统一字段名：后端 DB 行为 redundancy_role（不再有 plugin_role）
  redundancy_role: "primary",
  priority: 1,
} satisfies PluginRow;

const POINT_FIXTURE = {
  id: 1,
  plugin_id: 1,
  variable_id: "STA1_TEMP",
  address: "40001",
  data_type: "uint16",
  byte_order: "ABCD",
  scale: 1,
  offset_val: 0,
  var_type: "AI",
  description: "站厅温度",
  plugin_name: "modbus_tcp",
  hmi_id: "modbus_tcp:STA1_TEMP",
  redundancy_group: "",
  redundancy_role: "",
} satisfies PointRow;

const RULE_FIXTURE = {
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
} satisfies AlarmRule;

const OCCURRENCE_FIXTURE = {
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
} satisfies AlarmOccurrence;

const SOE_FIXTURE = {
  id: 1,
  seq: 2,
  variableId: "P1",
  value: true,
  quality: "good",
  deviceTime: 1,
  receiveTime: 2,
  source: "iec104",
} satisfies SoeRecord;

const REDUNDANCY_FIXTURE = {
  enabled: true,
  node_id: "node-a",
  role: "primary",
  state: "active",
  config_version: 3,
  uptime_ms: 1000,
  peer: {
    reachable: true,
    active: false,
    node_id: "node-b",
    config_version: 3,
    last_seen_ms: 100,
    rtt_ms: 5,
    rtt_avg_ms: 6,
  },
  sync: { last_sync_ms: 100, points_received: 10, points_pushed: 10 },
  events: [],
  rtt_history: [5, 6],
  synced_points: [],
  split_brain: false,
  failover_count: 0,
  heartbeat_failures: 0,
} satisfies RedundancyStatus;

describe("REST DTO 契约快照", () => {
  it("插件/点位/报警/SOE/冗余夹具与类型一致（编译期已由 satisfies 保证）", () => {
    // 运行期再走一遍，双保险
    expect(PLUGIN_FIXTURE.redundancy_role).toBe("primary");
    expect(POINT_FIXTURE.redundancy_role).toBe("");
    expect(RULE_FIXTURE.condition).toBe("high");
    expect(OCCURRENCE_FIXTURE.status).toBe("active");
    expect(SOE_FIXTURE.quality).toBe("good");
    expect(REDUNDANCY_FIXTURE.role).toBe("primary");
  });

  it("报警 DTO schema 校验通过", () => {
    expect(isValidJson(RULE_FIXTURE, alarmRuleSchema)).toBe(true);
    expect(isValidJson(OCCURRENCE_FIXTURE, alarmOccurrenceSchema)).toBe(true);
    expect(isValidJson(SOE_FIXTURE, soeRecordSchema)).toBe(true);
    expect(
      isValidJson(
        { total: 1, items: [RULE_FIXTURE] },
        pagedSchema(alarmRuleSchema)
      )
    ).toBe(true);
  });

  it("报警 DTO schema 拒绝字段漂移（缺 camelCase 必填字段）", () => {
    // 旧字段名 plugin_role 与后端不一致：契约类型中不应再出现该字段
    expect("plugin_role" in PLUGIN_FIXTURE).toBe(false);
    // 若后端把 variableId 改名为 variable_id，schema 校验立即失败
    const snakeCaseRule: Record<string, unknown> = {
      ...RULE_FIXTURE,
      variable_id: RULE_FIXTURE.variableId,
    };
    delete snakeCaseRule.variableId;
    expect(isValidJson(snakeCaseRule, alarmRuleSchema)).toBe(false);
  });

  it("WS 服务端信封样例通过 schema（编辑端共用契约）", () => {
    expect(
      isValidJson(
        {
          type: "data",
          data: [{ id: "p", value: 1, quality: "good", timestamp: 1 }],
        },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
    expect(
      isValidJson(
        { type: "alarm_rules", data: [RULE_FIXTURE] },
        wsServerEnvelopeSchema
      )
    ).toBe(true);
  });
});
