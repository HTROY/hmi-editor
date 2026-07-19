import React, { useState, useEffect } from "react";
import { useEditorStore } from "../../../store/editorStore";
import type { AlarmEvent } from "../../../core/alarm/types";

// ============================================================
// AlarmPanel — 报警与事件面板
// ============================================================

const SEVERITY_CONFIG: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  critical: { label: "紧急", color: "#FF2020", bg: "#2A1010" },
  major: { label: "严重", color: "#E06020", bg: "#2A1A10" },
  minor: { label: "一般", color: "#E0C020", bg: "#2A2410" },
  warning: { label: "预警", color: "#60A0E0", bg: "#101A2A" },
};

export function AlarmPanel() {
  const { alarmManager, acknowledgeAlarm, acknowledgeAllAlarms } =
    useEditorStore();
  const [activeTab, setActiveTab] = useState<"active" | "history" | "soe">(
    "active",
  );
  const [, forceUpdate] = useState(0);

  const activeAlarms = alarmManager?.getActiveAlarms() ?? [];
  const soeRecords = alarmManager?.getSOERecords(50) ?? [];

  // 监听报警变化
  useEffect(() => {
    if (!alarmManager) return;
    const unsub = alarmManager.onChange(() => forceUpdate((n) => n + 1));
    return unsub;
  }, [alarmManager]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return (
      d.toLocaleTimeString("zh-CN", { hour12: false }) +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  };

  const alarmCount = activeAlarms.length;
  const unackCount = alarmManager?.unacknowledgedCount ?? 0;

  return (
    <div className="panel alarm-panel">
      <div className="panel-title">
        报警事件
        <span
          className="panel-badge"
          style={{
            background: unackCount > 0 ? "var(--danger)" : "var(--success)",
          }}
        >
          {unackCount > 0 ? unackCount + " 未确认" : "正常"}
        </span>
      </div>

      <div className="alarm-tabs">
        <button
          className={"alarm-tab" + (activeTab === "active" ? " active" : "")}
          onClick={() => setActiveTab("active")}
        >
          活跃 ({alarmCount})
        </button>
        <button
          className={"alarm-tab" + (activeTab === "history" ? " active" : "")}
          onClick={() => setActiveTab("history")}
        >
          历史
        </button>
        <button
          className={"alarm-tab" + (activeTab === "soe" ? " active" : "")}
          onClick={() => setActiveTab("soe")}
        >
          SOE
        </button>
      </div>

      {activeTab === "active" && (
        <div className="alarm-content">
          {alarmCount > 0 && (
            <button
              className="btn btn-sm btn-full"
              onClick={acknowledgeAllAlarms}
              style={{ marginBottom: 4 }}
            >
              确认全部 ({unackCount})
            </button>
          )}
          {activeAlarms.length === 0 && (
            <div className="panel-hint">无活跃报警</div>
          )}
          {activeAlarms.map((alarm) => {
            const sc =
              SEVERITY_CONFIG[alarm.severity] ?? SEVERITY_CONFIG.warning!;
            return (
              <div
                key={alarm.id}
                className="alarm-row"
                style={{ borderLeftColor: sc.color }}
              >
                <div className="alarm-row-header">
                  <span
                    className="alarm-severity"
                    style={{ background: sc.color }}
                  >
                    {sc.label}
                  </span>
                  <span className="alarm-name">{alarm.name}</span>
                  <span className="alarm-time">
                    {formatTime(alarm.triggeredAt)}
                  </span>
                </div>
                <div className="alarm-row-detail">
                  {alarm.message} · 当前值: {String(alarm.value)} / 阈值:{" "}
                  {alarm.threshold}
                </div>
                <div className="alarm-row-footer">
                  <span
                    className="alarm-status"
                    style={{
                      color:
                        alarm.status === "active"
                          ? sc.color
                          : "var(--text-secondary)",
                    }}
                  >
                    {alarm.status === "active" ? "未确认" : "已确认"}
                  </span>
                  {alarm.status === "active" && (
                    <button
                      className="btn btn-sm"
                      onClick={() => acknowledgeAlarm(alarm.id)}
                    >
                      确认
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === "soe" && (
        <div className="alarm-content">
          <div className="panel-hint">SOE 顺序事件记录（毫秒精度）</div>
          <div className="soe-list">
            {soeRecords.map((soe) => (
              <div key={soe.id} className="soe-row">
                <span className="soe-time">{formatTime(soe.timestamp)}</span>
                <span className="soe-var">{soe.variableId}</span>
                <span className="soe-val">{String(soe.value)}</span>
                <span className={"soe-quality " + soe.quality}>
                  {soe.quality}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
