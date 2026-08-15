import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, importExcel } from "./client";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET 请求解析 JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 1 }]));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await api.listPlugins();
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins", {
      method: "GET",
      headers: {},
    });
  });

  it("POST 请求带 JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createPlugin({
      name: "mb",
      wasm_file: "mb.wasm",
      config_json: "{}",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "mb",
        wasm_file: "mb.wasm",
        config_json: "{}",
      }),
    });
  });

  it("非 2xx 抛出带状态码的 ApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => "text/plain" },
      text: async () => "db locked",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deletePlugin(3)).rejects.toMatchObject({
      message: "db locked",
      status: 500,
    });
  });

  it("查询参数过滤空值与 undefined", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ total: 0, items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.alarmHistory({ page: 2, severity: "", status: undefined });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/alarm/history?page=2",
      expect.anything()
    );
  });

  it("契约：points 响应使用 redundancy_role（与后端 PointView 一致）", async () => {
    const backendPayload = [
      {
        id: 1,
        plugin_id: 2,
        variable_id: "STA1_IA",
        address: "holding_register:0",
        data_type: "uint16",
        byte_order: "big_endian",
        scale: 1,
        offset_val: 0,
        var_type: "AI",
        description: "",
        plugin_name: "modbus_tcp",
        hmi_id: "grp:STA1_IA",
        redundancy_group: "grp",
        redundancy_role: "backup",
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(backendPayload));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await api.listPoints(2, true);
    expect(rows[0].redundancy_role).toBe("backup");
    expect(rows[0].redundancy_group).toBe("grp");
  });

  it("importExcel 走 FormData 上传", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imported: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["x"], "points.xlsx");
    const r = await importExcel(2, file);
    expect(r.imported).toBe(5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/plugins/2/import");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("ApiError 是 Error 子类", () => {
    const e = new ApiError("boom", 400);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(400);
  });
});
