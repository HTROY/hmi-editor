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
import { useEditorStore } from "./store/editorStore";
import "./App.css";

const PanelIcon: Record<string, string> = {
  properties: "\u{1F4CB}",
  bindings: "\u{1F517}",
  variables: "\u{1F4CA}",
  connections: "\u{1F310}",
  pages: "\u{1F4C4}",
  alarm: "\u{1F6A8}",
  trend: "\u{1F4C8}",
  auth: "\u{1F512}",
  script: "\u{2328}\u{FE0F}",
  report: "\u{1F4CA}",
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
  // 记录已访问过的面板：首次访问后保持挂载（切走时隐藏而非卸载），
  // 避免切回面板时本地状态全部重置
  const [visitedPanels, setVisitedPanels] = useState<Set<string>>(
    () => new Set([rp]),
  );

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        {showLib ? (
          <div className="left-sidebar slide-in">
            <div className="left-sidebar-header">
              <span>{PanelIcon.properties} 图元库</span>
              <button className="btn-icon" title="收起" onClick={() => setShowLib(false)}>
                ✕
              </button>
            </div>
            <ShapeLibrary />
          </div>
        ) : (
          <button className="show-lib-btn fade-in" title="展开图元库" onClick={() => setShowLib(true)}>
            📦
          </button>
        )}

        <div className="canvas-area">
          <EditorCanvas />
        </div>

        <div className="right-panel">
          <div className="panel-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`panel-tab${rp === t.key ? " active" : ""}`}
                onClick={() => {
                  setRp(t.key);
                  setVisitedPanels((prev) =>
                    prev.has(t.key) ? prev : new Set(prev).add(t.key),
                  );
                }}
                title={t.label}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="panel fade-in">
            {TABS.map((t) =>
              visitedPanels.has(t.key) ? (
                <div
                  key={t.key}
                  style={{ display: rp === t.key ? undefined : "none" }}
                >
                  {PANELS[t.key]}
                </div>
              ) : null,
            )}
            {!visitedPanels.has(rp) && (
              <div className="panel-hint">← 选择上方面板查看内容</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
