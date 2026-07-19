import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { ProjectToolbar } from "./ProjectToolbar";
import type { ToolMode } from "../../store/editorStore";

const tools: { mode: ToolMode; label: string; icon: string }[] = [
  { mode: "select", label: "选择", icon: "↖" },
  { mode: "rect", label: "矩形", icon: "▬" },
  { mode: "circle", label: "圆形", icon: "●" },
  { mode: "line", label: "直线", icon: "╱" },
  { mode: "text", label: "文本", icon: "T" },
];

export function Toolbar() {
  const {
    mode,
    setMode,
    deleteSelected,
    copySelected,
    pasteClipboard,
    simRunning,
    toggleSimulation,
    projectManager,
    setRightPanel,
  } = useEditorStore();

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {tools.map((t) => (
          <button
            key={t.mode}
            className={"tool-btn" + (mode === t.mode ? " active" : "")}
            title={t.label}
            onClick={() => setMode(t.mode)}
          >
            <span className="tool-icon">{t.icon}</span>
            <span className="tool-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      {/* 工程工具栏 */}
      <ProjectToolbar />

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          className="tool-btn"
          title="复制 (Ctrl+C)"
          onClick={copySelected}
        >
          <span className="tool-icon">📋</span>
          <span className="tool-label">复制</span>
        </button>
        <button
          className="tool-btn"
          title="粘贴 (Ctrl+V)"
          onClick={pasteClipboard}
        >
          <span className="tool-icon">📌</span>
          <span className="tool-label">粘贴</span>
        </button>
        <button
          className="tool-btn"
          title="删除 (Delete)"
          onClick={deleteSelected}
        >
          <span className="tool-icon">🗑</span>
          <span className="tool-label">删除</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* 工程名与修改状态 */}
      <div
        className="toolbar-project-name"
        onClick={() => setRightPanel("pages")}
      >
        <span className="toolbar-project-icon">🏗</span>
        <span>{projectManager?.meta?.name ?? "未命名"}</span>
        {projectManager?.dirty && <span className="toolbar-dirty">*</span>}
      </div>

      <div style={{ flex: 1 }} />

      <div className="toolbar-group">
        <button
          className={"tool-btn" + (simRunning ? " active" : "")}
          title={simRunning ? "停止模拟" : "启动模拟"}
          onClick={toggleSimulation}
        >
          <span className="tool-icon">{simRunning ? "⏹" : "▶"}</span>
          <span className="tool-label">{simRunning ? "停止" : "模拟"}</span>
        </button>
      </div>
    </div>
  );
}
