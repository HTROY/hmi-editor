import { useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api/client";
import type {
  AlarmCondition,
  AlarmRule,
  AlarmRuleUpsert,
  AlarmSeverity,
} from "../api/types";
import SeverityTag, { SEVERITY_OPTIONS } from "../components/SeverityTag";
import { useCrudTable } from "../hooks/useCrudTable";
import { useModalForm } from "../hooks/useModalForm";
import { errMsg } from "../utils/error";

const CONDITION_LABEL: Record<AlarmCondition, string> = {
  high: "高于阈值",
  low: "低于阈值",
  equal: "等于阈值",
  notEqual: "不等于阈值",
  change: "变位（瞬时）",
};

const emptyUpsert: AlarmRuleUpsert = {
  variableId: "",
  name: "",
  description: "",
  severity: "warning",
  group: "",
  condition: "high",
  threshold: 0,
  enabled: true,
  hysteresis: 0,
  confirmMs: 0,
};

export default function AlarmRules() {
  const { message } = AntdApp.useApp();
  const [points, setPoints] = useState<{ value: string; label: string }[]>([]);
  const [form] = Form.useForm<AlarmRuleUpsert>();

  const table = useCrudTable<AlarmRule>({
    fetcher: () => api.listAlarmRules(),
    errorPrefix: "加载规则失败",
  });

  const modal = useModalForm<AlarmRuleUpsert, AlarmRule>({
    form,
    submit: async (values, editing) => {
      if (editing) {
        await api.updateAlarmRule(editing.id, values);
        message.success("规则已更新");
      } else {
        await api.createAlarmRule(values);
        message.success("规则已创建");
      }
      await table.load();
    },
  });

  useEffect(() => {
    api
      .listAllPoints(true)
      .then((pts) => {
        const items = pts
          .filter((p) => p.hmi_id)
          .map((p) => ({ value: p.hmi_id!, label: p.hmi_id! }));
        setPoints(items);
      })
      .catch(() => setPoints([]));
  }, []);

  const handleToggle = async (rule: AlarmRule, enabled: boolean) => {
    try {
      await api.updateAlarmRule(rule.id, {
        variableId: rule.variableId,
        name: rule.name,
        description: rule.description,
        severity: rule.severity,
        group: rule.group,
        condition: rule.condition,
        threshold: rule.threshold,
        enabled,
        hysteresis: rule.hysteresis,
        confirmMs: rule.confirmMs,
      });
      message.success(enabled ? "规则已启用" : "规则已停用");
      await table.load();
    } catch (e) {
      message.error(`操作失败: ${errMsg(e)}`);
      await table.load();
    }
  };

  const columns: ColumnsType<AlarmRule> = [
    {
      title: "级别",
      dataIndex: "severity",
      width: 76,
      render: (v: AlarmSeverity) => <SeverityTag severity={v} />,
    },
    { title: "ID", dataIndex: "id", width: 140 },
    { title: "名称", dataIndex: "name", width: 140 },
    { title: "变量", dataIndex: "variableId", width: 220 },
    {
      title: "条件",
      dataIndex: "condition",
      width: 110,
      render: (v: AlarmCondition) => CONDITION_LABEL[v] ?? v,
    },
    { title: "阈值", dataIndex: "threshold", width: 80 },
    { title: "滞回", dataIndex: "hysteresis", width: 70 },
    {
      title: "确认时间",
      dataIndex: "confirmMs",
      width: 100,
      render: (v: number) => (v > 0 ? `${v}ms` : "-"),
    },
    { title: "分组", dataIndex: "group", width: 130 },
    {
      title: "启用",
      dataIndex: "enabled",
      width: 70,
      render: (v: boolean, r) => (
        <Switch
          size="small"
          checked={v}
          onChange={(checked) => handleToggle(r, checked)}
        />
      ),
    },
    {
      title: "操作",
      key: "op",
      width: 130,
      render: (_v, r) => (
        <Space>
          <Button
            size="small"
            onClick={() =>
              modal.openEdit(r, {
                variableId: r.variableId,
                name: r.name,
                description: r.description,
                severity: r.severity,
                group: r.group,
                condition: r.condition,
                threshold: r.threshold,
                enabled: r.enabled,
                hysteresis: r.hysteresis,
                confirmMs: r.confirmMs,
              })
            }
          >
            编辑
          </Button>
          <Popconfirm
            title={`删除规则「${r.name}」？`}
            onConfirm={() =>
              table.remove(() => api.deleteAlarmRule(r.id), "规则已删除")
            }
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="报警规则"
      extra={
        <Button type="primary" onClick={() => modal.openCreate(emptyUpsert)}>
          + 新建规则
        </Button>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={table.loading}
        columns={columns}
        dataSource={table.items}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />

      <Modal
        title={modal.editing ? "编辑报警规则" : "新建报警规则"}
        open={modal.open}
        onOk={modal.save}
        onCancel={modal.close}
        confirmLoading={modal.saving}
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={emptyUpsert}>
          <Form.Item
            name="variableId"
            label="变量"
            rules={[{ required: true, message: "请选择变量" }]}
          >
            <Select
              showSearch
              placeholder="选择点位（hmi_id）"
              options={points}
              filterOption={(input, opt) =>
                (opt?.value ?? "").toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="如 A相过流" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="报警描述" />
          </Form.Item>
          <Space size="large" style={{ display: "flex" }} wrap>
            <Form.Item name="severity" label="级别" style={{ width: 140 }}>
              <Select options={SEVERITY_OPTIONS} />
            </Form.Item>
            <Form.Item name="group" label="分组" style={{ width: 180 }}>
              <Input placeholder="如 供电/400V" />
            </Form.Item>
          </Space>
          <Space size="large" style={{ display: "flex" }} wrap>
            <Form.Item name="condition" label="条件" style={{ width: 180 }}>
              <Select
                options={Object.entries(CONDITION_LABEL).map(
                  ([value, label]) => ({
                    value,
                    label,
                  })
                )}
              />
            </Form.Item>
            <Form.Item name="threshold" label="阈值" style={{ width: 140 }}>
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Space size="large" style={{ display: "flex" }} wrap>
            <Form.Item name="hysteresis" label="滞回" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="confirmMs"
              label="确认时间 (ms)"
              style={{ width: 180 }}
            >
              <InputNumber min={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
