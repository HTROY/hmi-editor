import { useMemo } from "react";
import {
  AlertOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ScanOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Card,
  Col,
  Empty,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EChartsOption } from "echarts";
import { api } from "../api/client";
import type { MonitorSnapshot, PluginStatus } from "../api/types";
import ConnectionBadge from "../components/ConnectionBadge";
import StatCard from "../components/StatCard";
import { useEChart } from "../hooks/useEChart";
import { usePolling } from "../hooks/usePolling";
import { formatNumber, formatTime, formatUptime } from "../utils/format";

export default function Dashboard() {
  const overview = usePolling(() => api.monitorOverview(), 1000);
  const history = usePolling(() => api.monitorHistory(300), 1000);

  const snap: MonitorSnapshot | null = overview.data;
  const samples = history.data?.samples ?? [];

  const chartOption = useMemo<EChartsOption | null>(() => {
    if (!samples.length) return null;
    const ordered = [...samples].reverse();
    const times = ordered.map((s) => formatTime(s.timestamp_ms));
    const rates: (number | null)[] = [];
    for (let i = 1; i < ordered.length; i++) {
      const dt = (ordered[i].timestamp_ms - ordered[i - 1].timestamp_ms) / 1000;
      const dScan = ordered[i].total_scans - ordered[i - 1].total_scans;
      rates.push(dt > 0 ? Math.round((dScan / dt) * 10) / 10 : null);
    }
    rates.unshift(null);
    const errors = ordered.map((s) => s.total_errors);
    return {
      animation: false,
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const list = params as {
            axisValue: string;
            seriesName: string;
            value: unknown;
          }[];
          const lines = list.map(
            (p) =>
              `${p.seriesName}: <b>${p.value === null || p.value === undefined ? "-" : p.value}</b>`,
          );
          return `${list[0]?.axisValue ?? ""}<br/>${lines.join("<br/>")}`;
        },
      },
      legend: { data: ["扫描速率 (次/s)", "累计错误"], top: 0 },
      grid: { left: 48, right: 48, top: 36, bottom: 24 },
      xAxis: { type: "category", data: times, boundaryGap: false },
      yAxis: [
        { type: "value", name: "次/s", minInterval: 1 },
        { type: "value", name: "错误", min: 0 },
      ],
      series: [
        {
          name: "扫描速率 (次/s)",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: rates,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 2 },
        },
        {
          name: "累计错误",
          type: "line",
          smooth: true,
          showSymbol: false,
          yAxisIndex: 1,
          data: errors,
          lineStyle: { width: 2 },
        },
      ],
    };
  }, [samples]);

  const chartRef = useEChart(chartOption);

  const pluginColumns: ColumnsType<PluginStatus> = [
    {
      title: "插件",
      dataIndex: "name",
      render: (v: string) => (
        <Space>
          <ApiOutlined style={{ color: "#3b82f6" }} />
          <Typography.Text strong>{v}</Typography.Text>
        </Space>
      ),
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
      title: "连接状态",
      dataIndex: "connection_state",
      render: (s: number) => <ConnectionBadge state={s} />,
    },
    {
      title: "扫描次数",
      dataIndex: "scan_count",
      render: (v: number) => formatNumber(v),
    },
    {
      title: "错误次数",
      dataIndex: "error_count",
      render: (v: number) =>
        v > 0 ? (
          <Typography.Text type="danger">{formatNumber(v)}</Typography.Text>
        ) : (
          <span>{formatNumber(v)}</span>
        ),
    },
    {
      title: "上次扫描耗时",
      dataIndex: "last_scan_time_ms",
      render: (v: number) => (v ? `${v}ms` : "-"),
    },
    {
      title: "运行时长",
      dataIndex: "uptime_ms",
      render: (v: number) => formatUptime(v),
    },
  ];

  const errors = (snap?.plugins ?? [])
    .filter((p) => p.last_error)
    .sort((a, b) => b.error_count - a.error_count);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            title="运行插件"
            value={snap?.plugins.length ?? "-"}
            icon={<ThunderboltOutlined />}
            color="#3b82f6"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            title="点位总数"
            value={snap?.total_points ?? "-"}
            icon={<DatabaseOutlined />}
            color="#06b6d4"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            title="总扫描次数"
            value={snap ? formatNumber(snap.total_scans) : "-"}
            icon={<ScanOutlined />}
            color="#22c55e"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            title="累计错误"
            value={snap ? formatNumber(snap.total_errors) : "-"}
            icon={<AlertOutlined />}
            color={snap && snap.total_errors > 0 ? "#ef4444" : "#22c55e"}
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            title="WS 客户端"
            value={snap?.active_ws_clients ?? "-"}
            icon={<ApiOutlined />}
            color="#a78bfa"
            loading={overview.loading && !snap}
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            title="服务器运行"
            value={snap ? formatUptime(snap.server_uptime_ms) : "-"}
            icon={<ClockCircleOutlined />}
            color="#f59e0b"
            loading={overview.loading && !snap}
            hint={
              snap
                ? `启动于 ${formatTime(Date.now() - snap.server_uptime_ms)}`
                : undefined
            }
          />
        </Col>
      </Row>

      <Card
        size="small"
        title="实时趋势"
        extra={<Tag color="blue">最近 15 分钟 · 1s 刷新</Tag>}
      >
        {samples.length > 0 ? (
          <div ref={chartRef} style={{ height: 300 }} />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无历史采样数据，等待后端采样……"
            style={{ padding: "80px 0" }}
          />
        )}
      </Card>

      <Card size="small" title="插件状态总览">
        <Table
          rowKey="name"
          size="small"
          columns={pluginColumns}
          dataSource={snap?.plugins ?? []}
          loading={overview.loading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无运行中的插件"
              />
            ),
          }}
        />
      </Card>

      {errors.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <AlertOutlined style={{ color: "#ef4444" }} />
              最近错误
            </Space>
          }
        >
          {errors.map((p) => (
            <div
              key={p.name}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 10px",
                marginBottom: 8,
                borderRadius: 6,
                background: "rgba(239,68,68,0.08)",
              }}
            >
              <Tag color="error">{p.name}</Tag>
              <Typography.Text
                style={{ flex: 1 }}
                ellipsis={{ tooltip: p.last_error }}
                type="danger"
              >
                {p.last_error}
              </Typography.Text>
              <Tooltip
                title={`错误发生于 ${formatTime(Date.now() - (snap!.server_uptime_ms - p.last_error_time_ms))}`}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatUptime(snap!.server_uptime_ms - p.last_error_time_ms)}{" "}
                  前
                </Typography.Text>
              </Tooltip>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
