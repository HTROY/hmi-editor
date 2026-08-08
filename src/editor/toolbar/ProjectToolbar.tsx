import React, { useRef } from "react";
import { useEditorStore } from "../../store/editorStore";

// ============================================================
// ProjectToolbar — 工程操作（新建/保存/打开/导出/工程属性）
// ============================================================
import { Icon } from "../icons";

export function ProjectToolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    projectManager,
    newProject,
    saveProject,
    openProject,
    exportScene,
    importScene,
    pageTitle,
  } = useEditorStore();

  const handleOpenClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    openProject(file);
    e.target.value = "";
  };

  const dirty = projectManager?.dirty ?? false;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".hmi.json,.json"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />

      <button className="tool-btn" title="新建工程" onClick={newProject}>
        <Icon name="file-new" className="tool-icon" />
        <span className="tool-label">新建</span>
      </button>

      <button className="tool-btn" title="打开工程" onClick={handleOpenClick}>
        <Icon name="folder" className="tool-icon" />
        <span className="tool-label">打开</span>
      </button>

      <button
        className="tool-btn"
        title={dirty ? "保存 (有未保存修改)" : "保存"}
        onClick={saveProject}
      >
        <Icon name="save" className="tool-icon" />
        <span className="tool-label">保存</span>
        {dirty && <span className="tool-dot" />}
      </button>

      <button
        className="tool-btn"
        title="导出画面为 JSON"
        onClick={exportScene}
      >
        <Icon name="export" className="tool-icon" />
        <span className="tool-label">导出</span>
      </button>

      <button
        className="tool-btn"
        title="导入画面 JSON"
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".hmi.json,.json";
          input.onchange = (e: any) => {
            const file = e.target?.files?.[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = () => importScene(reader.result as string);
              reader.readAsText(file);
            }
          };
          input.click();
        }}
      >
        <Icon name="import" className="tool-icon" />
        <span className="tool-label">导入</span>
      </button>
    </>
  );
}
