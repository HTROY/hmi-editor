import React, { useEffect, useRef, useState } from "react";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { EditorCanvas } from "./editor/canvas/EditorCanvas";
import { InspectorPanel } from "./editor/inspector/InspectorPanel";
import { VariablePanel } from "./editor/panels/VariablePanel";
import { ConnectionPanel } from "./editor/panels/ConnectionPanel";
import { PagePanel } from "./editor/panels/PagePanel";
import { AlarmPanel } from "./editor/panels/alarm/AlarmPanel";
import { TrendPanel } from "./editor/panels/alarm/TrendPanel";
import { AuthPanel } from "./editor/panels/alarm/AuthPanel";
import { ScriptPanel } from "./editor/panels/script/ScriptPanel";
import { ReportPanel } from "./editor/panels/script/ReportPanel";
import { ShapeLibrary } from "./editor/panels/ShapeLibrary";
import { StatusBar } from "./editor/StatusBar";
import { SyncDialogs } from "./editor/dialogs/SyncDialogs";
import { Icon, type IconName } from "./editor/icons";
import { useEditorStore, type LeftPanel } from "./store/editorStore";
// 样式按域拆分（tokens → base → 布局 → 面板），导入顺序即层叠顺序，勿随意调整
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/toolbar.css";
import "./styles/panels/sidebar.css";
import "./styles/canvas.css";
import "./styles/panels/right-panel.css";
import "./styles/statusbar.css";
import "./styles/controls.css";
import "./styles/panels/variables.css";
import "./styles/panels/binding.css";
import "./styles/panels/connections.css";
import "./styles/panels/alarm.css";
import "./styles/panels/auth.css";
import "./styles/panels/trend.css";
import "./styles/panels/pages.css";
import "./styles/panels/script.css";
import "./styles/utilities.css";
import "./styles/dialogs.css";
import "./styles/panels/props.css";
import "./editor/inspector/inspector.css";

const LEFT_TABS: { key: LeftPanel; label: string; icon: IconName }[] = [
  { key: "library", label: "图元库", icon: "library" },
  { key: "variables", label: "点表", icon: "pulse" },
  { key: "connections", label: "连接", icon: "plug" },
  { key: "pages", label: "页面", icon: "page" },
  { key: "alarm", label: "报警", icon: "alarm" },
  { key: "trend", label: "趋势", icon: "chart" },
  { key: "auth", label: "权限", icon: "lock" },
  { key: "script", label: "脚本", icon: "code" },
  { key: "report", label: "报表", icon: "table" },
];

const PANELS: Record<LeftPanel, React.ReactNode> = {
  library: <ShapeLibrary />,
  variables: <VariablePanel />,
  connections: <ConnectionPanel />,
  pages: <PagePanel />,
  alarm: <AlarmPanel />,
  trend: <TrendPanel />,
  auth: <AuthPanel />,
  script: <ScriptPanel />,
  report: <ReportPanel />,
};

const LEFT_W_KEY = "hmi.leftPanelWidth";
const RIGHT_W_KEY = "hmi.rightPanelWidth";
const DEFAULT_LEFT_W = 280;
const DEFAULT_RIGHT_W = 324;

function loadWidth(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function App() {
  const lp = useEditorStore((s) => s.leftPanel);
  const setLp = useEditorStore((s) => s.setLeftPanel);
  const [showLeft, setShowLeft] = useState(true);
  const [leftW, setLeftW] = useState(() =>
    loadWidth(LEFT_W_KEY, DEFAULT_LEFT_W)
  );
  const [rightW, setRightW] = useState(() =>
    loadWidth(RIGHT_W_KEY, DEFAULT_RIGHT_W)
  );
  const [visited, setVisited] = useState<Set<LeftPanel>>(() => new Set([lp]));
  const drag = useRef<{
    kind: "left" | "right";
    startX: number;
    startW: number;
  } | null>(null);

  // 启动时恢复上次自动保存的工程（IndexedDB）
  useEffect(() => {
    void useEditorStore.getState().restoreSession();
    void useEditorStore.getState().initRemoteAuth();
  }, []);

  // 左右栏宽度拖拽 + localStorage 记忆
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const { kind, startX, startW } = drag.current;
      if (kind === "left") {
        setLeftW(Math.min(480, Math.max(208, startW + (e.clientX - startX))));
      } else {
        setRightW(Math.min(560, Math.max(260, startW - (e.clientX - startX))));
      }
    };
    const onUp = () => {
      if (!drag.current) return;
      const kind = drag.current.kind;
      drag.current = null;
      document.body.classList.remove("resizing-h");
      const w = kind === "left" ? leftW : rightW;
      try {
        localStorage.setItem(
          kind === "left" ? LEFT_W_KEY : RIGHT_W_KEY,
          String(w)
        );
      } catch {
        // localStorage 不可用时仅会话内生效
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftW, rightW]);

  const startDrag = (kind: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = {
      kind,
      startX: e.clientX,
      startW: kind === "left" ? leftW : rightW,
    };
    document.body.classList.add("resizing-h");
  };

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        {showLeft ? (
          <>
            <div
              className="left-sidebar"
              style={{ width: leftW, minWidth: leftW }}
            >
              <div className="left-sidebar-header">
                <span className="lib-header">
                  <Icon
                    name={LEFT_TABS.find((t) => t.key === lp)!.icon}
                    size={13}
                  />
                  <span>{LEFT_TABS.find((t) => t.key === lp)!.label}</span>
                  <span className="lib-code">ENG</span>
                </span>
                <button
                  className="btn-icon"
                  title="收起"
                  onClick={() => setShowLeft(false)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              <div className="left-tabs">
                {LEFT_TABS.map((t) => (
                  <button
                    key={t.key}
                    className={`left-tab${lp === t.key ? " active" : ""}`}
                    title={t.label}
                    onClick={() => {
                      setLp(t.key);
                      setVisited((prev) =>
                        prev.has(t.key) ? prev : new Set(prev).add(t.key)
                      );
                    }}
                  >
                    <Icon name={t.icon} size={15} />
                  </button>
                ))}
              </div>
              <div className="panel fade-in">
                {LEFT_TABS.map((t) =>
                  visited.has(t.key) ? (
                    <div
                      key={t.key}
                      className="panel-host"
                      style={{ display: lp === t.key ? undefined : "none" }}
                    >
                      {PANELS[t.key]}
                    </div>
                  ) : null
                )}
              </div>
            </div>
            <div
              className="sidebar-divider"
              title="拖拽调整左栏宽度"
              onMouseDown={startDrag("left")}
            />
          </>
        ) : (
          <button
            className="show-lib-btn fade-in"
            title="展开工程面板"
            onClick={() => setShowLeft(true)}
          >
            <Icon name="library" size={16} />
          </button>
        )}

        <div className="canvas-area">
          <EditorCanvas />
          <div className="canvas-frame" aria-hidden="true">
            <span className="frame-corner tl" />
            <span className="frame-corner tr" />
            <span className="frame-corner bl" />
            <span className="frame-corner br" />
            <span className="frame-tag">CAN · 画面编辑</span>
          </div>
        </div>

        <div
          className="sidebar-divider"
          title="拖拽调整右栏宽度"
          onMouseDown={startDrag("right")}
        />
        <div
          className="right-panel"
          style={{ width: rightW, minWidth: rightW }}
        >
          <div className="right-panel-header">
            <span className="rp-code">INSP</span>
            <span className="rp-icon">
              <Icon name="sliders" size={13} />
            </span>
            <span className="rp-title">检查器</span>
          </div>
          <InspectorPanel />
        </div>
      </div>
      <StatusBar />
      <SyncDialogs />
    </div>
  );
}

export default App;
