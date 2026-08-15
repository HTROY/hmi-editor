import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { api, importExcel } from "../api/client";
import type { PluginRow, PluginStatus } from "../api/types";
import ConnectionBadge from "../components/ConnectionBadge";
import { useCrudTable } from "../hooks/useCrudTable";
import { useModalForm } from "../hooks/useModalForm";
import { usePolling } from "../hooks/usePolling";
import { errMsg } from "../utils/error";

interface PluginFormValues {
  name: string;
  wasm_file: string;
  config_json: string;
  enabled: boolean;
  redundancy_group: string;
  redundancy_role: string;
  priority: number;
}

const CREATE_DEFAULTS: Partial<PluginFormValues> = {
  enabled: true,
  config_json: "{}",
  redundancy_group: "",
  redundancy_role: "",
  priority: 0,
};

export default function Plugins() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PluginFormValues>();

  const table = useCrudTable<PluginRow>({
    fetcher: () => api.listPlugins(),
    errorPrefix: "加载失败",
  });

  const modal = useModalForm<PluginFormValues, PluginRow>({
    form,
    submit: async (values, editing) => {
      if (editing) {
        await api.updatePlugin(editing.id, values);
        message.success("更新成功");
      } else {
        await api.createPlugin(values);
        message.success("添加成功");
      }
      await table.load();
    },
  });

  const status = usePolling(
    () => api.monitorOverview().then((s) => s.plugins),
    2000,
    [],
  );
  const statusMap = new Map(
    (status.data ?? []).map((p: PluginStatus) => [p.name, p]),
  );

  const toggleEnabled = async (p: PluginRow, enabled: boolean) => {
    try {
      await api.updatePlugin(p.id, { ...p, enabled });
      message.success(enabled ? "已启用" : "已停用");
      await table.load();
    } catch (e) {
      message.error(`操作失败: ${errMsg(e)}`);
      await table.load();
    }
  };

  const onImport = async (file: File, pluginId: number) => {
    try {
      const r = await importExcel(pluginId, file);
      message.success(`导入成功，共 ${r.imported} 条`);
    } catch (e) {
      message.error(`导入失败: ${errMsg(e)}`);
    }
    return false;
  };

  const columns: ColumnsType<PluginRow> = [
    {
      title: "ID",
      dataIndex: "id",
      width: 60,
      render: (v: number) => (
        <span style={{ color: "inherit", opacity: 0.5 }}>{v}</span>
      ),
    },
    {
      title: "名称",
      dataIndex: "name",
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: "WASM 文件",
      dataIndex: "wasm_file",
      render: (v: string) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {v}
        </span>
      ),
    },
    {
      title: "运行状态",
      key: "status",
      width: 110,
      render: (_, p) => {
        const s = statusMap.get(p.name);
        return s ? (
          <ConnectionBadge state={s.connection_state} />
        ) : (
          <Tag>未加载</Tag>
        );
      },
    },
    {
      title: "启用",
      dataIndex: "enabled",
      width: 80,
      render: (enabled: boolean, p) => (
        <Switch
          checked={enabled}
          size="small"
          onChange={(v) => toggleEnabled(p, v)}
          checkedChildren="开"
          unCheckedChildren="关"
        />
      ),
    },
    {
      title: "冗余组",
      dataIndex: "redundancy_group",
      width: 110,
      render: (v: string) =>
        v ? (
          <Tag color="blue">{v}</Tag>
        ) : (
          <span style={{ opacity: 0.35 }}>-</span>
        ),
    },
    {
      title: "角色",
      dataIndex: "redundancy_role",
      width: 100,
      render: (v: string) =>
        v === "primary" ? (
          <Tag color="green">主</Tag>
        ) : v === "backup" ? (
          <Tag color="orange">备</Tag>
        ) : (
          <span style={{ opacity: 0.35 }}>-</span>
        ),
    },
    {
      title: "优先级",
      dataIndex: "priority",
      width: 80,
      render: (v: number) =>
        v > 0 ? (
          <span className="mono">{v}</span>
        ) : (
          <span style={{ opacity: 0.35 }}>-</span>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 330,
      render: (_, p) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() =>
              modal.openEdit(p, {
                name: p.name,
                wasm_file: p.wasm_file,
                config_json: p.config_json,
                enabled: p.enabled,
                redundancy_group: p.redundancy_group,
                redundancy_role: p.redundancy_role,
                priority: p.priority,
              })
            }
          >
            编辑
          </Button>
          <Upload
            accept=".xlsx,.xls"
            showUploadList={false}
            beforeUpload={(f) => onImport(f, p.id)}
          >
            <Button size="small" icon={<UploadOutlined />}>
              导入点位
            </Button>
          </Upload>
          <Tooltip title="导出点位 Excel">
            <Button
              size="small"
              icon={<DownloadOutlined />}
              href={api.exportExcelUrl(p.id)}
              target="_blank"
            >
              导出
            </Button>
          </Tooltip>
          <Popconfirm
            title="确定删除该插件？"
            description="其下所有点位配置将一并删除，此操作不可恢复。"
            onConfirm={() =>
              table.remove(() => api.deletePlugin(p.id), `已删除插件 ${p.name}`)
            }
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="协议插件"
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => modal.openCreate(CREATE_DEFAULTS)}
        >
          添加插件
        </Button>
      }
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={table.items}
        loading={table.loading}
        pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个插件` }}
        locale={{ emptyText: <Empty description="暂无插件，点击右上角添加" /> }}
      />

      <Modal
        title={modal.editing ? `编辑插件：${modal.editing.name}` : "添加插件"}
        open={modal.open}
        onOk={modal.save}
        onCancel={modal.close}
        confirmLoading={modal.saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入插件名称" }]}
          >
            <Input placeholder="例如 modbus_tcp" />
          </Form.Item>
          <Form.Item
            name="wasm_file"
            label="WASM 文件"
            rules={[{ required: true, message: "请输入 WASM 文件名" }]}
          >
            <Input placeholder="plugins 目录下的 .wasm 文件名，如 modbus_tcp.wasm" />
          </Form.Item>
          <Form.Item
            name="config_json"
            label="配置 JSON"
            rules={[
              {
                validator: (_, v: string) => {
                  if (!v) return Promise.resolve();
                  try {
                    JSON.parse(v);
                    return Promise.resolve();
                  } catch {
                    return Promise.reject(new Error("不是合法的 JSON"));
                  }
                },
              },
            ]}
          >
            <Input.TextArea
              rows={4}
              placeholder='{"host":"127.0.0.1","port":502}'
            />
          </Form.Item>
          <Form.Item name="enabled" label="启用">
            <Select
              options={[
                { value: true, label: "启用" },
                { value: false, label: "停用" },
              ]}
            />
          </Form.Item>
          <Form.Item name="redundancy_group" label="冗余组（可选）">
            <Input placeholder="如 mb-link" />
          </Form.Item>
          <Form.Item name="redundancy_role" label="组内角色">
            <Select
              options={[
                { value: "", label: "无" },
                { value: "primary", label: "主 primary" },
                { value: "backup", label: "备 backup" },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue("redundancy_role") === "backup" ? (
                <Form.Item
                  name="priority"
                  label="切换优先级（越小越先）"
                  rules={[{ required: true, message: "请输入优先级" }]}
                >
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
