import { useMemo } from "react";
import { ApiOutlined, SwapOutlined, WarningOutlined } from "@ant-design/icons";
import {
  Alert,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AppEChartsOption } from "../lib/echarts";
import { api } from "../api/client";
import type {
  InstanceGroupStatus,
  InstanceMemberStatus,
  RedundancyEvent,
  RedundancyPoint,
} from "../api/types";
import StatCard from "../components/StatCard";
import PointValueCell from "../components/PointValueCell";
import { useEChart } from "../hooks/useEChart";
import { usePolling } from "../hooks/usePolling";
import {
  formatAge,
  formatNumber,
  formatTimeMs,
  formatUptime,
} from "../utils/format";

export default function RedundancyMonitor() {
  const status = usePolling(() => api.getRedundancyStatus(), 1000);
  const snap = status.data;
  const groups = usePolling(() => api.getInstanceGroups(), 1000);

  const chartOption = useMemo<AppEChartsOption | null>(() => {
    const rtt = snap?.rtt_history ?? [];
    if (rtt.length < 2) return null;
    return {
      animation: false,
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 20, bottom: 24 },
      xAxis: {
        type: "category",
        data: rtt.map((_, i) => String(i + 1)),
        boundaryGap: false,
      },
      yAxis: { type: "value", name: "ms", min: 0 },
      series: [
        {
          name: "心跳 RTT",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: rtt,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 2 },
        },
      ],
    };
  }, [snap]);
  const chartRef = useEChart(chartOption);

  const eventColumns: ColumnsType<RedundancyEvent> = [
    {
      title: "时间",
      dataIndex: "time_ms",
      width: 120,
      render: (v: number) => (
        <span className="mono" style={{ fontSize: 11 }}>
          {formatTimeMs(v)}
        </span>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      width: 140,
      render: (v: string) => {
        const color =
          v === "promoted" || v === "demoted"
            ? "orange"
            : v === "split_brain"
              ? "red"
              : v === "config_synced"
                ? "blue"
                : "default";
        return <Tag color={color}>{v}</Tag>;
      },
    },
    {
      title: "说明",
      dataIndex: "message",
      ellipsis: { showTitle: true },
    },
  ];

  const pointColumns: ColumnsType<RedundancyPoint> = [
    {
      title: "点位 ID",
      dataIndex: "id",
      render: (v: string) => <span className="mono">{v}</span>,
    },
    {
      title: "值",
      dataIndex: "value",
      width: 120,
      render: (v: RedundancyPoint["value"]) => <PointValueCell value={v} />,
    },
    {
      title: "质量",
      dataIndex: "quality",
      width: 90,
      render: (v: string) => (
        <Tag color={v === "good" ? "green" : v === "bad" ? "red" : "default"}>
          {v}
        </Tag>
      ),
    },
    {
      title: "采样时间",
      dataIndex: "timestamp",
      width: 110,
      render: (v: number) => <span className="mono">{formatTimeMs(v)}</span>,
    },
    {
      title: "同步延迟",
      key: "age",
      width: 100,
      render: (_, pt) => {
        const age = Date.now() - pt.timestamp;
        return (
          <span
            className="mono"
            style={{ color: age > 5000 ? "#f59e0b" : "inherit" }}
          >
            {formatAge(age)}
          </span>
        );
      },
    },
  ];

  const sortedPoints = useMemo(
    () =>
      [...(snap?.synced_points ?? [])].sort(
        (a, b) => a.timestamp - b.timestamp
      ),
    [snap]
  );

  const groupColumns: ColumnsType<InstanceGroupStatus> = [
    {
      title: "组名",
      dataIndex: "group",
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: "成员",
      dataIndex: "members",
      render: (members: InstanceMemberStatus[]) => (
        <Space size={4} wrap>
          {members.map((m) => (
            <Tag
              key={m.name}
              color={
                m.is_active
                  ? "green"
                  : m.role === "primary"
                    ? "blue"
                    : "default"
              }
            >
              {m.name}（{m.role === "primary" ? "主" : `备${m.priority}`}）
              {m.is_active ? " ●" : ""}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "活跃实例",
      dataIndex: "active_instance",
      width: 140,
      render: (v: string) => <span className="mono">{v}</span>,
    },
    {
      title: "连续失败",
      dataIndex: "consecutive_failures",
      width: 90,
      render: (v: number) =>
        v > 0 ? <Tag color="red">{v}</Tag> : <span>{v}</span>,
    },
    { title: "切换次数", dataIndex: "switch_count", width: 90 },
    {
      title: "上次切换",
      dataIndex: "last_switch_reason",
      ellipsis: { showTitle: true },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {snap?.split_brain && (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          message="双主分裂告警"
          description="两个节点均处于 Active，请立即检查网络与节点状态"
        />
      )}
      {!snap?.enabled && (
        <Alert
          type="warning"
          showIcon
          message="冗余未启用"
          description="请在“冗余配置”页开启主备冗余"
        />
      )}

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="本机状态"
            value={snap ? `${snap.role} / ${snap.state}` : "-"}
            icon={<ApiOutlined />}
            color={snap?.state === "active" ? "#22c55e" : "#f59e0b"}
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="对端"
            value={snap ? (snap.peer.reachable ? "可达" : "不可达") : "-"}
            icon={<SwapOutlined />}
            color={snap?.peer.reachable ? "#22c55e" : "#ef4444"}
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="心跳 RTT"
            value={snap ? `${snap.peer.rtt_avg_ms}ms` : "-"}
            icon={<ApiOutlined />}
            color="#3b82f6"
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="值同步延迟"
            value={
              snap && snap.sync.last_sync_ms
                ? formatAge(Date.now() - snap.sync.last_sync_ms)
                : "-"
            }
            icon={<ApiOutlined />}
            color="#06b6d4"
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="切换次数"
            value={snap ? formatNumber(snap.failover_count) : "-"}
            icon={<SwapOutlined />}
            color="#f59e0b"
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="运行时长"
            value={snap ? formatUptime(snap.uptime_ms) : "-"}
            icon={<ApiOutlined />}
            color="#a78bfa"
            loading={status.loading && !snap}
          />
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={10}>
          <Card
            size="small"
            title="心跳 RTT 趋势"
            extra={
              <Tag color="blue">最近 {snap?.rtt_history.length ?? 0} 次</Tag>
            }
          >
            {chartOption ? (
              <div ref={chartRef} style={{ height: 220 }} />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无心跳采样"
                style={{ padding: "40px 0" }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="冗余事件">
            <Table
              rowKey={(r) => `${r.time_ms}-${r.kind}-${r.message}`}
              size="small"
              columns={eventColumns}
              dataSource={snap?.events ?? []}
              loading={status.loading && !snap}
              pagination={{ pageSize: 8, showSizeChanger: false }}
              locale={{ emptyText: <Empty description="暂无事件" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="同步点位（备机视角）"
        extra={<Tag color="blue">共 {snap?.synced_points.length ?? 0} 点</Tag>}
      >
        <Table
          rowKey="id"
          size="small"
          columns={pointColumns}
          dataSource={sortedPoints}
          loading={status.loading && !snap}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="暂无同步点位" /> }}
        />
      </Card>

      <Card
        size="small"
        title="实例冗余组"
        extra={<Tag color="blue">{groups.data?.length ?? 0} 组</Tag>}
      >
        <Table
          rowKey="group"
          size="small"
          columns={groupColumns}
          dataSource={groups.data ?? []}
          loading={groups.loading && !groups.data}
          pagination={false}
          locale={{ emptyText: <Empty description="未配置实例冗余组" /> }}
        />
      </Card>
    </div>
  );
}
