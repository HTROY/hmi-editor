import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isValidJson,
  parseWsEnvelope,
  wsClientMessageSchema,
  wsServerEnvelopeSchema,
  type PointValue,
  type WsServerEnvelope,
} from "@hmi/contracts";
import { WebSocketClient } from "./WebSocketClient";

/**
 * F13 契约测试：客户端发出/收到的消息必须符合 packages/contracts 中
 * 定义的 WS 协议 schema（与服务端 ws.rs ClientCommand / 广播载荷对齐）。
 */

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readonly sent: string[] = [];
  readyState = 1; // WebSocket.OPEN
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({ code: 1000, reason: "" });
  }

  /** 模拟服务端推送一帧 */
  push(json: unknown): void {
    this.onmessage?.({ data: JSON.stringify(json) });
  }
}

describe("WS 客户端消息契约（schema 校验）", () => {
  it("发出的 control/subscribe/heartbeat 均通过 wsClientMessageSchema", async () => {
    const { client, fake } = await connectedClient();
    client.sendControl("modbus_1:STA1_TEMP", 12.5);
    client.sendControl("pump:DO1", true);
    client.subscribeVariable("a:b");
    client.subscribeVariables(["a", "b"]);
    client.subscribeVariables([]);
    client.send("heartbeat");
    expect(fake.sent.length).toBe(6);
    for (const raw of fake.sent) {
      expect(isValidJson(JSON.parse(raw), wsClientMessageSchema)).toBe(true);
    }
  });

  it("解析器拒绝旧版嵌套包络", () => {
    expect(
      parseWsEnvelope({
        command: "control",
        value: { variableId: "a", value: 1 },
      })
    ).toBeNull();
  });
});

async function connectedClient(): Promise<{
  client: WebSocketClient;
  fake: FakeWebSocket;
}> {
  const client = new WebSocketClient({ heartbeatInterval: 0 });
  await client.connect();
  const fake = FakeWebSocket.instances[0];
  if (!fake) throw new Error("no WebSocket instance created");
  return { client, fake };
}

describe("WS 服务端信封契约（解析 + schema）", () => {
  const point: PointValue = {
    id: "modbus_1:STA1",
    value: 12.5,
    quality: "good",
    timestamp: 1700000000000,
  };

  function expectValidEnvelope(msg: WsServerEnvelope): void {
    expect(isValidJson(msg, wsServerEnvelopeSchema)).toBe(true);
    expect(parseWsEnvelope(msg)).toEqual(msg);
  }

  it("snapshot / data 帧解析为点数据", () => {
    expectValidEnvelope({ type: "snapshot", data: [point] });
    expectValidEnvelope({
      type: "data",
      data: [point, { ...point, value: true }],
    });
  });

  it("config_change / role / alarm_rules_changed 帧", () => {
    expectValidEnvelope({
      type: "config_change",
      action: "upsert",
      variable_id: "STA1",
      plugin_id: 3,
    });
    expectValidEnvelope({ type: "role", state: "standby" });
    expectValidEnvelope({ type: "alarm_rules_changed" });
  });

  it("alarm_update / alarm_snapshot / alarm_rules / soe 帧", () => {
    const occurrence = {
      id: "O1",
      ruleId: "R1",
      variableId: "P1",
      name: "高限",
      severity: "major" as const,
      group: "G",
      message: "P1 超过 100",
      value: 120,
      threshold: 100,
      status: "active" as const,
      triggeredAt: 1700000000000,
      recoveredAt: null,
      recoveredReason: "",
      acknowledgedAt: null,
      acknowledgedBy: "",
    };
    expectValidEnvelope({
      type: "alarm_update",
      data: { event_type: "trigger", occurrence },
    });
    expectValidEnvelope({ type: "alarm_snapshot", data: [occurrence] });
    expectValidEnvelope({
      type: "alarm_rules",
      data: [
        {
          id: "R1",
          variableId: "P1",
          name: "高限",
          description: "",
          severity: "warning",
          group: "G",
          condition: "high",
          threshold: 100,
          enabled: true,
          hysteresis: 0,
          confirmMs: 0,
        },
      ],
    });
    const soe = {
      id: 1,
      seq: 2,
      variableId: "P1",
      value: true,
      quality: "good" as const,
      deviceTime: 1,
      receiveTime: 2,
      source: "iec104",
    };
    expectValidEnvelope({ type: "soe", data: [soe] });
  });

  it("畸形帧被拒绝（字段缺失 / 未知 type / 类型错误）", () => {
    expect(parseWsEnvelope({ type: "data", data: [{}] })).toBeNull();
    expect(
      parseWsEnvelope({ type: "data", data: [{ ...point, id: 1 }] })
    ).toBeNull();
    expect(parseWsEnvelope({ type: "mystery", data: [] })).toBeNull();
    expect(parseWsEnvelope({ type: "config_change" })).toBeNull();
    expect(parseWsEnvelope(null)).toBeNull();
    expect(parseWsEnvelope("text")).toBeNull();
  });

  it("WebSocketClient 将服务端帧路由到 onData / onAlarmMessage", async () => {
    const { client, fake } = await connectedClient();
    const points: unknown[] = [];
    const alarms: string[] = [];
    client.subscribe({
      onData: (p) => points.push(p),
      onStatus: () => {},
      onError: () => {},
    });
    client.onAlarmMessage((msg) => alarms.push(msg.type));

    fake.push({ type: "snapshot", data: [point] });
    fake.push({ type: "data", data: [{ ...point, value: "12.0" }] });
    fake.push({ type: "alarm_rules_changed" });
    // 畸形帧应被忽略，不影响后续
    fake.push({ type: "data", data: [{ id: 1, value: 1 }] });
    fake.push({ type: "soe", data: [] });

    expect(points).toEqual([
      {
        id: "modbus_1:STA1",
        value: 12.5,
        quality: "good",
        timestamp: 1700000000000,
      },
      {
        id: "modbus_1:STA1",
        value: 12,
        quality: "good",
        timestamp: 1700000000000,
      },
    ]);
    expect(alarms).toEqual(["alarm_rules_changed", "soe"]);
  });
});
