import React, { useEffect, useState } from "react";
import { useEditorStore } from "../store/editorStore";

const MODE_LABEL: Record<string, string> = {
  select: "选择",
  rect: "矩形",
  circle: "圆形",
  line: "直线",
  text: "文本",
};

const SOURCE_LABEL: Record<string, string> = {
  simulation: "内置模拟",
  iec104: "IEC 104",
  websocket: "WebSocket",
  io_backend: "IO 后端",
};

function pad(n: number, len = 2) {
  return String(n).padStart(len, "0");
}

function formatClock(d: Date) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function StatusBar() {
  const {
    projectManager,
    activePageId,
    simRunning,
    mode,
    scene,
    dataBridge,
    alarmManager,
  } = useEditorStore();
  // 页面元数据为派生值：唯一事实来源是 projectManager
  const meta = projectManager?.getPageMeta(activePageId);
  // 订阅形状/报警变化，让图元计数与未确认数实时刷新
  useEditorStore((s) => s.shapeRevision);
  const [now, setNow] = useState(() => new Date());
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [linkStatus, setLinkStatus] = useState<string>(
    dataBridge?.getStatus("websocket") ?? "disconnected"
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    const unsub = dataBridge?.onStatus((source, status) => {
      if (source === "websocket" || source === "iec104") setLinkStatus(status);
    });
    const onMove = (e: MouseEvent) => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      setCursor({
        x: Math.round(e.clientX - rect.left),
        y: Math.round(e.clientY - rect.top),
      });
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.clearInterval(timer);
      unsub?.();
      window.removeEventListener("mousemove", onMove);
    };
  }, [dataBridge]);

  const linkOk =
    simRunning ||
    linkStatus === "connected" ||
    (dataBridge?.active === "simulation" && simRunning);
  const linkBusy = linkStatus === "connecting";
  const linkErr = linkStatus === "error";
  const ledClass = linkErr ? "err" : linkBusy ? "busy" : linkOk ? "ok" : "off";
  const unackCount = alarmManager?.unacknowledgedCount ?? 0;
  const shapeCount = scene?.getAll().length ?? 0;
  const projectName = projectManager?.meta?.name ?? "未命名工程";
  const modeLabel = MODE_LABEL[mode] ?? mode;
  const sourceLabel = SOURCE_LABEL[dataBridge?.active ?? "simulation"] ?? "—";

  return (
    <div className="status-bar">
      <span className="sb-seg">
        <span className="sb-label">SYS</span>
        <span className={"sb-led " + ledClass} />
        <span className="sb-value">{sourceLabel}</span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg sb-grow">
        <span className="sb-label">PRJ</span>
        <span className="sb-value" title={projectName}>
          {projectName}
        </span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg">
        <span className="sb-label">PAGE</span>
        <span className="sb-value">{meta?.title}</span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg">
        <span className="sb-label">SHAPE</span>
        <span className="sb-value sb-mono">{shapeCount}</span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg">
        <span className="sb-label">CANVAS</span>
        <span className="sb-value sb-mono">
          {meta?.width} × {meta?.height}
        </span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg">
        <span className="sb-label">MODE</span>
        <span className="sb-value">{modeLabel}</span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg">
        <span className="sb-label">ALM</span>
        <span
          className={"sb-value sb-mono" + (unackCount > 0 ? " sb-alarm" : "")}
        >
          {unackCount}
        </span>
      </span>
      <span className="sb-flex" />
      <span className="sb-seg">
        <span className="sb-label">XY</span>
        <span className="sb-value sb-mono">
          {cursor.x},{cursor.y}
        </span>
      </span>
      <span className="sb-sep" />
      <span className="sb-seg">
        <span className="sb-label">SIM</span>
        <span className={"sb-value" + (simRunning ? " sb-amber" : "")}>
          {simRunning ? "运行" : "停止"}
        </span>
      </span>
      <span className="sb-sep" />
      <span className="sb-clock sb-mono">{formatClock(now)}</span>
    </div>
  );
}
