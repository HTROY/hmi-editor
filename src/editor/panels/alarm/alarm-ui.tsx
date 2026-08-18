import type {
  AlarmOccurrence,
  AlarmSeverity,
  AlarmStreamEvent,
  SOERecord,
} from "../../../core/alarm/types";

export const SEVERITY_CONFIG: Record<
  AlarmSeverity,
  { label: string; color: string; bg: string }
> = {
  critical: { label: "紧急", color: "#FF2020", bg: "#2A1010" },
  major: { label: "严重", color: "#E06020", bg: "#2A1A10" },
  minor: { label: "一般", color: "#E0C020", bg: "#2A2410" },
  warning: { label: "预警", color: "#60A0E0", bg: "#101A2A" },
};

export const QUALITY_LABEL: Record<string, string> = {
  good: "良好",
  bad: "无效",
  uncertain: "不确定",
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  trigger: "触发",
  ack: "确认",
  recover: "恢复",
  rule_disabled: "规则停用/删除",
};

export function formatTime(ts: number | null | undefined): string {
  if (ts == null) return "-";
  const d = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

export function formatDuration(from: number, to: number | null): string {
  if (to == null) return "进行中";
  const ms = Math.max(0, to - from);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function alarmStatusLabel(alarm: AlarmOccurrence): string {
  if (alarm.status === "active") return "未确认";
  if (alarm.status === "acknowledged") return "已确认";
  if (alarm.acknowledgedAt != null) return "已恢复·已确认";
  return "已恢复·未确认";
}

export function SeverityTag({ severity }: { severity: AlarmSeverity }) {
  const sc = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.warning;
  return (
    <span className="alarm-severity" style={{ background: sc.color }}>
      {sc.label}
    </span>
  );
}

export function ActiveAlarmRow({
  alarm,
  liveValue,
  onAck,
}: {
  alarm: AlarmOccurrence;
  liveValue?: number | boolean;
  onAck: (id: string) => void;
}) {
  const sc = SEVERITY_CONFIG[alarm.severity] ?? SEVERITY_CONFIG.warning;
  return (
    <div
      className={"alarm-row" + (alarm.status === "active" ? " unacked" : "")}
      style={{ borderLeftColor: sc.color }}
    >
      <div className="alarm-row-header">
        <SeverityTag severity={alarm.severity} />
        <span className="alarm-name" title={alarm.name}>
          {alarm.name}
        </span>
        <span className="alarm-var" title={alarm.variableId}>
          {alarm.variableId}
        </span>
        <span className="alarm-time">{formatTime(alarm.triggeredAt)}</span>
      </div>
      <div className="alarm-row-detail">
        {alarm.message} · 触发值: {String(alarm.value)} / 阈值:{" "}
        {alarm.threshold}
        {liveValue !== undefined && (
          <span className="alarm-live">
            {" "}
            · 当前值: <b>{String(liveValue)}</b>
          </span>
        )}
      </div>
      <div className="alarm-row-footer">
        <span
          className="alarm-status"
          style={{
            color:
              alarm.status === "active" ? sc.color : "var(--text-secondary)",
          }}
        >
          {alarm.status === "active" ? "未确认" : "已确认"}
        </span>
        {alarm.status === "active" && (
          <button className="btn btn-sm" onClick={() => onAck(alarm.id)}>
            确认
          </button>
        )}
      </div>
    </div>
  );
}

export function HistoryAlarmRow({
  alarm,
  events,
  expanded,
  onToggle,
  onAck,
}: {
  alarm: AlarmOccurrence;
  events?: AlarmStreamEvent[];
  expanded: boolean;
  onToggle: () => void;
  onAck: (id: string) => void;
}) {
  const sc = SEVERITY_CONFIG[alarm.severity] ?? SEVERITY_CONFIG.warning;
  const unacked = alarm.status === "recovered" && alarm.acknowledgedAt == null;
  return (
    <div
      className={"alarm-row history-row" + (unacked ? " unacked" : "")}
      style={{ borderLeftColor: sc.color }}
    >
      <div className="alarm-row-header">
        <SeverityTag severity={alarm.severity} />
        <span className="alarm-name" title={alarm.name}>
          {alarm.name}
        </span>
        <span className="alarm-var" title={alarm.variableId}>
          {alarm.variableId}
        </span>
        <span className="alarm-time">{formatTime(alarm.triggeredAt)}</span>
        <button className="btn-icon" title="明细" onClick={onToggle}>
          {expanded ? "▾" : "▸"}
        </button>
      </div>
      <div className="alarm-row-detail">
        {alarm.message} · 恢复: {formatTime(alarm.recoveredAt)} · 持续:{" "}
        {formatDuration(alarm.triggeredAt, alarm.recoveredAt)}
        {alarm.recoveredReason && `（${alarm.recoveredReason}）`}
      </div>
      <div className="alarm-row-footer">
        <span
          className="alarm-status"
          style={{ color: unacked ? sc.color : "var(--text-secondary)" }}
        >
          {alarmStatusLabel(alarm)}
        </span>
        {alarm.acknowledgedBy && (
          <span className="alarm-ack-by">
            {alarm.acknowledgedBy} @ {formatTime(alarm.acknowledgedAt)}
          </span>
        )}
        {unacked && (
          <button className="btn btn-sm" onClick={() => onAck(alarm.id)}>
            确认
          </button>
        )}
      </div>
      {expanded && events && (
        <div className="alarm-events">
          {events.length === 0 && (
            <div className="panel-hint">暂无明细事件</div>
          )}
          {events.map((ev) => (
            <div key={ev.id} className="alarm-event-row">
              <span className="alarm-event-time">{formatTime(ev.atMs)}</span>
              <span className="alarm-event-type">
                {EVENT_TYPE_LABEL[ev.eventType] ?? ev.eventType}
              </span>
              <span className="alarm-event-msg">{ev.message}</span>
              {ev.byUser && <span className="alarm-event-by">{ev.byUser}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SoeRowItem({ record }: { record: SOERecord }) {
  return (
    <div className="soe-row">
      <span className="soe-time">{formatTime(record.deviceTime)}</span>
      <span className="soe-var">{record.variableId}</span>
      <span className="soe-val">{String(record.value)}</span>
      <span className={"soe-quality " + record.quality}>
        {QUALITY_LABEL[record.quality] ?? record.quality}
      </span>
      <span className="soe-source">{record.source}</span>
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="alarm-pager">
      <button
        className="btn btn-sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ←
      </button>
      <span>
        {page} / {pages}（共 {total} 条）
      </span>
      <button
        className="btn btn-sm"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        →
      </button>
    </div>
  );
}
