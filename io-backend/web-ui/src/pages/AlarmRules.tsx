import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api/client";
import type {
  AlarmCondition,
  AlarmRule,
  AlarmRuleUpsert,
  AlarmSeverity,
} from "../api/types";

const CONDITION_LABEL: Record<AlarmCondition, string> = {
  high: "高于阈值",
  low: "低于阈值",
  equal: "等于阈值",
  notEqual: "不等于阈值",
  change: "变位（瞬时）",
};

const SEV: Record<AlarmSeverity, { color: string; label: string }> = {
  critical: { color: "red", label: "紧急" },
  major: { color: "orange", label: "严重" },
  minor: { color: "gold", label: "一般" },
  warning: { color: "blue", label: "预警" },
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
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AlarmRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [points, setPoints] = useState<{ value: string; label: string }[]>([]);
  const [form] = Form.useForm<AlarmRuleUpsert>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await api.listAlarmRules());
    } catch (e: any) {
      message.error("加载规则失败: " + (e?.message ?? "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    api
      .listAllPoints(true)
      .then((pts) => {
        const items = pts
          .filter((p) => p.hmi_id)
          .map((p) => ({ value: p.hmi_id!, label: p.hmi_id! }));
        setPoints(items);
      })
      .catch(() => setPoints([]));
  }, [refresh]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue(emptyUpsert);
    setOpen(true);
  };

  const openEdit = (rule: AlarmRule) => {
    setEditing(rule);
    form.setFieldsValue({
      variableId: rule.variableId,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      group: rule.group,
      condition: rule.condition,
      threshold: rule.threshold,
      enabled: rule.enabled,
      hysteresis: rule.hysteresis,
      confirmMs: rule.confirmMs,
    });
    setOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.updateAlarmRule(editing.id, values);
        message.success("规则已更新");
      } else {
        await api.createAlarmRule(values);
        message.success("规则已创建");
      }
      setOpen(false);
      refresh();
    } catch (e: any) {
      message.error("保存失败: " + (e?.message ?? "未知错误"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteAlarmRule(id);
      message.success("规则已删除");
      refresh();
    } catch (e: any) {
      message.error("删除失败: " + (e?.message ?? "未知错误"));
    }
  };

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
      refresh();
    } catch (e: any) {
      message.error("操作失败: " + (e?.message ?? "未知错误"));
      refresh();
    }
  };

  const columns: ColumnsType<AlarmRule> = [
    {
      title: "级别",
      dataIndex: "severity",
      width: 76,
      render: (v: AlarmSeverity) => (
        <Tag color={SEV[v]?.color}>{SEV[v]?.label}</Tag>
      ),
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
    { title: "确认时间", dataIndex: "confirmMs", width: 100, render: (v: number) => (v > 0 ? `${v}ms` : "-") },
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
          <Button size="small" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除规则「${r.name}」？`}
            onConfirm={() => handleDelete(r.id)}
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
        <Button type="primary" onClick={openCreate}>
          + 新建规则
        </Button>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rules}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />

      <Modal
        title={editing ? "编辑报警规则" : "新建报警规则"}
        open={open}
        onOk={handleSave}
        onCancel={() => setOpen(false)}
        confirmLoading={saving}
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
              <Select
                options={[
                  { value: "critical", label: "紧急" },
                  { value: "major", label: "严重" },
                  { value: "minor", label: "一般" },
                  { value: "warning", label: "预警" },
                ]}
              />
            </Form.Item>
            <Form.Item name="group" label="分组" style={{ width: 180 }}>
              <Input placeholder="如 供电/400V" />
            </Form.Item>
          </Space>
          <Space size="large" style={{ display: "flex" }} wrap>
            <Form.Item name="condition" label="条件" style={{ width: 180 }}>
              <Select
                options={Object.entries(CONDITION_LABEL).map(([value, label]) => ({
                  value,
                  label,
                }))}
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
