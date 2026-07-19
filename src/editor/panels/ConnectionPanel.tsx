import React, { useState, useEffect } from "react";
import { useEditorStore } from "../../store/editorStore";
import type { ActiveSource } from "../../core/io";

// ============================================================
// ConnectionPanel — 数据连接管理面板
// 配置数据源、查看连接状态、手动控制
// ============================================================

export function ConnectionPanel() {
  const { dataBridge, simRunning, toggleSimulation, wsConfig, setWsConfig } =
    useEditorStore();

  const [activeSource, setActiveSource] = useState<ActiveSource>("simulation");
  const [statuses, setStatuses] = useState<Record<string, string>>({
    iec104: "disconnected",
    websocket: "disconnected",
  });
  const [wsUrl, setWsUrl] = useState(
    wsConfig?.url ?? "ws://localhost:8080/iscs/data",
  );
  const [iec104Host, setIec104Host] = useState("192.168.1.100");
  const [iec104Port, setIec104Port] = useState(2404);

  // 监听状态变化
  useEffect(() => {
    if (!dataBridge) return;
    const unsub = dataBridge.onStatus((source, status) => {
      setStatuses((prev) => ({ ...prev, [source]: status }));
    });
    return unsub;
  }, [dataBridge]);

  const handleSourceChange = (source: ActiveSource) => {
    if (simRunning) toggleSimulation();
    setActiveSource(source);
    dataBridge?.setActiveSource(source);
  };

  const handleConnect = () => {
    if (simRunning) toggleSimulation();
    dataBridge?.setActiveSource(activeSource);
  };

  const handleDisconnect = () => {
    if (simRunning) toggleSimulation();
    dataBridge?.stop();
  };

  const handleStartSim = () => {
    if (!simRunning) toggleSimulation();
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "connected":
        return "var(--success)";
      case "connecting":
        return "var(--warning)";
      case "error":
        return "var(--danger)";
      default:
        return "#666";
    }
  };

  const statusLabel = (s: string) => {
    switch (s) {
      case "connected":
        return "已连接";
      case "connecting":
        return "连接中...";
      case "error":
        return "错误";
      default:
        return "未连接";
    }
  };

  return (
    <div className="panel">
      <div className="panel-title">数据连接</div>

      {/* 数据源选择 */}
      <div className="conn-section">
        <div className="conn-section-title">数据源</div>
        <div className="conn-source-list">
          {[
            {
              key: "simulation" as ActiveSource,
              label: "内置模拟",
              desc: "VariableManager 随机数据",
            },
            {
              key: "iec104" as ActiveSource,
              label: "IEC 104 模拟",
              desc: "模拟地铁 ISCS 协议站",
            },
            {
              key: "websocket" as ActiveSource,
              label: "WebSocket",
              desc: "连接后端实时服务",
            },
          ].map((src) => (
            <label
              key={src.key}
              className={
                "conn-source-item" + (activeSource === src.key ? " active" : "")
              }
            >
              <input
                type="radio"
                name="source"
                checked={activeSource === src.key}
                onChange={() => handleSourceChange(src.key)}
              />
              <div className="conn-source-info">
                <div className="conn-source-name">{src.label}</div>
                <div className="conn-source-desc">{src.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* WebSocket 配置 */}
      {activeSource === "websocket" && (
        <div className="conn-section">
          <div className="conn-section-title">WebSocket 配置</div>
          <div className="prop-group">
            <label>地址</label>
            <input
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder="ws://host:port/path"
            />
          </div>
        </div>
      )}

      {/* IEC 104 配置 */}
      {activeSource === "iec104" && (
        <div className="conn-section">
          <div className="conn-section-title">IEC 104 配置</div>
          <div className="prop-group">
            <label>主机</label>
            <input
              value={iec104Host}
              onChange={(e) => setIec104Host(e.target.value)}
            />
          </div>
          <div className="prop-group">
            <label>端口</label>
            <input
              type="number"
              value={iec104Port}
              onChange={(e) => setIec104Port(Number(e.target.value))}
            />
          </div>
        </div>
      )}

      {/* 状态 */}
      <div className="conn-section">
        <div className="conn-section-title">状态</div>
        {activeSource === "simulation" ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 0",
            }}
          >
            <span
              style={{
                color: simRunning ? "var(--success)" : "#666",
                fontSize: 18,
              }}
            >
              ●
            </span>
            <span style={{ fontSize: 12 }}>
              {simRunning ? "模拟运行中" : "已停止"}
            </span>
          </div>
        ) : (
          <>
            {Object.entries(statuses).map(([src, st]) => (
              <div
                key={src}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                }}
              >
                <span style={{ color: statusColor(st), fontSize: 18 }}>●</span>
                <span style={{ fontSize: 12, flex: 1 }}>
                  {src === "iec104" ? "IEC 104" : "WebSocket"}
                </span>
                <span style={{ fontSize: 11, color: statusColor(st) }}>
                  {statusLabel(st)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="conn-actions">
        {activeSource === "simulation" ? (
          <button
            className={
              "btn btn-full" + (simRunning ? " btn-danger" : " btn-primary")
            }
            onClick={handleStartSim}
          >
            {simRunning ? "⏹ 停止模拟" : "▶ 启动模拟"}
          </button>
        ) : (
          <>
            <button
              className="btn btn-primary btn-full"
              onClick={handleConnect}
            >
              🔗 连接
            </button>
            <button className="btn btn-full" onClick={handleDisconnect}>
              ⚡ 断开
            </button>
          </>
        )}
      </div>

      {/* 数据统计 */}
      <div className="conn-section">
        <div className="conn-section-title">数据统计</div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            padding: "4px 0",
          }}
        >
          {useEditorStore.getState().varManager.count} 个变量已定义
        </div>
      </div>
    </div>
  );
}
