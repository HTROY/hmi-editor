import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketClient } from "./WebSocketClient";

/**
 * 契约测试：客户端发出的消息必须与服务端 `ClientCommand` 解析器
 * （io-backend/crates/server/src/ws.rs）期望的扁平结构一致。
 */

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
}

describe("WebSocketClient 扁平 WS 协议", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("sendControl 发送扁平 control 消息（数值）", async () => {
    const { client, fake } = await connectedClient();
    client.sendControl("modbus_1:STA1_TEMP", 12.5);
    expect(fake.sent).toEqual([
      '{"command":"control","variableId":"modbus_1:STA1_TEMP","value":12.5}',
    ]);
  });

  it("sendControl 保留布尔值（DO 写点，后端不再静默转 0）", async () => {
    const { client, fake } = await connectedClient();
    client.sendControl("pump:DO1", true);
    client.sendControl("pump:DO1", false);
    expect(fake.sent).toEqual([
      '{"command":"control","variableId":"pump:DO1","value":true}',
      '{"command":"control","variableId":"pump:DO1","value":false}',
    ]);
  });

  it("subscribeVariable 发送 variableIds 数组而非嵌套包络", async () => {
    const { client, fake } = await connectedClient();
    client.subscribeVariable("a:b");
    expect(fake.sent).toEqual(['{"command":"subscribe","variableIds":["a:b"]}']);
  });

  it("subscribeVariables 批量订阅与空数组清空过滤", async () => {
    const { client, fake } = await connectedClient();
    client.subscribeVariables(["a", "b"]);
    client.subscribeVariables([]);
    expect(fake.sent).toEqual([
      '{"command":"subscribe","variableIds":["a","b"]}',
      '{"command":"subscribe","variableIds":[]}',
    ]);
  });

  it("heartbeat 与扩展命令均为扁平结构", async () => {
    const { client, fake } = await connectedClient();
    client.send("heartbeat");
    client.send("something", { extra: 1 });
    expect(fake.sent).toEqual([
      '{"command":"heartbeat"}',
      '{"command":"something","extra":1}',
    ]);
  });

  it("未连接时发送不抛错", () => {
    const client = new WebSocketClient({ heartbeatInterval: 0 });
    expect(() => client.sendControl("x", 1)).not.toThrow();
  });
});
