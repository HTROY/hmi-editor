import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { renderWithApp } from "../test/renderWithApp";
import Plugins from "./Plugins";

vi.mock("../api/client", () => ({
  api: {
    listPlugins: vi.fn(),
    createPlugin: vi.fn(),
    updatePlugin: vi.fn(),
    deletePlugin: vi.fn(),
    monitorOverview: vi.fn(),
    exportExcelUrl: vi.fn(() => "/api/plugins/1/export"),
  },
  importExcel: vi.fn(),
}));

const mockApi = api as unknown as {
  listPlugins: ReturnType<typeof vi.fn>;
  createPlugin: ReturnType<typeof vi.fn>;
  updatePlugin: ReturnType<typeof vi.fn>;
  deletePlugin: ReturnType<typeof vi.fn>;
  monitorOverview: ReturnType<typeof vi.fn>;
};

function renderPage() {
  return renderWithApp(<Plugins />);
}

const PLUGIN = {
  id: 1,
  name: "modbus_tcp",
  wasm_file: "modbus_tcp.wasm",
  config_json: "{}",
  enabled: true,
  redundancy_group: "mb-link",
  redundancy_role: "primary",
  priority: 1,
};

describe("Plugins 页面", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.monitorOverview.mockResolvedValue({ plugins: [] });
  });

  it("加载成功后渲染插件行", async () => {
    mockApi.listPlugins.mockResolvedValue([PLUGIN]);
    renderPage();

    expect(await screen.findByText("modbus_tcp")).toBeInTheDocument();
    expect(screen.getByText("modbus_tcp.wasm")).toBeInTheDocument();
    expect(mockApi.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("加载失败提示错误信息", async () => {
    mockApi.listPlugins.mockRejectedValue(new Error("连接被拒绝"));
    renderPage();

    expect(await screen.findByText("加载失败: 连接被拒绝")).toBeInTheDocument();
  });

  it("保存失败提示错误且弹窗不关闭", async () => {
    mockApi.listPlugins.mockResolvedValue([]);
    mockApi.createPlugin.mockRejectedValue(new Error("名称已存在"));
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /添加插件/ }));
    await userEvent.type(await screen.findByLabelText("名称"), "dup_plugin");
    await userEvent.type(screen.getByLabelText("WASM 文件"), "dup_plugin.wasm");
    await userEvent.click(screen.getByRole("button", { name: /保\s*存/ }));

    expect(await screen.findByText("保存失败: 名称已存在")).toBeInTheDocument();
    // 弹窗保持打开
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockApi.createPlugin).toHaveBeenCalledTimes(1);
  });

  it("创建成功关闭弹窗并刷新列表", async () => {
    mockApi.listPlugins
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ ...PLUGIN, name: "new_plugin" }]);
    mockApi.createPlugin.mockResolvedValue({ id: 2 });
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /添加插件/ }));
    await userEvent.type(await screen.findByLabelText("名称"), "new_plugin");
    await userEvent.type(screen.getByLabelText("WASM 文件"), "new_plugin.wasm");
    await userEvent.click(screen.getByRole("button", { name: /保\s*存/ }));

    expect(
      await screen.findByText("new_plugin", undefined, { timeout: 3000 })
    ).toBeInTheDocument();
    expect(mockApi.listPlugins).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("删除失败提示错误", async () => {
    mockApi.listPlugins.mockResolvedValue([PLUGIN]);
    mockApi.deletePlugin.mockRejectedValue(new Error("外键约束"));
    renderPage();

    await userEvent.click(await screen.findByText("删除"));
    await userEvent.click(await screen.findByText("确 定"));

    expect(await screen.findByText("删除失败: 外键约束")).toBeInTheDocument();
    expect(mockApi.deletePlugin).toHaveBeenCalledWith(1);
  });
});
