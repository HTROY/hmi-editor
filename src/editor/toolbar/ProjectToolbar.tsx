import React, { useRef } from "react";
import { useEditorStore } from "../../store/editorStore";
import { isProjectPackageFile } from "../../core";

// ============================================================
// ProjectToolbar — 工程操作（新建/保存/打开/导出/工程属性）
// ============================================================
import { Icon } from "../icons";

export function ProjectToolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const svgInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const {
    projectManager,
    newProject,
    saveProject,
    openProject,
    exportScene,
    exportProjectPackage,
    importScene,
    importSvgFile,
    importRasterFile,
    remoteAuth,
    remoteBusy,
    setRemoteDialog,
    syncToBackend,
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

  const handleSvgFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importSvgFile(file);
    e.target.value = "";
  };

  const handleImageFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importRasterFile(file);
    e.target.value = "";
  };

  const handleRemoteOpen = () => {
    if (!remoteAuth.isLoggedIn) {
      setRemoteDialog("auth");
    } else {
      setRemoteDialog("projects");
    }
  };

  const dirty = projectManager?.dirty ?? false;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".hmi.json,.hmi.zip,.json,.zip"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />
      <input
        ref={svgInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        style={{ display: "none" }}
        onChange={handleSvgFileSelected}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,image/png,image/jpeg"
        style={{ display: "none" }}
        onChange={handleImageFileSelected}
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
        title="同步到后端（需登录）"
        onClick={() => void syncToBackend()}
        disabled={remoteBusy}
      >
        <Icon name="up" className="tool-icon" />
        <span className="tool-label">{remoteBusy ? "同步中" : "同步"}</span>
      </button>

      <button
        className="tool-btn"
        title="从后端打开工程（需登录）"
        onClick={handleRemoteOpen}
        disabled={remoteBusy}
      >
        <Icon name="folder" className="tool-icon" />
        <span className="tool-label">远端</span>
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
        title="导出 .hmi.zip 工程包（含资源）"
        onClick={exportProjectPackage}
      >
        <Icon name="export" className="tool-icon" />
        <span className="tool-label">导出包</span>
      </button>

      <button
        className="tool-btn"
        title="导入工程（.hmi.zip / .hmi.json）"
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".hmi.json,.hmi.zip,.json,.zip";
          input.onchange = (e: any) => {
            const file = e.target?.files?.[0];
            if (!file) return;
            if (isProjectPackageFile(file)) {
              openProject(file);
              return;
            }
            const reader = new FileReader();
            reader.onload = () => importScene(reader.result as string);
            reader.readAsText(file);
          };
          input.click();
        }}
      >
        <Icon name="import" className="tool-icon" />
        <span className="tool-label">导入</span>
      </button>

      <button
        className="tool-btn"
        title="导入 SVG 矢量图（也可拖放 .svg 文件到画布）"
        onClick={() => svgInputRef.current?.click()}
      >
        <Icon name="import" className="tool-icon" />
        <span className="tool-label">导入SVG</span>
      </button>

      <button
        className="tool-btn"
        title="导入 PNG/JPG 图片（1:1 插入，也可拖放图片文件到画布）"
        onClick={() => imageInputRef.current?.click()}
      >
        <Icon name="import" className="tool-icon" />
        <span className="tool-label">导入图片</span>
      </button>
    </>
  );
}
