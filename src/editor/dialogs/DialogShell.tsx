import React from "react";
import { Icon } from "../icons";

// ============================================================
// DialogShell — 统一模态弹窗外壳
// ============================================================

export function DialogShell({
  title,
  onClose,
  children,
  width,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="btn-icon" title="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
