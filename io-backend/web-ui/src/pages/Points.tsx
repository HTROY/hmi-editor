import { useEffect, useMemo, useState } from "react";
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
  FileTextOutlined,
  PlusOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { api, importExcel } from "../api/client";
import type { PluginRow, PointRow } from "../api/types";
import { useCrudTable } from "../hooks/useCrudTable";
import { useDownload } from "../hooks/useDownload";
import { useModalForm } from "../hooks/useModalForm";
import { errMsg } from "../utils/error";

const DATA_TYPES = ["bool", "int16", "uint16", "int32", "uint32", "float32"];
const BYTE_ORDERS = [
  "ABCD",
  "BADC",
  "CDAB",
  "DCBA",
  "big_endian",
  "little_endian",
];
const VAR_TYPES = ["AI", "DI", "AO", "DO"];

interface PointFormValues {
  variable_id: string;
  address: string;
  data_type: string;
  byte_order: string;
  scale: number;
  offset_val: number;
  var_type: string;
  description?: string;
}

const CREATE_DEFAULTS: Partial<PointFormValues> = {
  data_type: "uint16",
  byte_order: "big_endian",
  scale: 1,
  offset_val: 0,
  var_type: "AI",
};

export default function Points() {
  const { message } = AntdApp.useApp();
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [pluginId, setPluginId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [includeBackup, setIncludeBackup] = useState(false);
  const [form] = Form.useForm<PointFormValues>();
  const download = useDownload();

  useEffect(() => {
    api
      .listPlugins()
      .then(setPlugins)
      .catch(() => setPlugins([]));
  }, []);

  const table = useCrudTable<PointRow>({
    fetcher: () =>
      pluginId === null
        ? Promise.resolve([])
        : api.listPoints(pluginId, includeBackup),
    errorPrefix: "加载点位失败",
    clearOnError: true,
  });

  useEffect(() => {
    if (pluginId !== null) table.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, includeBackup]);

  const modal = useModalForm<PointFormValues, PointRow>({
    form,
    submit: async (v, editing) => {
      if (pluginId === null) return;
      const payload = { ...v, plugin_id: pluginId };
      if (editing) {
        await api.updatePoint(editing.id, payload);
        message.success("更新成功");
      } else {
        await api.createPoint(payload);
        message.success("添加成功");
      }
      await table.load();
    },
  });

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return table.items;
    return table.items.filter(
      (p) =>
        p.variable_id.toLowerCase().includes(kw) ||
        p.address.toLowerCase().includes(kw) ||
        p.description.toLowerCase().includes(kw)
    );
  }, [table.items, keyword]);

  const onImport = async (file: File) => {
    if (pluginId === null) return false;
    try {
      const r = await importExcel(pluginId, file);
      message.success(`导入成功，共 ${r.imported} 条`);
      await table.load();
    } catch (e) {
      message.error(`导入失败: ${errMsg(e)}`);
    }
    return false;
  };

  const exportConfig = async () => {
    try {
      const cfg = await api.exportConfig();
      download(JSON.stringify(cfg, null, 2), "hmi-config-export.json");
      message.success("配置已导出");
    } catch (e) {
      message.error(`导出失败: ${errMsg(e)}`);
    }
  };

  const columns: ColumnsType<PointRow> = [
    {
      title: "变量 ID",
      dataIndex: "variable_id",
      render: (v: string) => (
        <Typography.Text strong className="mono" style={{ fontSize: 12 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: "协议地址",
      dataIndex: "address",
      render: (v: string) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {v}
        </span>
      ),
    },
    {
      title: "数据类型",
      dataIndex: "data_type",
      render: (v: string) => <Tag className="mono">{v}</Tag>,
    },
    {
      title: "字节序",
      dataIndex: "byte_order",
      render: (v: string) => <span className="mono">{v}</span>,
    },
    {
      title: "缩放",
      dataIndex: "scale",
      width: 70,
      align: "right",
      render: (v: number) => <span className="mono">{v}</span>,
    },
    {
      title: "偏移",
      dataIndex: "offset_val",
      width: 70,
      align: "right",
      render: (v: number) => <span className="mono">{v}</span>,
    },
    {
      title: "变量类型",
      dataIndex: "var_type",
      width: 90,
      render: (v: string) => (
        <Tag
          color={
            v === "AI"
              ? "blue"
              : v === "DI"
                ? "cyan"
                : v === "AO"
                  ? "purple"
                  : "magenta"
          }
        >
          {v}
        </Tag>
      ),
    },
    {
      title: "冗余",
      key: "redundancy",
      width: 130,
      render: (_, pt) => (
        <Space size={4}>
          {pt.redundancy_role === "primary" && <Tag color="green">主</Tag>}
          {pt.redundancy_role === "backup" && <Tag color="orange">备</Tag>}
          {pt.redundancy_group && (
            <Tag color="blue" className="mono">
              {pt.redundancy_group}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: "描述",
      dataIndex: "description",
      ellipsis: { showTitle: true },
      render: (v: string) => v || <span style={{ opacity: 0.35 }}>-</span>,
    },
    {
      title: "操作",
      key: "actions",
      width: 130,
      render: (_, pt) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() =>
              modal.openEdit(pt, {
                variable_id: pt.variable_id,
                address: pt.address,
                data_type: pt.data_type,
                byte_order: pt.byte_order,
                scale: pt.scale,
                offset_val: pt.offset_val,
                var_type: pt.var_type,
                description: pt.description,
              })
            }
          >
            编辑
          </Button>
          <Popconfirm
            title="确定删除该点位？"
            description={`${pt.variable_id} 将从配置中移除。`}
            onConfirm={() =>
              table.remove(
                () => api.deletePoint(pt.id),
                `已删除点位 ${pt.variable_id}`
              )
            }
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card size="small">
        <Space wrap>
          <Select
            style={{ width: 240 }}
            placeholder="选择协议插件"
            value={pluginId}
            onChange={setPluginId}
            options={plugins.map((p) => ({ value: p.id, label: p.name }))}
            showSearch
            optionFilterProp="label"
            allowClear
          />
          <Input
            prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
            placeholder="搜索变量 ID / 地址 / 描述"
            style={{ width: 280 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            disabled={pluginId === null}
          />
          <Switch
            checked={includeBackup}
            onChange={setIncludeBackup}
            checkedChildren="含备实例"
            unCheckedChildren="仅主实例"
            disabled={pluginId === null}
          />
          <Tooltip title="按模板（variable_id, address, data_type, byte_order, scale, offset, var_type, description）导入点位">
            <Upload
              accept=".xlsx,.xls"
              showUploadList={false}
              beforeUpload={onImport}
              disabled={pluginId === null}
            >
              <Button icon={<UploadOutlined />} disabled={pluginId === null}>
                导入 Excel
              </Button>
            </Upload>
          </Tooltip>
          <Tooltip title="导出当前插件全部点位为 Excel">
            <Button
              icon={<DownloadOutlined />}
              disabled={pluginId === null}
              href={
                pluginId !== null ? api.exportExcelUrl(pluginId) : undefined
              }
              target="_blank"
            >
              导出 Excel
            </Button>
          </Tooltip>
          <Tooltip title="导出全部启用插件的完整配置（JSON）">
            <Button icon={<FileTextOutlined />} onClick={exportConfig}>
              导出配置
            </Button>
          </Tooltip>
        </Space>
      </Card>

      <Card
        size="small"
        title="点位配置"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={pluginId === null}
            onClick={() => modal.openCreate(CREATE_DEFAULTS)}
          >
            添加点位
          </Button>
        }
      >
        {pluginId === null ? (
          <Empty description="请先选择插件" style={{ padding: "40px 0" }} />
        ) : (
          <Table
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={filtered}
            loading={table.loading}
            pagination={{
              pageSize: 10,
              showTotal: (t) => `共 ${t} 个点位`,
              showSizeChanger: false,
            }}
            locale={{ emptyText: <Empty description="暂无点位" /> }}
          />
        )}
      </Card>

      <Modal
        title={
          modal.editing ? `编辑点位：${modal.editing.variable_id}` : "添加点位"
        }
        open={modal.open}
        onOk={modal.save}
        onCancel={modal.close}
        confirmLoading={modal.saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={620}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item
              name="variable_id"
              label="变量 ID"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "请输入变量 ID" }]}
            >
              <Input placeholder="如 STA1_211_IA" />
            </Form.Item>
            <Form.Item
              name="address"
              label="协议地址"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "请输入协议地址" }]}
            >
              <Input placeholder="如 holding_register:0 / coil:1 / 1003" />
            </Form.Item>
          </Space>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item name="data_type" label="数据类型" style={{ flex: 1 }}>
              <Select
                options={DATA_TYPES.map((t) => ({ value: t, label: t }))}
              />
            </Form.Item>
            <Form.Item name="byte_order" label="字节序" style={{ flex: 1 }}>
              <Select
                options={BYTE_ORDERS.map((t) => ({ value: t, label: t }))}
              />
            </Form.Item>
            <Form.Item name="var_type" label="变量类型" style={{ flex: 1 }}>
              <Select
                options={VAR_TYPES.map((t) => ({ value: t, label: t }))}
              />
            </Form.Item>
          </Space>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item name="scale" label="缩放系数" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} step={0.1} />
            </Form.Item>
            <Form.Item name="offset_val" label="偏移量" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} step={0.1} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="描述">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
