import { useEffect, useMemo, useState } from "react";
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  ScanOutlined,
} from "@ant-design/icons";
import {
  Badge,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api/client";
import type { LivePointInfo, MonitorSnapshot, PluginStatus } from "../api/types";
import ConnectionBadge from "../components/ConnectionBadge";
import StatCard from "../components/StatCard";
import { usePolling } from "../hooks/usePolling";
import { formatAge, formatNumber, formatTime, formatTimeMs, formatUptime } from "../utils/format";

function fmtValue(v: LivePointInfo["value"]): { text: string; stale: boolean } {
  if (v === null || v === undefined) return { text: "--", stale: true };
  if (typeof v === "number") {
    return { text: Number.isInteger(v) ? String(v) : v.toFixed(3), stale: false };
  }
  if (typeof v === "boolean") return { text: v ? "1" : "0", stale: false };
  return { text: String(v), stale: false };
}

export default function Monitor() {
  const [selected, setSelected] = useState<string | null>(null);
  const [dirFilter, setDirFilter] = useState<string>("all");
  const [protoFilter, setProtoFilter] = useState<string>("all");

  const overview = usePolling(() => api.monitorOverview(), 1000);
  const snap: MonitorSnapshot | null = overview.data;

  useEffect(() => {
    if (!selected && snap && snap.plugins.length > 0) {
      setSelected(snap.plugins[0].name);
    }
  }, [snap, selected]);

  const points = usePolling(
    () => (selected ? api.monitorPluginPoints(selected) : Promise.resolve([])),
    1000,
    [selected],
  );
  const packets = usePolling(
    () => (selected ? api.monitorPluginPackets(selected, 200) : Promise.resolve([])),
    1000,
    [selected],
  );

  const plugin = useMemo(
    () => snap?.plugins.find((p) => p.name === selected) ?? null,
    [snap, selected],
  );

  const pointColumns: ColumnsType<LivePointInfo> = [
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
      title: "地址",
      dataIndex: "address",
      render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span>,
    },
    {
      title: "类型",
      dataIndex: "var_type",
      width: 70,
      render: (v: string) => (
        <Tag color={v === "AI" ? "blue" : v === "DI" ? "cyan" : v === "AO" ? "purple" : "magenta"}>{v}</Tag>
      ),
    },
    {
      title: "当前值",
      dataIndex: "value",
      width: 130,
      render: (v: LivePointInfo["value"], pt) => {
        const { text, stale } = fmtValue(v);
        return (
          <span
            className="mono"
            style={{
              color: stale ? "inherit" : pt.var_type === "AI" ? "#22c55e" : "#3b82f6",
              opacity: stale ? 0.4 : 1,
              fontWeight: 600,
            }}
          >
            {text}
          </span>
        );
      },
    },
    {
      title: "质量",
      dataIndex: "quality",
      width: 90,
      render: (q: string) =>
        q === "good" ? (
          <Badge status="success" text="good" />
        ) : q === "bad" ? (
          <Badge status="error" text="bad" />
        ) : (
          <Badge status="default" text={q || "unknown"} />
        ),
    },
    {
      title: "更新时间",
      dataIndex: "timestamp_ms",
      width: 110,
      render: (v: number) => (
        <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
          {formatTime(v)}
        </span>
      ),
    },
    {
      title: "数据延迟",
      dataIndex: "age_ms",
      width: 90,
      render: (v: number) => (
        <span
          className="mono"
          style={{ fontSize: 11, color: v > 5000 ? "#f59e0b" : "inherit" }}
        >
          {formatAge(v)}
        </span>
      ),
    },
    {
      title: "换算",
      key: "convert",
      width: 130,
      render: (_, pt) => (
        <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>
          {pt.data_type}/{pt.byte_order} ×{pt.scale}+{pt.offset_val}
        </span>
      ),
    },
  ];

  const filteredPackets = useMemo(
    () =>
      (packets.data ?? []).filter(
        (p) =>
          (dirFilter === "all" || p.direction === dirFilter) &&
          (protoFilter === "all" || p.protocol === protoFilter),
      ),
    [packets.data, dirFilter, protoFilter],
  );

  const protos = useMemo(
    () => [...new Set((packets.data ?? []).map((p) => p.protocol))],
    [packets.data],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="运行插件"
            value={snap?.plugins.length ?? "-"}
            icon={<CloudServerOutlined />}
            color="#3b82f6"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="总扫描"
            value={snap ? formatNumber(snap.total_scans) : "-"}
            icon={<ScanOutlined />}
            color="#22c55e"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="累计错误"
            value={snap ? formatNumber(snap.total_errors) : "-"}
            icon={<CloseCircleOutlined />}
            color={snap && snap.total_errors > 0 ? "#ef4444" : "#22c55e"}
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="点位总数"
            value={snap?.total_points ?? "-"}
            icon={<DatabaseOutlined />}
            color="#06b6d4"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="WS 客户端"
            value={snap?.active_ws_clients ?? "-"}
            icon={<ApiOutlined />}
            color="#a78bfa"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="服务器运行"
            value={snap ? formatUptime(snap.server_uptime_ms) : "-"}
            icon={<CheckCircleOutlined />}
            color="#f59e0b"
            loading={overview.loading && !snap}
          />
        </Col>
      </Row>

      <Card size="small" title="插件状态" extra={<Tag color="blue">1s 自动刷新</Tag>}>
        {!snap || snap.plugins.length === 0 ? (
          <Empty description="暂无运行中的插件" />
        ) : (
          <Row gutter={[10, 10]}>
            {snap.plugins.map((p) => (
              <Col xs={24} sm={12} lg={8} xl={6} key={p.name}>
                <PluginCard p={p} active={selected === p.name} onClick={() => setSelected(p.name)} />
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {selected && (
        <>
          <Card
            size="small"
            title={
              <Space>
                <span>实时点位值</span>
                <Tag color="blue">{selected}</Tag>
              </Space>
            }
            extra={
              plugin ? (
                <Space size="middle">
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    扫描 {formatNumber(plugin.scan_count)} 次 · 上次 {plugin.last_scan_time_ms}ms
                  </span>
                  <ConnectionBadge state={plugin.connection_state} />
                </Space>
              ) : undefined
            }
          >
            <Table
              rowKey="variable_id"
              size="small"
              columns={pointColumns}
              dataSource={points.data ?? []}
              loading={points.loading && !points.data}
              pagination={{ pageSize: 12, showSizeChanger: false, showTotal: (t) => `共 ${t} 个点位` }}
              locale={{ emptyText: <Empty description="暂无点位数据" /> }}
            />
          </Card>

          <Card
            size="small"
            title={
              <Space>
                <span>网络报文日志</span>
                <Tag color="blue">{selected}</Tag>
              </Space>
            }
            extra={
              <Space>
                <Segmented
                  size="small"
                  value={dirFilter}
                  onChange={(v) => setDirFilter(String(v))}
                  options={[
                    { label: "全部", value: "all" },
                    { label: "TX", value: "tx" },
                    { label: "RX", value: "rx" },
                  ]}
                />
                <Select
                  size="small"
                  style={{ width: 110 }}
                  value={protoFilter}
                  onChange={setProtoFilter}
                  options={[
                    { label: "全部协议", value: "all" },
                    ...protos.map((p) => ({ label: p, value: p })),
                  ]}
                />
              </Space>
            }
          >
            {filteredPackets.length === 0 ? (
              <Empty description="暂无报文记录" />
            ) : (
              <div style={{ maxHeight: 380, overflowY: "auto" }}>
                {[...filteredPackets].reverse().map((pkt, i) => (
                  <div
                    key={`${pkt.timestamp_ms}-${i}`}
                    style={{
                      display: "flex",
                      gap: 10,
                      padding: "5px 8px",
                      borderBottom: "1px solid rgba(148,163,184,0.08)",
                      fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
                      fontSize: 11.5,
                      alignItems: "flex-start",
                    }}
                  >
                    <span
                      style={{
                        color: pkt.direction === "tx" ? "#3b82f6" : "#22c55e",
                        fontWeight: 700,
                        minWidth: 26,
                      }}
                    >
                      {pkt.direction === "tx" ? "TX" : "RX"}
                    </span>
                    <Tag style={{ marginRight: 0, fontSize: 10 }}>{pkt.protocol}</Tag>
                    <span style={{ opacity: 0.5, minWidth: 78, fontSize: 10.5 }}>
                      {pkt.timestamp_ms > 1e12 ? formatTimeMs(pkt.timestamp_ms) : `${(pkt.timestamp_ms / 1000).toFixed(1)}s`}
                    </span>
                    <span style={{ color: "#f59e0b", flex: 1, wordBreak: "break-all" }}>{pkt.hex_dump}</span>
                    <span style={{ opacity: 0.6, minWidth: 180, maxWidth: 260, textAlign: "right" }}>
                      {pkt.summary}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function PluginCard({
  p,
  active,
  onClick,
}: {
  p: PluginStatus;
  active: boolean;
  onClick: () => void;
}) {
  const stateMeta = {
    0: { color: "#64748b", icon: <ApiOutlined /> },
    1: { color: "#f59e0b", icon: <ApiOutlined /> },
    2: { color: "#22c55e", icon: <CheckCircleOutlined /> },
    3: { color: "#ef4444", icon: <CloseCircleOutlined /> },
  }[p.connection_state] ?? { color: "#64748b", icon: <ApiOutlined /> };

  return (
    <div
      onClick={onClick}
      style={{
        border: `1px solid ${active ? "#3b82f6" : "rgba(148,163,184,0.14)"}`,
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "pointer",
        background: active ? "rgba(59,130,246,0.08)" : "transparent",
        boxShadow: active ? "0 0 0 1px #3b82f6" : undefined,
        transition: "all 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <Typography.Text strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: stateMeta.color }}>{stateMeta.icon}</span>
          {p.name}
        </Typography.Text>
        <ConnectionBadge state={p.connection_state} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11.5, opacity: 0.75 }}>
        <span>扫描: {formatNumber(p.scan_count)}</span>
        <span>
          错误:{" "}
          <span style={{ color: p.error_count > 0 ? "#ef4444" : "inherit" }}>{formatNumber(p.error_count)}</span>
        </span>
        <span>上次: {p.last_scan_time_ms}ms</span>
        <span>运行: {formatUptime(p.uptime_ms)}</span>
      </div>
      {p.last_error && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: "#ef4444",
            padding: "4px 6px",
            background: "rgba(239,68,68,0.1)",
            borderRadius: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={p.last_error}
        >
          {p.last_error}
        </div>
      )}
    </div>
  );
}
