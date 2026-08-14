import React, { useState } from "react";
import { useEffect } from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  RESOLUTION_PRESETS,
  findResolutionPreset,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_BACKGROUND,
  sanitizePageBackground,
  getOutOfBoundsShapes,
} from "../../core";

// ============================================================
// PagePanel — 页面管理面板
// 多页面切换、增删改、排序
// ============================================================
import { Icon } from "../icons";

export function PagePanel() {
  const {
    projectManager,
    activePageId,
    scene,
    switchPage,
    addPage,
    deletePage,
    renamePage,
    movePage,
    setPageResolution,
    setPageBackground,
    scaleShapesToResolution,
  } = useEditorStore();
  const pages = projectManager?.getPages() ?? [];
  // 页面元数据与越界清单都是派生值：唯一事实来源是 projectManager
  // （整库订阅保证 pageRevision/shapeRevision 变化时重新派生）
  const meta = projectManager?.getPageMeta(activePageId);
  const pageWidth = meta?.width ?? 0;
  const pageHeight = meta?.height ?? 0;
  const pageBackground = meta?.background ?? DEFAULT_PAGE_BACKGROUND;
  const outOfBounds = getOutOfBoundsShapes(scene, pageWidth, pageHeight);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [resW, setResW] = useState(pageWidth);
  const [resH, setResH] = useState(pageHeight);
  const [bgDraft, setBgDraft] = useState(pageBackground);

  useEffect(() => {
    setResW(pageWidth);
    setResH(pageHeight);
  }, [pageWidth, pageHeight]);

  useEffect(() => {
    setBgDraft(pageBackground);
  }, [pageBackground]);

  const applyBackground = (value: string) => {
    const color = sanitizePageBackground(value);
    setBgDraft(color);
    setPageBackground(activePageId, color);
  };

  const activePreset = findResolutionPreset(resW, resH)?.label ?? "__custom__";

  const handleRename = (pageId: string) => {
    if (editText.trim()) {
      renamePage(pageId, editText.trim());
    }
    setEditingId(null);
  };

  const handleDelete = (pageId: string) => {
    if (pages.length <= 1) return;
    deletePage(pageId);
  };

  const handleMove = (pageId: string, direction: "up" | "down") => {
    const idx = pages.findIndex((p) => p.id === pageId);
    if (direction === "up" && idx > 0) {
      const target = pages[idx - 1];
      movePage(pageId, target.order);
    } else if (direction === "down" && idx < pages.length - 1) {
      const target = pages[idx + 1];
      movePage(pageId, target.order);
    }
  };

  return (
    <div className="panel">
      <div className="panel-title">
        页面管理
        <button className="btn btn-sm" onClick={addPage}>
          + 新建
        </button>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">当前画面分辨率</div>
        <div className="res-preset-row">
          <select
            className="res-preset-select"
            value={activePreset}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom__") return;
              const preset = RESOLUTION_PRESETS.find((p) => p.label === v);
              if (preset) {
                setResW(preset.width);
                setResH(preset.height);
              }
            }}
          >
            <option value="__custom__">自定义…</option>
            {RESOLUTION_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="res-input-row">
          <input
            type="number"
            min={MIN_PAGE_SIZE}
            max={MAX_PAGE_SIZE}
            value={resW}
            onChange={(e) => setResW(Number(e.target.value))}
          />
          <span className="res-times">×</span>
          <input
            type="number"
            min={MIN_PAGE_SIZE}
            max={MAX_PAGE_SIZE}
            value={resH}
            onChange={(e) => setResH(Number(e.target.value))}
          />
        </div>
        <div className="res-actions">
          <button
            className="btn btn-sm"
            title="仅修改分辨率，图元坐标保持不变"
            onClick={() => setPageResolution(activePageId, resW, resH)}
          >
            应用（保持坐标）
          </button>
          <button
            className="btn btn-sm"
            title="把全部图元按比例缩放到新的分辨率并应用"
            onClick={() => scaleShapesToResolution(resW, resH)}
          >
            按比例缩放图元
          </button>
        </div>
        {outOfBounds.length > 0 && (
          <div className="res-warning">
            <div className="res-warning-title">
              ⚠ {outOfBounds.length} 个图元超出页面边界
            </div>
            <ul className="res-warning-list">
              {outOfBounds.slice(0, 6).map((o) => (
                <li key={o.id}>
                  {o.name}（{Math.round(o.bbox.x)}, {Math.round(o.bbox.y)}）
                </li>
              ))}
            </ul>
            {outOfBounds.length > 6 && (
              <div className="res-warning-more">
                等 {outOfBounds.length} 个图元在页面外
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel-section">
        <div className="panel-section-title">当前画面背景</div>
        <div className="res-input-row">
          <input
            type="color"
            value={
              /^#[0-9a-fA-F]{6}$/.test(bgDraft)
                ? bgDraft
                : DEFAULT_PAGE_BACKGROUND
            }
            onChange={(e) => applyBackground(e.target.value)}
            style={{
              width: 40,
              minWidth: 40,
              flex: "0 0 auto",
              padding: 2,
              background: "var(--bg0)",
            }}
            title="选择背景色"
          />
          <input
            type="text"
            value={bgDraft}
            onChange={(e) => setBgDraft(e.target.value)}
            onBlur={() => applyBackground(bgDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyBackground(bgDraft);
              if (e.key === "Escape") setBgDraft(pageBackground);
            }}
            spellCheck={false}
            placeholder={DEFAULT_PAGE_BACKGROUND}
          />
        </div>
      </div>

      <div className="page-list">
        {pages.map((page) => {
          const isActive = page.id === activePageId;
          return (
            <div
              key={page.id}
              className={"page-item" + (isActive ? " active" : "")}
              onClick={() => switchPage(page.id)}
            >
              <div className={"page-item-icon" + (isActive ? " active" : "")}>
                <Icon name="page" size={15} />
              </div>

              <div className="page-item-info">
                {editingId === page.id ? (
                  <input
                    className="page-rename-input"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => handleRename(page.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(page.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="page-item-title">{page.title}</div>
                )}
                <div className="page-item-meta">
                  {page.width}×{page.height} · 第{page.order + 1}页
                </div>
              </div>

              <div
                className="page-item-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="btn-icon"
                  title="重命名"
                  onClick={() => {
                    setEditingId(page.id);
                    setEditText(page.title);
                  }}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  className="btn-icon"
                  title="上移"
                  onClick={() => handleMove(page.id, "up")}
                  disabled={pages.indexOf(page) === 0}
                >
                  <Icon name="up" size={12} />
                </button>
                <button
                  className="btn-icon"
                  title="下移"
                  onClick={() => handleMove(page.id, "down")}
                  disabled={pages.indexOf(page) === pages.length - 1}
                >
                  <Icon name="down" size={12} />
                </button>
                <button
                  className="btn-icon"
                  title="删除"
                  onClick={() => handleDelete(page.id)}
                  disabled={pages.length <= 1}
                  style={{
                    color:
                      pages.length <= 1 ? "var(--border)" : "var(--danger)",
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel-hint" style={{ marginTop: 8 }}>
        共 {pages.length} 个画面 · 点击切换
      </div>
    </div>
  );
}
