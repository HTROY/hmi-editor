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
  const [ioBackendUrl, setIoBackendUrl] = useState("ws://localhost:8080/iscs/data");
  const [ioBackendApiUrl, setIoBackendApiUrl] = useState("http://localhost:8081");
  const [fetchingVars, setFetchingVars] = useState(false);
  const [varFetchMsg, setVarFetchMsg] = useState<string | null>(null);

  // 跟踪是否已经为本次连接拉取过变量（防止重复拉取）
  const [hasFetched, setHasFetched] = useState(false);

  // 用 ref 追踪状态，避免 useEffect 闭包过期
  const hasFetchedRef = React.useRef(hasFetched);
  hasFetchedRef.current = hasFetched;
  const ioBackendApiUrlRef = React.useRef(ioBackendApiUrl);
  ioBackendApiUrlRef.current = ioBackendApiUrl;

  // 监听状态变化
  useEffect(() => {
    if (!dataBridge) return;

    const doFetch = () => {
      setHasFetched(true);
      setFetchingVars(true);
      setVarFetchMsg(null);
      dataBridge
        .fetchVariablesFromBackend(ioBackendApiUrlRef.current)
        .then((count) => {
          setFetchingVars(false);
          setVarFetchMsg("已导入 " + count + " 个变量");
        })
        .catch((err) => {
          setFetchingVars(false);
          setVarFetchMsg("拉取失败: " + (err.message ?? "未知错误"));
        });
    };

    // 面板挂载时检查是否已连接
    if (
      dataBridge.active === "io_backend" &&
      dataBridge.getStatus("websocket") === "connected" &&
      !hasFetchedRef.current
    ) {
      doFetch();
    }

    const unsub = dataBridge.onStatus((source, status) => {
      setStatuses((prev) => ({ ...prev, [source]: status }));

      // 当 io_backend WebSocket 连接成功时，自动拉取变量列表
      if (
        source === "websocket" &&
        status === "connected" &&
        dataBridge.active === "io_backend" &&
        !hasFetchedRef.current
      ) {
        doFetch();
      }

      // 断开时重置拉取标记
      if (source === "websocket" && status === "disconnected") {
        setHasFetched(false);
      }
    });
    return unsub;
  }, [dataBridge]);

  const handleSourceChange = (source: ActiveSource) => {
    if (simRunning) toggleSimulation();
    setActiveSource(source);

    // 只停止当前数据源，不自动连接（等待用户点击「连接」按钮）
    if (dataBridge?.active !== "simulation") {
      dataBridge?.stop();
    }

    // 预配置 io_backend 的 WebSocket URL
    if (source === "io_backend") {
      dataBridge?.wsClient.updateConfig({ url: ioBackendUrl });
    }

    // 切换数据源时重置拉取状态
    setHasFetched(false);
    setFetchingVars(false);
    setVarFetchMsg(null);
  };


  // 手动重新拉取变量列表（不重新连接）
  const handleRefreshVariables = () => {
    if (!dataBridge) return;
    setHasFetched(false);
    setFetchingVars(true);
    setVarFetchMsg(null);
    dataBridge
      .fetchVariablesFromBackend(ioBackendApiUrlRef.current)
      .then((count) => {
        setFetchingVars(false);
        setVarFetchMsg("已导入 " + count + " 个变量");
      })
      .catch((err) => {
        setFetchingVars(false);
        setVarFetchMsg("拉取失败: " + (err.message ?? "未知错误"));
      });
  };

  const handleConnect = () => {
    if (simRunning) toggleSimulation();

    // 断开旧连接
    dataBridge?.stop();

    // 配置 WebSocket URL
    if (activeSource === "io_backend") {
      dataBridge?.wsClient.updateConfig({ url: ioBackendUrl });
      setWsConfig({ url: ioBackendUrl });
    } else if (activeSource === "websocket") {
      dataBridge?.wsClient.updateConfig({ url: wsUrl });
      setWsConfig({ url: wsUrl });
    }

    // 重置拉取状态
    setHasFetched(false);
    setFetchingVars(false);
    setVarFetchMsg(null);

    // 建立连接
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
            {
              key: "io_backend" as ActiveSource,
              label: "IO 后端",
              desc: "连接 Rust WASM 协议后端（Modbus/OPC/IEC104）",
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

      {/* IO 后端配置 */}
      {activeSource === "io_backend" && (
        <div className="conn-section">
          <div className="conn-section-title">IO 后端配置</div>
          <div className="prop-group">
            <label>WebSocket 地址</label>
            <input
              value={ioBackendUrl}
              onChange={(e) => setIoBackendUrl(e.target.value)}
              placeholder="ws://localhost:8080/iscs/data"
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
            Rust 后端服务默认监听 ws://localhost:8080/iscs/data
          </div>
          <div className="prop-group">
            <label>REST API 地址</label>
            <input
              value={ioBackendApiUrl}
              onChange={(e) => setIoBackendApiUrl(e.target.value)}
              placeholder="http://localhost:8081"
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
            连接成功后自动从此地址拉取变量列表（GET /api/points）
          </div>
          {fetchingVars && (
            <div style={{ fontSize: 12, color: "var(--warning)", marginTop: 6 }}>
              正在拉取变量列表...
            </div>
          )}
          {varFetchMsg && (
            <div style={{ fontSize: 12, color: varFetchMsg.startsWith("已导入") ? "var(--success)" : "var(--danger)", marginTop: 6 }}>
              {varFetchMsg}
            </div>
          )}
          {dataBridge?.getStatus("websocket") === "connected" && !fetchingVars && (
            <button
              className="btn btn-sm"
              style={{ marginTop: 8 }}
              onClick={handleRefreshVariables}
            >
              🔄 刷新变量列表
            </button>
          )}
        </div>
      )}

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
