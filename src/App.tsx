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

const TABS = [
  { key: "properties" as const, label: "属性" },
  { key: "bindings" as const, label: "绑定" },
  { key: "variables" as const, label: "点表" },
  { key: "connections" as const, label: "连接" },
  { key: "pages" as const, label: "页面" },
  { key: "alarm" as const, label: "报警" },
  { key: "trend" as const, label: "趋势" },
  { key: "auth" as const, label: "权限" },
  { key: "script" as const, label: "脚本" },
  { key: "report" as const, label: "报表" },
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
  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        {showLib ? (
          <div className="left-sidebar">
            <div className="left-sidebar-header">
              <span>图元库</span>
              <button className="btn-icon" onClick={() => setShowLib(false)}>
                ✕
              </button>
            </div>
            <ShapeLibrary />
          </div>
        ) : (
          <button className="show-lib-btn" onClick={() => setShowLib(true)}>
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
                className={"panel-tab" + (rp === t.key ? " active" : "")}
                onClick={() => setRp(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {PANELS[rp] ?? (
            <div className="panel">
              <div className="panel-hint">选择面板</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export default App;
