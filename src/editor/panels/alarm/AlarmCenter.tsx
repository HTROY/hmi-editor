import React, { useEffect, useState } from "react";
import { useEditorStore } from "../../../store/editorStore";
import type {
  AlarmRule,
  AlarmSeverity,
  AlarmStatus,
  AlarmStreamEvent,
} from "../../../core/alarm/types";
import {
  ActiveAlarmRow,
  HistoryAlarmRow,
  Pager,
  SEVERITY_CONFIG,
  SoeRowItem,
} from "./alarm-ui";
import { RuleEditor } from "./RuleEditor";

const CONDITION_LABEL: Record<string, string> = {
  high: "高于阈值",
  low: "低于阈值",
  equal: "等于阈值",
  notEqual: "不等于阈值",
  change: "变位（瞬时）",
};

type RightTab = "history" | "soe" | "rules";

export function AlarmCenter({ onClose }: { onClose: () => void }) {
  const {
    alarmManager,
    varManager,
    acknowledgeAlarm,
    acknowledgeAllAlarms,
    saveAlarmRule,
    deleteAlarmRule,
  } = useEditorStore();
  const [, forceUpdate] = useState(0);
  const [rightTab, setRightTab] = useState<RightTab>("history");

  const [histPage, setHistPage] = useState(1);
  const [histSeverity, setHistSeverity] = useState<AlarmSeverity | "">("");
  const [histStatus, setHistStatus] = useState<AlarmStatus | "">("");
  const [histVar, setHistVar] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [streamEvents, setStreamEvents] = useState<
    Map<string, AlarmStreamEvent[]>
  >(new Map());

  const [soePage, setSoePage] = useState(1);
  const [soeVar, setSoeVar] = useState("");
  const [soeQuality, setSoeQuality] = useState("");
  const soePageSize = 100;

  const [editingRule, setEditingRule] = useState<AlarmRule | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  useEffect(() => {
    if (!alarmManager) return;
    const unsub = alarmManager.onChange(() => forceUpdate((n) => n + 1));
    alarmManager.queryHistory({ page: 1, pageSize: 100 }).catch(() => {});
    alarmManager.querySOE({ page: 1, pageSize: soePageSize }).catch(() => {});
    return unsub;
  }, [alarmManager]);

  useEffect(() => {
    if (!alarmManager) return;
    alarmManager
      .queryHistory({
        page: histPage,
        pageSize: 100,
        severity: histSeverity,
        status: histStatus,
        variableId: histVar || undefined,
      })
      .catch(() => {});
  }, [alarmManager, histPage, histSeverity, histStatus, histVar]);

  useEffect(() => {
    if (!alarmManager) return;
    alarmManager
      .querySOE({
        page: soePage,
        pageSize: soePageSize,
        variableId: soeVar || undefined,
        quality: soeQuality || undefined,
      })
      .catch(() => {});
  }, [alarmManager, soePage, soeVar, soeQuality]);

  const activeAlarms = alarmManager?.getActiveAlarms() ?? [];
  const historyAlarms = alarmManager?.getHistoryAlarms() ?? [];
  const historyTotal = alarmManager?.getHistoryTotal() ?? 0;
  const soeRecords = alarmManager?.getSOERecords(soePageSize) ?? [];
  const soeTotal = alarmManager?.getSOETotal() ?? 0;
  const unackCount = alarmManager?.unacknowledgedCount ?? 0;
  const rules = alarmManager?.listRules() ?? [];
  const mode = alarmManager?.getMode() ?? "local";

  const toggleEvents = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    alarmManager
      ?.getOccurrenceEvents(id)
      .then((events) => {
        setStreamEvents((prev) => {
          const next = new Map(prev);
          next.set(id, events);
          return next;
        });
      })
      .catch(() => {});
  };

  return (
    <div className="alarm-center">
      <div className="alarm-center-header">
        <span className="alarm-center-title">
          🚨 报警中心
          <span className="alarm-mode-badge">
            {alarmManager?.getMode() === "remote" ? "后端" : "模拟"}
          </span>
          {unackCount > 0 && (
            <span className="alarm-center-unacked">{unackCount} 未确认</span>
          )}
        </span>
        <button className="btn btn-sm" onClick={onClose}>
          关闭 ✕
        </button>
      </div>
      <div className="alarm-center-body">
        <div className="alarm-center-left">
          <div className="alarm-center-section-title">
            活跃报警
            {activeAlarms.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => acknowledgeAllAlarms()}
              >
                确认全部 ({unackCount})
              </button>
            )}
          </div>
          <div className="alarm-center-scroll">
            {activeAlarms.length === 0 && (
              <div className="panel-hint">无活跃报警</div>
            )}
            {activeAlarms.map((alarm) => (
              <ActiveAlarmRow
                key={alarm.id}
                alarm={alarm}
                liveValue={varManager?.getValue(alarm.variableId)?.value}
                onAck={(id) => acknowledgeAlarm(id)}
              />
            ))}
          </div>
        </div>
        <div className="alarm-center-right">
          <div className="alarm-tabs">
            <button
              className={
                "alarm-tab" + (rightTab === "history" ? " active" : "")
              }
              onClick={() => setRightTab("history")}
            >
              报警历史
            </button>
            <button
              className={"alarm-tab" + (rightTab === "soe" ? " active" : "")}
              onClick={() => setRightTab("soe")}
            >
              SOE
            </button>
            {mode === "local" && (
              <button
                className={"alarm-tab" + (rightTab === "rules" ? " active" : "")}
                onClick={() => setRightTab("rules")}
              >
                规则管理
              </button>
            )}
          </div>

          {rightTab === "history" && (
            <div className="alarm-center-tab-content">
              <div className="alarm-filter-row">
                <select
                  value={histSeverity}
                  onChange={(e) => {
                    setHistSeverity(e.target.value as AlarmSeverity | "");
                    setHistPage(1);
                  }}
                >
                  <option value="">全部级别</option>
                  <option value="critical">紧急</option>
                  <option value="major">严重</option>
                  <option value="minor">一般</option>
                  <option value="warning">预警</option>
                </select>
                <select
                  value={histStatus}
                  onChange={(e) => {
                    setHistStatus(e.target.value as AlarmStatus | "");
                    setHistPage(1);
                  }}
                >
                  <option value="">全部状态</option>
                  <option value="active">未恢复</option>
                  <option value="acknowledged">已确认</option>
                  <option value="recovered">已恢复</option>
                </select>
                <select
                  value={histVar}
                  onChange={(e) => {
                    setHistVar(e.target.value);
                    setHistPage(1);
                  }}
                >
                  <option value="">全部变量</option>
                  {varManager
                    ?.getAllDefs()
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.id}
                      </option>
                    ))}
                </select>
              </div>
              <div className="alarm-center-scroll">
                {historyAlarms.length === 0 && (
                  <div className="panel-hint">暂无报警历史</div>
                )}
                {historyAlarms.map((alarm) => (
                  <HistoryAlarmRow
                    key={alarm.id}
                    alarm={alarm}
                    events={streamEvents.get(alarm.id)}
                    expanded={expandedId === alarm.id}
                    onToggle={() => toggleEvents(alarm.id)}
                    onAck={(id) => acknowledgeAlarm(id)}
                  />
                ))}
              </div>
              <Pager
                page={histPage}
                pageSize={100}
                total={historyTotal}
                onPage={setHistPage}
              />
            </div>
          )}

          {rightTab === "soe" && (
            <div className="alarm-center-tab-content">
              <div className="alarm-filter-row">
                <select
                  value={soeVar}
                  onChange={(e) => setSoeVar(e.target.value)}
                >
                  <option value="">全部变量</option>
                  {varManager
                    ?.getAllDefs()
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.id}
                      </option>
                    ))}
                </select>
                <select
                  value={soeQuality}
                  onChange={(e) => setSoeQuality(e.target.value)}
                >
                  <option value="">全部质量</option>
                  <option value="good">良好</option>
                  <option value="bad">无效</option>
                  <option value="uncertain">不确定</option>
                </select>
              </div>
              <div className="soe-list alarm-center-scroll">
                {soeRecords.length === 0 && (
                  <div className="panel-hint">暂无 SOE 记录</div>
                )}
                {soeRecords.map((soe) => (
                  <SoeRowItem key={soe.seq} record={soe} />
                ))}
              </div>
              <Pager
                page={soePage}
                pageSize={soePageSize}
                total={soeTotal}
                onPage={setSoePage}
              />
            </div>
          )}

          {rightTab === "rules" && mode === "local" && (
            <div className="alarm-center-tab-content">
              <div className="alarm-filter-row">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    setEditingRule(null);
                    setShowEditor(true);
                  }}
                >
                  + 新建规则
                </button>
              </div>
              <div className="alarm-center-scroll">
                {rules.length === 0 && (
                  <div className="panel-hint">暂无报警规则</div>
                )}
                {rules.map((rule) => {
                  const sc =
                    SEVERITY_CONFIG[rule.severity] ?? SEVERITY_CONFIG.warning;
                  return (
                    <div key={rule.id} className="rule-row">
                      <div className="rule-row-header">
                        <span
                          className="alarm-severity"
                          style={{ background: sc.color }}
                        >
                          {sc.label}
                        </span>
                        <span className="rule-name">{rule.name}</span>
                        <span className="rule-enabled">
                          {rule.enabled ? "启用" : "停用"}
                        </span>
                      </div>
                      <div className="rule-row-detail">
                        {rule.id} · {rule.variableId} ·{" "}
                        {CONDITION_LABEL[rule.condition] ?? rule.condition} {rule.threshold}
                        {rule.hysteresis > 0 && ` · 滞回 ${rule.hysteresis}`}
                        {rule.confirmMs > 0 && ` · 确认 ${rule.confirmMs}ms`}
                        {rule.group && ` · ${rule.group}`}
                      </div>
                      <div className="rule-row-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setEditingRule(rule);
                            setShowEditor(true);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => {
                            if (window.confirm(`删除规则「${rule.name}」？`)) {
                              deleteAlarmRule(rule.id).catch(() => {});
                            }
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      {showEditor && (
        <RuleEditor
          varManager={varManager}
          initial={editingRule}
          onSave={(rule) => saveAlarmRule(rule)}
          onCancel={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}
