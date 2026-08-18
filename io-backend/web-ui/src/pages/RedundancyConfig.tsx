import { useEffect, useState } from "react";
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
} from "antd";
import { api } from "../api/client";
import type {
  RedundancyConfig as RedundancyConfigT,
  RedundancyStatus,
} from "../api/types";

interface FormValues {
  enabled: boolean;
  node_id: string;
  role: "primary" | "backup";
  peer_url: string;
  peer_ws_port: number;
  heartbeat_interval_ms: number;
  failover_threshold: number;
  failback_delay_ms: number;
  full_snapshot_interval_ms: number;
  plugin_unhealthy_threshold: number;
  plugin_promotion_cooldown_ms: number;
  instance_failover_threshold: number;
  instance_failback_enabled: boolean;
  instance_failback_delay_ms: number;
  instance_switch_cooldown_ms: number;
}

export default function RedundancyConfig() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<RedundancyStatus | null>(null);
  const [cfg, setCfg] = useState<RedundancyConfigT | null>(null);

  useEffect(() => {
    api.getRedundancyConfig().then((c) => {
      setCfg(c);
      form.setFieldsValue({
        enabled: c.enabled,
        node_id: c.node_id,
        role: c.role,
        peer_url: c.peer_url,
        peer_ws_port: c.peer_ws_port,
        heartbeat_interval_ms: c.heartbeat_interval_ms,
        failover_threshold: c.failover_threshold,
        failback_delay_ms: c.failback_delay_ms,
        full_snapshot_interval_ms: c.full_snapshot_interval_ms,
        plugin_unhealthy_threshold: c.plugin_unhealthy_threshold,
        plugin_promotion_cooldown_ms: c.plugin_promotion_cooldown_ms,
        instance_failover_threshold: c.instance_failover_threshold,
        instance_failback_enabled: c.instance_failback_enabled,
        instance_failback_delay_ms: c.instance_failback_delay_ms,
        instance_switch_cooldown_ms: c.instance_switch_cooldown_ms,
      });
    });
    const t = window.setInterval(() => {
      api
        .getRedundancyStatus()
        .then(setStatus)
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(t);
  }, [form]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.saveRedundancyConfig(v);
      message.success("冗余配置已保存");
      setCfg(v);
    } catch (e) {
      message.error(`保存失败: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card size="small" title="本机冗余状态">
        <Space wrap size="middle">
          <span>
            节点: <Tag>{status?.node_id ?? "-"}</Tag>
          </span>
          <span>
            角色:{" "}
            <Tag color={status?.role === "primary" ? "blue" : "purple"}>
              {status?.role ?? "-"}
            </Tag>
          </span>
          <span>
            运行态:{" "}
            <Tag color={status?.state === "active" ? "green" : "default"}>
              {status?.state ?? "-"}
            </Tag>
          </span>
          <span>
            配置版本: <Tag>{status?.config_version ?? "-"}</Tag>
          </span>
          <span>
            对端:{" "}
            <Tag color={status?.peer.reachable ? "green" : "red"}>
              {status?.peer.reachable ? "可达" : "不可达"}
            </Tag>
          </span>
        </Space>
        {status?.split_brain && (
          <Alert
            style={{ marginTop: 10 }}
            type="error"
            showIcon
            message="检测到双主分裂（split-brain），请检查网络并处理"
          />
        )}
        {!status?.enabled && cfg && (
          <Alert
            style={{ marginTop: 10 }}
            type="warning"
            showIcon
            message="冗余未启用，当前为单机模式"
          />
        )}
      </Card>

      <Card size="small" title="冗余配置">
        <Form form={form} layout="vertical" style={{ maxWidth: 720 }}>
          <Form.Item
            name="enabled"
            label="启用主备冗余"
            valuePropName="checked"
          >
            <Switch checkedChildren="开" unCheckedChildren="关" />
          </Form.Item>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item
              name="node_id"
              label="节点 ID"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "请输入节点 ID" }]}
            >
              <Input placeholder="如 node-a" />
            </Form.Item>
            <Form.Item name="role" label="静态角色" style={{ flex: 1 }}>
              <Select
                options={[
                  { value: "primary", label: "主机 primary" },
                  { value: "backup", label: "备机 backup" },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item
            name="peer_url"
            label="对端地址"
            rules={[{ required: true, message: "请输入对端 web 地址" }]}
          >
            <Input placeholder="http://192.168.1.2:8081" />
          </Form.Item>
          <Form.Item name="peer_ws_port" label="对端 WS 端口">
            <InputNumber style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item
              name="heartbeat_interval_ms"
              label="心跳间隔 (ms)"
              style={{ flex: 1 }}
            >
              <InputNumber style={{ width: "100%" }} min={200} step={100} />
            </Form.Item>
            <Form.Item
              name="failover_threshold"
              label="失联阈值 (次)"
              style={{ flex: 1 }}
            >
              <InputNumber style={{ width: "100%" }} min={1} max={20} />
            </Form.Item>
            <Form.Item
              name="failback_delay_ms"
              label="回切稳定期 (ms)"
              style={{ flex: 1 }}
            >
              <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
            </Form.Item>
          </Space>
          <Form.Item name="full_snapshot_interval_ms" label="全量快照间隔 (ms)">
            <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
          </Form.Item>
          <Form.Item
            name="plugin_unhealthy_threshold"
            label="采集不健康升主阈值（次）"
          >
            <InputNumber style={{ width: "100%" }} min={1} max={20} />
          </Form.Item>
          <Form.Item
            name="plugin_promotion_cooldown_ms"
            label="健康触发升主冷却 (ms)"
          >
            <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
          </Form.Item>
          <Form.Item
            name="instance_failover_threshold"
            label="实例切换阈值（连续失败）"
          >
            <InputNumber style={{ width: "100%" }} min={1} max={20} />
          </Form.Item>
          <Form.Item
            name="instance_failback_enabled"
            label="实例自动回切"
            valuePropName="checked"
          >
            <Switch checkedChildren="开" unCheckedChildren="关" />
          </Form.Item>
          <Form.Item
            name="instance_failback_delay_ms"
            label="实例回切探测间隔 (ms)"
          >
            <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
          </Form.Item>
          <Form.Item
            name="instance_switch_cooldown_ms"
            label="实例切换冷却 (ms)"
          >
            <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
          </Form.Item>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Form>
      </Card>
    </div>
  );
}
