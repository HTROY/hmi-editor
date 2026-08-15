import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  message,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { api } from "../api/client";
import type {
  AlarmOccurrence,
  AlarmSeverity,
  AlarmStatus,
  AlarmStreamEvent,
  SoeRecord,
} from "../api/types";
import SeverityTag, { SEVERITY_OPTIONS } from "../components/SeverityTag";
import { getOperator } from "../operator";
import { errMsg } from "../utils/error";

const QUALITY_LABEL: Record<string, string> = {
  good: "良好",
  bad: "无效",
  uncertain: "不确定",
};

function fmt(ts: number | null | undefined): string {
  if (ts == null) return "-";
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function statusTag(occ: AlarmOccurrence) {
  if (occ.status === "active") return <Tag color="red">未确认</Tag>;
  if (occ.status === "acknowledged") return <Tag color="blue">已确认</Tag>;
  return occ.acknowledgedAt != null ? (
    <Tag color="green">已恢复·已确认</Tag>
  ) : (
    <Tag color="orange">已恢复·未确认</Tag>
  );
}

export default function AlarmMonitor() {
  const [active, setActive] = useState<AlarmOccurrence[]>([]);
  const [history, setHistory] = useState<AlarmOccurrence[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [soe, setSoe] = useState<SoeRecord[]>([]);
  const [soeTotal, setSoeTotal] = useState(0);

  const [histPage, setHistPage] = useState(1);
  const [histSeverity, setHistSeverity] = useState<AlarmSeverity | "">("");
  const [histStatus, setHistStatus] = useState<AlarmStatus | "unacknowledged" | "">("");
  const [soePage, setSoePage] = useState(1);
  const [soeQuality, setSoeQuality] = useState("");

  const [events, setEvents] = useState<Record<string, AlarmStreamEvent[]>>({});
  const [vars, setVars] = useState<{ value: string; label: string }[]>([]);
  const mounted = useRef(true);

  const refreshActive = useCallback(async () => {
    try {
      const data = await api.alarmActive();
      if (mounted.current) setActive(data);
    } catch (e) {
      console.warn("刷新活跃报警失败:", errMsg(e));
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const data = await api.alarmHistory({
        page: histPage,
        pageSize: 20,
        severity: histSeverity || undefined,
        status: histStatus || undefined,
      });
      if (mounted.current) {
        setHistory(data.items);
        setHistoryTotal(data.total);
      }
    } catch (e) {
      console.warn("刷新报警历史失败:", errMsg(e));
    }
  }, [histPage, histSeverity, histStatus]);

  const refreshSoe = useCallback(async () => {
    try {
      const data = await api.soeQuery({
        page: soePage,
        pageSize: 50,
        quality: soeQuality || undefined,
      });
      if (mounted.current) {
        setSoe(data.items);
        setSoeTotal(data.total);
      }
    } catch (e) {
      console.warn("刷新 SOE 失败:", errMsg(e));
    }
  }, [soePage, soeQuality]);

  useEffect(() => {
    mounted.current = true;
    api.listAllPoints(true).then((pts) => {
      const items = pts
        .filter((p) => p.hmi_id)
        .map((p) => ({ value: p.hmi_id!, label: p.hmi_id! }));
      setVars(items);
    });
    const t1 = setInterval(refreshActive, 2000);
    const t2 = setInterval(refreshHistory, 10000);
    const t3 = setInterval(refreshSoe, 10000);
    refreshActive();
    refreshHistory();
    refreshSoe();
    return () => {
      mounted.current = false;
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [refreshActive, refreshHistory, refreshSoe]);

  const doAck = async (id: string) => {
    try {
      await api.alarmAck(id, getOperator());
      message.success("已确认");
      refreshActive();
      refreshHistory();
    } catch (e) {
      message.error(`确认失败: ${errMsg(e)}`);
    }
  };

  const doAckAll = async () => {
    try {
      const r = await api.alarmAckAll(getOperator());
      message.success(`已确认 ${r.acknowledged} 条`);
      refreshActive();
      refreshHistory();
    } catch (e) {
      message.error(`确认失败: ${errMsg(e)}`);
    }
  };

  const loadEvents = async (id: string) => {
    try {
      const data = await api.alarmOccurrenceEvents(id);
      setEvents((prev) => ({ ...prev, [id]: data }));
    } catch {
      setEvents((prev) => ({ ...prev, [id]: [] }));
    }
  };

  const activeColumns: ColumnsType<AlarmOccurrence> = [
    {
      title: "级别",
      dataIndex: "severity",
      width: 76,
      render: (v: AlarmSeverity) => <SeverityTag severity={v} />,
    },
    { title: "名称", dataIndex: "name" },
    { title: "变量", dataIndex: "variableId", width: 200 },
    { title: "消息", dataIndex: "message", ellipsis: true },
    { title: "触发值", dataIndex: "value", width: 90 },
    { title: "阈值", dataIndex: "threshold", width: 90 },
    {
      title: "触发时间",
      dataIndex: "triggeredAt",
      width: 170,
      render: fmt,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (_v, r) => statusTag(r),
    },
    {
      title: "操作",
      key: "op",
      width: 90,
      render: (_v, r) =>
        r.status === "active" ? (
          <Button size="small" type="primary" onClick={() => doAck(r.id)}>
            确认
          </Button>
        ) : null,
    },
  ];

  const historyColumns: ColumnsType<AlarmOccurrence> = [
    {
      title: "级别",
      dataIndex: "severity",
      width: 76,
      render: (v: AlarmSeverity) => <SeverityTag severity={v} />,
    },
    { title: "名称", dataIndex: "name" },
    { title: "变量", dataIndex: "variableId", width: 200 },
    { title: "消息", dataIndex: "message", ellipsis: true },
    {
      title: "触发时间",
      dataIndex: "triggeredAt",
      width: 170,
      render: fmt,
    },
    {
      title: "恢复时间",
      dataIndex: "recoveredAt",
      width: 170,
      render: fmt,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 130,
      render: (_v, r) => statusTag(r),
    },
    {
      title: "操作",
      key: "op",
      width: 90,
      render: (_v, r) =>
        r.status === "recovered" && r.acknowledgedAt == null ? (
          <Button size="small" type="primary" onClick={() => doAck(r.id)}>
            确认
          </Button>
        ) : null,
    },
  ];

  const soeColumns: ColumnsType<SoeRecord> = [
    { title: "序号", dataIndex: "seq", width: 80 },
    { title: "变量", dataIndex: "variableId", width: 220 },
    { title: "值", dataIndex: "value", width: 90 },
    {
      title: "质量",
      dataIndex: "quality",
      width: 100,
      render: (v: string) => (
        <Tag color={v === "good" ? "green" : v === "bad" ? "red" : "gold"}>
          {QUALITY_LABEL[v] ?? v}
        </Tag>
      ),
    },
    {
      title: "设备时间",
      dataIndex: "deviceTime",
      width: 170,
      render: fmt,
    },
    {
      title: "接收时间",
      dataIndex: "receiveTime",
      width: 170,
      render: fmt,
    },
    { title: "来源", dataIndex: "source", width: 100 },
  ];

  const eventColumns: ColumnsType<AlarmStreamEvent> = [
    { title: "时间", dataIndex: "atMs", width: 170, render: fmt },
    {
      title: "类型",
      dataIndex: "eventType",
      width: 110,
      render: (v: string) => (
        <Tag color={v === "trigger" ? "red" : v === "ack" ? "blue" : "green"}>
          {v === "trigger"
            ? "触发"
            : v === "ack"
              ? "确认"
              : v === "recover"
                ? "恢复"
                : "规则停用/删除"}
        </Tag>
      ),
    },
    { title: "内容", dataIndex: "message" },
    { title: "操作人", dataIndex: "byUser", width: 120 },
  ];

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={16}>
      <Tabs
        items={[
          {
            key: "active",
            label: `实时报警（${active.length}）`,
            children: (
              <Card
                title="活跃报警"
                extra={
                  active.length > 0 ? (
                    <Button type="primary" onClick={doAckAll}>
                      确认全部
                    </Button>
                  ) : null
                }
              >
                <Table
                  rowKey="id"
                  size="small"
                  columns={activeColumns}
                  dataSource={active}
                  pagination={false}
                />
              </Card>
            ),
          },
          {
            key: "history",
            label: "报警历史",
            children: (
              <Card
                title="报警历史"
                extra={
                  <Space>
                    <Select
                      allowClear
                      placeholder="级别"
                      style={{ width: 110 }}
                      value={histSeverity || undefined}
                      onChange={(v) => {
                        setHistSeverity(v ?? "");
                        setHistPage(1);
                      }}
                      options={SEVERITY_OPTIONS}
                    />
                    <Select
                      allowClear
                      placeholder="状态"
                      style={{ width: 120 }}
                      value={histStatus || undefined}
                      onChange={(v) => {
                        setHistStatus(v ?? "");
                        setHistPage(1);
                      }}
                      options={[
                        { value: "unacknowledged", label: "未确认" },
                        { value: "acknowledged", label: "已确认" },
                        { value: "active", label: "未恢复" },
                        { value: "recovered", label: "已恢复" },
                      ]}
                    />
                  </Space>
                }
              >
                <Table
                  rowKey="id"
                  size="small"
                  columns={historyColumns}
                  dataSource={history}
                  pagination={{
                    current: histPage,
                    pageSize: 20,
                    total: historyTotal,
                    showTotal: (t) => `共 ${t} 条`,
                    onChange: (p) => setHistPage(p),
                  }}
                  expandable={{
                    expandedRowRender: (r) => (
                      <Table
                        rowKey="id"
                        size="small"
                        columns={eventColumns}
                        dataSource={events[r.id] ?? []}
                        pagination={false}
                      />
                    ),
                    onExpand: (expanded, r) => {
                      if (expanded && !events[r.id]) loadEvents(r.id);
                    },
                  }}
                />
              </Card>
            ),
          },
          {
            key: "soe",
            label: "SOE",
            children: (
              <Card
                title="SOE 顺序事件"
                extra={
                  <Select
                    allowClear
                    placeholder="质量"
                    style={{ width: 120 }}
                    value={soeQuality || undefined}
                    onChange={(v) => {
                      setSoeQuality(v ?? "");
                      setSoePage(1);
                    }}
                    options={[
                      { value: "good", label: "良好" },
                      { value: "bad", label: "无效" },
                      { value: "uncertain", label: "不确定" },
                    ]}
                  />
                }
              >
                <Table
                  rowKey="seq"
                  size="small"
                  columns={soeColumns}
                  dataSource={soe}
                  pagination={{
                    current: soePage,
                    pageSize: 50,
                    total: soeTotal,
                    showTotal: (t) => `共 ${t} 条`,
                    onChange: (p) => setSoePage(p),
                  }}
                />
              </Card>
            ),
          },
        ]}
      />
      {vars.length === 0 && (
        <Card size="small" title="提示">
          未导入点位时，报警历史/SOE 的变量筛选不可用；规则页请先配置点位。
        </Card>
      )}
    </Space>
  );
}
