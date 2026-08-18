import { useEffect, useState } from "react";
import { useEditorStore } from "../../../store/editorStore";
import type {
  AlarmStreamEvent,
  AlarmSeverity,
  AlarmStatus,
} from "../../../core/alarm/types";
import { ActiveAlarmRow, HistoryAlarmRow, Pager, SoeRowItem } from "./alarm-ui";
import { AlarmCenter } from "./AlarmCenter";
import { Icon } from "../../icons";

type TabKey = "active" | "history" | "soe";

export function AlarmPanel() {
  const { alarmManager, acknowledgeAlarm, acknowledgeAllAlarms } =
    useEditorStore();
  const [, forceUpdate] = useState(0);
  const [activeTab, setActiveTab] = useState<TabKey>("active");
  const [showCenter, setShowCenter] = useState(false);

  const [histPage, setHistPage] = useState(1);
  const [histSeverity, setHistSeverity] = useState<AlarmSeverity | "">("");
  const [histStatus, setHistStatus] = useState<
    AlarmStatus | "unacknowledged" | ""
  >("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [streamEvents, setStreamEvents] = useState<
    Map<string, AlarmStreamEvent[]>
  >(new Map());

  const [soePage, setSoePage] = useState(1);
  const [soeVar, setSoeVar] = useState("");
  const [soeQuality, setSoeQuality] = useState("");
  const soePageSize = 50;

  const varManager = useEditorStore((s) => s.varManager);

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
      })
      .catch(() => {});
  }, [alarmManager, histPage, histSeverity, histStatus]);

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
    <>
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
          <span className="alarm-mode-badge">
            {mode === "remote" ? "后端" : "模拟"}
          </span>
          <button
            className="btn btn-sm"
            title="全屏报警中心"
            onClick={() => setShowCenter(true)}
          >
            <Icon name="expand" size={13} />
          </button>
        </div>

        <div className="alarm-tabs">
          <button
            className={"alarm-tab" + (activeTab === "active" ? " active" : "")}
            onClick={() => setActiveTab("active")}
          >
            活跃 ({activeAlarms.length})
          </button>
          <button
            className={"alarm-tab" + (activeTab === "history" ? " active" : "")}
            onClick={() => setActiveTab("history")}
          >
            历史 ({historyTotal})
          </button>
          <button
            className={"alarm-tab" + (activeTab === "soe" ? " active" : "")}
            onClick={() => setActiveTab("soe")}
          >
            SOE ({soeTotal})
          </button>
        </div>

        {activeTab === "active" && (
          <div className="alarm-content">
            {activeAlarms.length > 0 && (
              <button
                className="btn btn-sm btn-full"
                onClick={() => acknowledgeAllAlarms()}
              >
                确认全部 ({unackCount})
              </button>
            )}
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
        )}

        {activeTab === "history" && (
          <div className="alarm-content">
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
                <option value="unacknowledged">未确认</option>
                <option value="acknowledged">已确认</option>
                <option value="active">未恢复</option>
                <option value="recovered">已恢复</option>
              </select>
            </div>
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
            <Pager
              page={histPage}
              pageSize={100}
              total={historyTotal}
              onPage={setHistPage}
            />
          </div>
        )}

        {activeTab === "soe" && (
          <div className="alarm-content">
            <div className="alarm-filter-row">
              <select
                value={soeVar}
                onChange={(e) => setSoeVar(e.target.value)}
              >
                <option value="">全部变量</option>
                {varManager?.getAllDefs().map((v) => (
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
            <div className="soe-list-head">
              <span>时间</span>
              <span>变量</span>
              <span>值</span>
              <span>质量</span>
              <span>来源</span>
            </div>
            <div className="soe-list">
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
      </div>
      {showCenter && <AlarmCenter onClose={() => setShowCenter(false)} />}
    </>
  );
}
