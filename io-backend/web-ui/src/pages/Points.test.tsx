import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { renderWithApp } from "../test/renderWithApp";
import Points from "./Points";

vi.mock("../api/client", () => ({
  api: {
    listPlugins: vi.fn(),
    listPoints: vi.fn(),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    exportConfig: vi.fn(),
    exportExcelUrl: vi.fn(() => "/api/plugins/1/export"),
  },
  importExcel: vi.fn(),
}));

const mockApi = api as unknown as {
  listPlugins: ReturnType<typeof vi.fn>;
  listPoints: ReturnType<typeof vi.fn>;
  createPoint: ReturnType<typeof vi.fn>;
  updatePoint: ReturnType<typeof vi.fn>;
  deletePoint: ReturnType<typeof vi.fn>;
  exportConfig: ReturnType<typeof vi.fn>;
};

const PLUGIN = {
  id: 1,
  name: "modbus_tcp",
  wasm_file: "m.wasm",
  config_json: "{}",
  enabled: true,
  redundancy_group: "",
  redundancy_role: "primary",
  priority: 1,
};

const POINT = {
  id: 10,
  plugin_id: 1,
  variable_id: "STA1_211_IA",
  address: "holding_register:0",
  data_type: "uint16",
  byte_order: "big_endian",
  scale: 1,
  offset_val: 0,
  var_type: "AI",
  description: "主变电流",
  plugin_name: "modbus_tcp",
  hmi_id: "STA1_211_IA",
  redundancy_group: "",
  redundancy_role: "",
};

function renderPage() {
  return renderWithApp(<Points />);
}

describe("Points 页面", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listPlugins.mockResolvedValue([PLUGIN]);
  });

  it("选择插件后加载点位并渲染", async () => {
    mockApi.listPoints.mockResolvedValue([POINT]);
    renderPage();

    // 选择插件
    await userEvent.click(await screen.findByRole("combobox"));
    await userEvent.click(await screen.findByText("modbus_tcp"));

    expect(await screen.findByText("STA1_211_IA")).toBeInTheDocument();
    expect(screen.getByText("主变电流")).toBeInTheDocument();
    expect(mockApi.listPoints).toHaveBeenCalledWith(1, false);
  });

  it("点位加载失败提示错误", async () => {
    mockApi.listPoints.mockRejectedValue(new Error("后端不可用"));
    renderPage();

    await userEvent.click(await screen.findByRole("combobox"));
    await userEvent.click(await screen.findByText("modbus_tcp"));

    expect(
      await screen.findByText("加载点位失败: 后端不可用")
    ).toBeInTheDocument();
  });

  it("保存失败提示错误且弹窗保持打开", async () => {
    mockApi.listPoints.mockResolvedValue([]);
    mockApi.createPoint.mockRejectedValue(new Error("地址重复"));
    renderPage();

    await userEvent.click(await screen.findByRole("combobox"));
    await userEvent.click(await screen.findByText("modbus_tcp"));
    await userEvent.click(
      await screen.findByRole("button", { name: /添加点位/ })
    );

    await userEvent.type(await screen.findByLabelText("变量 ID"), "DUP_IA");
    await userEvent.type(screen.getByLabelText("协议地址"), "coil:1");
    await userEvent.click(screen.getByRole("button", { name: /保\s*存/ }));

    expect(await screen.findByText("保存失败: 地址重复")).toBeInTheDocument();
    expect(mockApi.createPoint).toHaveBeenCalledWith(
      expect.objectContaining({ variable_id: "DUP_IA", plugin_id: 1 })
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("删除失败提示错误", async () => {
    mockApi.listPoints.mockResolvedValue([POINT]);
    renderPage();

    await userEvent.click(await screen.findByRole("combobox"));
    await userEvent.click(await screen.findByText("modbus_tcp"));
    const row = (await screen.findByText("STA1_211_IA")).closest("tr")!;
    mockApi.deletePoint.mockRejectedValue(new Error("删除失败"));

    // 行内删除按钮（仅图标，无文字）
    const delBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      b.classList.contains("ant-btn-dangerous")
    )!;
    await userEvent.click(delBtn);
    await userEvent.click(await screen.findByText("确 定"));

    expect(await screen.findByText("删除失败: 删除失败")).toBeInTheDocument();
    expect(mockApi.deletePoint).toHaveBeenCalledWith(10);
  });
});
