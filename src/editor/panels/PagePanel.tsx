import React, { useState } from "react";
import { useEditorStore } from "../../store/editorStore";

// ============================================================
// PagePanel — 页面管理面板
// 多页面切换、增删改、排序
// ============================================================
import { Icon } from "../icons";

export function PagePanel() {
  const {
    projectManager,
    activePageId,
    switchPage,
    addPage,
    deletePage,
    renamePage,
  } = useEditorStore();
  const pages = projectManager?.getPages() ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

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
      projectManager?.movePage(pageId, target.order);
    } else if (direction === "down" && idx < pages.length - 1) {
      const target = pages[idx + 1];
      projectManager?.movePage(pageId, target.order);
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
