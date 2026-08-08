import React, { useState } from "react";
import { Toolbar } from "./editor/toolbar/Toolbar";
import { EditorCanvas } from "./editor/canvas/EditorCanvas";
import { PropertyPanel } from "./editor/panels/PropertyPanel";
import { BindingPanel } from "./editor/panels/BindingPanel";
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
import { Icon, type IconName } from "./editor/icons";
import { useEditorStore } from "./store/editorStore";
import "./App.css";

const PanelIcon: Record<string, IconName> = {
  properties: "sliders",
  bindings: "link",
  variables: "pulse",
  connections: "plug",
  pages: "page",
  alarm: "alarm",
  trend: "chart",
  auth: "lock",
  script: "code",
  report: "table",
};

const TABS = [
  { key: "properties" as const, label: "\u{5C5E}\u{6027}" },
  { key: "bindings" as const, label: "\u{7ED1}\u{5B9A}" },
  { key: "variables" as const, label: "\u{70B9}\u{8868}" },
  { key: "connections" as const, label: "\u{8FDE}\u{63A5}" },
  { key: "pages" as const, label: "\u{9875}\u{9762}" },
  { key: "alarm" as const, label: "\u{62A5}\u{8B66}" },
  { key: "trend" as const, label: "\u{8D8B}\u{52BF}" },
  { key: "auth" as const, label: "\u{6743}\u{9650}" },
  { key: "script" as const, label: "\u{811A}\u{672C}" },
  { key: "report" as const, label: "\u{62A5}\u{8868}" },
];

const PANELS: Record<string, React.ReactNode> = {
  properties: <PropertyPanel />,
  bindings: <BindingPanel />,
  variables: <VariablePanel />,
  connections: <ConnectionPanel />,
  pages: <PagePanel />,
  alarm: <AlarmPanel />,
  trend: <TrendPanel />,
  auth: <AuthPanel />,
  script: <ScriptPanel />,
  report: <ReportPanel />,
};

function App() {
  const rp = useEditorStore((s) => s.rightPanel);
  const setRp = useEditorStore((s) => s.setRightPanel);
  const [showLib, setShowLib] = useState(true);
  // 启动时恢复上次自动保存的工程（IndexedDB）
  React.useEffect(() => {
    void useEditorStore.getState().restoreSession();
  }, []);
  // 记录已访问过的面板：首次访问后保持挂载（切走时隐藏而非卸载），
  // 避免切回面板时本地状态全部重置
  const [visitedPanels, setVisitedPanels] = useState<Set<string>>(
    () => new Set([rp])
  );

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        {showLib ? (
          <div className="left-sidebar slide-in">
            <div className="left-sidebar-header">
              <span className="lib-header">
                <Icon name="library" size={13} />
                <span>图元库</span>
                <span className="lib-code">LIB</span>
              </span>
              <button
                className="btn-icon"
                title="收起"
                onClick={() => setShowLib(false)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
            <ShapeLibrary />
          </div>
        ) : (
          <button
            className="show-lib-btn fade-in"
            title="展开图元库"
            onClick={() => setShowLib(true)}
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

        <div className="right-panel">
          <div className="right-panel-header">
            <span className="rp-code">INSP</span>
            <span className="rp-icon">
              <Icon name={PanelIcon[rp]} size={13} />
            </span>
            <span className="rp-title">
              {TABS.find((t) => t.key === rp)?.label ?? ""}
            </span>
          </div>
          <div className="panel-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`panel-tab${rp === t.key ? " active" : ""}`}
                onClick={() => {
                  setRp(t.key);
                  setVisitedPanels((prev) =>
                    prev.has(t.key) ? prev : new Set(prev).add(t.key)
                  );
                }}
                title={t.label}
              >
                <Icon name={PanelIcon[t.key]} size={15} />
              </button>
            ))}
          </div>
          <div className="panel fade-in">
            {TABS.map((t) =>
              visitedPanels.has(t.key) ? (
                <div
                  key={t.key}
                  className="panel-host"
                  style={{ display: rp === t.key ? undefined : "none" }}
                >
                  {PANELS[t.key]}
                </div>
              ) : null
            )}
            {!visitedPanels.has(rp) && (
              <div className="panel-hint">← 选择上方面板查看内容</div>
            )}
          </div>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

export default App;
