import React, { useEffect } from "react";
import { useEditorStore } from "../../store/editorStore";
import { ProjectToolbar } from "./ProjectToolbar";
import { Icon, type IconName } from "../icons";
import { useTheme } from "../useTheme";
import type { ToolMode } from "../../store/editorStore";
import { GroupShape } from "../../core";

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
    previewRunning,
    togglePreview,
    projectManager,
    setLeftPanel,
    scene,
    selectedId,
    selectedPath,
    renderer,
    groupSelected,
    ungroupSelected,
    remoteUser,
    setRemoteDialog,
    zoom,
    zoomBy,
    zoomTo,
    fitPage,
  } = useEditorStore();

  // Ctrl+G / Ctrl+Shift+G 成组 / 取消成组
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelected();
        else groupSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groupSelected, ungroupSelected]);

  const selectedShape = selectedId ? scene.get(selectedId) : null;
  const childSelected = !!selectedPath && selectedPath.length > 1;
  const selectedShapes = renderer?.selectedIds
    ? Array.from(renderer.selectedIds)
        .map((id) => scene.get(id))
        .filter((sh): sh is NonNullable<typeof sh> => !!sh)
    : [];
  const canGroup =
    selectedShapes.length >= 2 && selectedShapes.every((sh) => !sh.locked);
  const canUngroup =
    !!selectedShape &&
    selectedShape instanceof GroupShape &&
    !selectedShape.locked &&
    (!selectedPath || selectedPath.length === 1);

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

      {/* 成组 / 取消成组 */}
      <div className="toolbar-group">
        <button
          className="tool-btn"
          title="成组 (Ctrl+G)"
          disabled={!canGroup}
          onClick={groupSelected}
        >
          <Icon name="group" className="tool-icon" />
          <span className="tool-label">成组</span>
        </button>
        <button
          className="tool-btn"
          title="取消成组 (Ctrl+Shift+G)"
          disabled={!canUngroup}
          onClick={ungroupSelected}
        >
          <Icon name="ungroup" className="tool-icon" />
          <span className="tool-label">拆组</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* 工程工具栏 */}
      <ProjectToolbar />

      <div className="toolbar-divider" />

      {/* 视图缩放 */}
      <div className="toolbar-group">
        <button
          className="tool-btn"
          title="缩小"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <span className="tool-label zoom-glyph">−</span>
        </button>
        <button
          className="tool-btn zoom-value"
          title="恢复到 100%"
          onClick={() => zoomTo(1)}
        >
          <span className="tool-label">{Math.round(zoom * 100)}%</span>
        </button>
        <button className="tool-btn" title="放大" onClick={() => zoomBy(1.2)}>
          <span className="tool-label zoom-glyph">+</span>
        </button>
        <button className="tool-btn" title="适应页面" onClick={fitPage}>
          <Icon name="expand" className="tool-icon" />
          <span className="tool-label">适应</span>
        </button>
      </div>

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
          title={childSelected ? "子图元不支持复制" : "复制 (Ctrl+C)"}
          onClick={copySelected}
          disabled={childSelected}
        >
          <Icon name="copy" className="tool-icon" />
          <span className="tool-label">复制</span>
        </button>
        <button
          className="tool-btn"
          title={childSelected ? "子图元不支持粘贴" : "粘贴 (Ctrl+V)"}
          onClick={pasteClipboard}
          disabled={childSelected}
        >
          <Icon name="paste" className="tool-icon" />
          <span className="tool-label">粘贴</span>
        </button>
        <button
          className="tool-btn"
          title={childSelected ? "子图元不允许删除" : "删除 (Delete)"}
          onClick={deleteSelected}
          disabled={childSelected}
        >
          <Icon name="trash" className="tool-icon" />
          <span className="tool-label">删除</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* 工程名与修改状态 */}
      <div
        className="toolbar-project-name"
        onClick={() => setLeftPanel("pages")}
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
        <button
          className={"tool-btn" + (previewRunning ? " active" : "")}
          title={previewRunning ? "停止预览动画" : "预览单页动画"}
          onClick={togglePreview}
        >
          <Icon name="eye" className="tool-icon" />
          <span className="tool-label">
            {previewRunning ? "停预览" : "预览"}
          </span>
        </button>
        <div className="toolbar-divider" />
        <button
          className="tool-btn"
          title={
            remoteUser
              ? `后端账号：${remoteUser.username}（${remoteUser.role}）`
              : "登录后端（用于工程同步）"
          }
          onClick={() => setRemoteDialog("auth")}
        >
          <Icon name="lock" className="tool-icon" />
          <span className="tool-label">
            {remoteUser ? remoteUser.username : "登录"}
          </span>
        </button>
      </div>
    </div>
  );
}
