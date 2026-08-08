import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { ProjectToolbar } from "./ProjectToolbar";
import { Icon, type IconName } from "../icons";
import { useTheme } from "../useTheme";
import type { ToolMode } from "../../store/editorStore";

const tools: { mode: ToolMode; label: string; icon: IconName }[] = [
  { mode: "select", label: "选择", icon: "cursor" },
  { mode: "rect", label: "矩形", icon: "rect" },
  { mode: "circle", label: "圆形", icon: "circle" },
  { mode: "line", label: "直线", icon: "line" },
  { mode: "text", label: "文本", icon: "text" },
];

export function Toolbar() {
  const { theme, toggleTheme } = useTheme();
  const {
    mode,
    setMode,
    deleteSelected,
    copySelected,
    pasteClipboard,
    undo,
    redo,
    history,
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
            <Icon name={t.icon} className="tool-icon" />
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
          title="撤销 (Ctrl+Z)"
          onClick={undo}
          disabled={!history?.canUndo}
        >
          <Icon name="undo" className="tool-icon" />
          <span className="tool-label">撤销</span>
        </button>
        <button
          className="tool-btn"
          title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
          onClick={redo}
          disabled={!history?.canRedo}
        >
          <Icon name="redo" className="tool-icon" />
          <span className="tool-label">重做</span>
        </button>
        <button
          className="tool-btn"
          title="复制 (Ctrl+C)"
          onClick={copySelected}
        >
          <Icon name="copy" className="tool-icon" />
          <span className="tool-label">复制</span>
        </button>
        <button
          className="tool-btn"
          title="粘贴 (Ctrl+V)"
          onClick={pasteClipboard}
        >
          <Icon name="paste" className="tool-icon" />
          <span className="tool-label">粘贴</span>
        </button>
        <button
          className="tool-btn"
          title="删除 (Delete)"
          onClick={deleteSelected}
        >
          <Icon name="trash" className="tool-icon" />
          <span className="tool-label">删除</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* 工程名与修改状态 */}
      <div
        className="toolbar-project-name"
        onClick={() => setRightPanel("pages")}
      >
        <span className="toolbar-project-icon">
          <Icon name="project" size={14} />
        </span>
        <span>{projectManager?.meta?.name ?? "未命名"}</span>
        {projectManager?.dirty && <span className="toolbar-dirty">*</span>}
      </div>

      <div style={{ flex: 1 }} />

      <div className="toolbar-group">
        <button
          className="tool-btn"
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          <Icon
            name={theme === "dark" ? "sun" : "moon"}
            className="tool-icon"
          />
          <span className="tool-label">
            {theme === "dark" ? "浅色" : "深色"}
          </span>
        </button>
        <div className="toolbar-divider" />
        <button
          className={"tool-btn" + (simRunning ? " active" : "")}
          title={simRunning ? "停止模拟" : "启动模拟"}
          onClick={toggleSimulation}
        >
          <Icon name={simRunning ? "stop" : "play"} className="tool-icon" />
          <span className="tool-label">{simRunning ? "停止" : "模拟"}</span>
        </button>
      </div>
    </div>
  );
}
